/**
 * Open programmatic API E2E — exercises the `window.divinci` surface that ANY
 * website can use (the content-script MAIN-world bridge), as opposed to the
 * externally_connectable path (smoke spec, first-party origins only).
 *
 * Served from 127.0.0.1:<PORT>, which is NOT in externally_connectable.matches
 * — so anything that works here proves the open content-script path, not the
 * allowlisted port path. 127.0.0.1 is a secure origin (loopback), matching the
 * consent core's isSecureOrigin gate.
 *
 * No model load (fast, no WebGPU): covers injection, ping, the A2A card,
 * consent-banner triggering, and grant enforcement. Real inference is out of
 * scope (extension-inference.spec.ts).
 */

import { chromium, expect, test, type BrowserContext } from '@playwright/test'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const PORT = 9137
const ORIGIN = `http://127.0.0.1:${PORT}`

let server: http.Server

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`Extension build not found at ${EXTENSION_PATH}. Run \`pnpm build\` first.`)
  }
  server = await new Promise<http.Server>((res, rej) => {
    const s = http.createServer((_req, _res) => {
      _res.setHeader('Content-Type', 'text/html; charset=utf-8')
      _res.end('<!doctype html><html><head><title>open-api</title></head><body>open-api test</body></html>')
    })
    s.on('error', rej)
    s.listen(PORT, '127.0.0.1', () => res(s))
  })
})

test.afterAll(async () => {
  await new Promise<void>((res) => server?.close(() => res()))
})

async function launch(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  })
  if (!context.serviceWorkers()[0]) {
    await context.waitForEvent('serviceworker', { timeout: 10_000 })
  }
  return context
}

test('window.divinci is injected on a non-externally_connectable origin and ping works', async () => {
  const context = await launch()
  try {
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    // MAIN-world content script defines window.divinci at document_start.
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    const pong = await page.evaluate(() =>
      (window as unknown as { divinci: { ping(): Promise<{ extensionVersion: string; supportedModels: string[] }> } }).divinci.ping(),
    )
    expect(typeof pong.extensionVersion).toBe('string')
    expect(pong.supportedModels).toContain('gemma-4-e2b')
  } finally {
    await context.close()
  }
})

test('agentCard() returns the unsigned local A2A card without a grant', async () => {
  const context = await launch()
  try {
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    const card = await page.evaluate(() =>
      (window as unknown as { divinci: { agentCard(): Promise<{ name: string; protocolVersion: string; signatures?: unknown } > } }).divinci.agentCard(),
    )
    expect(card.name).toBe('Divinci Local Agent')
    expect(typeof card.protocolVersion).toBe('string')
    expect(card.signatures).toBeUndefined() // local card is never self-signed
  } finally {
    await context.close()
  }
})

test('chat() without a grant raises the in-page consent banner', async () => {
  const context = await launch()
  try {
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    // Fire chat without awaiting — it blocks on the consent prompt (no grant yet).
    await page.evaluate(() => {
      const d = (window as unknown as { divinci: { chat(r: unknown): Promise<unknown> } }).divinci
      ;(window as unknown as { __p?: Promise<unknown> }).__p = d
        .chat({ messages: [{ role: 'user', content: 'hi' }] })
        .catch(() => {})
    })

    // The relay appends the consent banner host (light DOM; its shadow is closed).
    await page.waitForSelector('[data-divinci-consent]', { timeout: 5_000 })
    expect(await page.locator('[data-divinci-consent]').count()).toBe(1)
  } finally {
    await context.close()
  }
})

test('configure() with a pre-seeded grant stores a validated site config', async () => {
  const context = await launch()
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }))
    await sw.evaluate(
      async ([origin]) => {
        await chrome.storage.local.set({
          divinci_origin_grants: { [origin]: { origin, scopes: ['configure'], grantedAt: 1 } },
        })
      },
      [ORIGIN],
    )

    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    const applied = await page.evaluate(() =>
      (window as unknown as { divinci: { configure(c: unknown): Promise<unknown> } }).divinci.configure({
        welcomeMessage: 'Welcome to ACME',
        conversationStarters: ['Track my order', 'Returns policy'],
        systemPrompt: 'You help ACME shoppers.',
        theme: { accent: 'not-a-color' }, // dropped by validation
      }),
    )
    // Validation clamped/dropped the bad theme; the rest persisted.
    expect(applied).toMatchObject({
      welcomeMessage: 'Welcome to ACME',
      conversationStarters: ['Track my order', 'Returns policy'],
      systemPrompt: 'You help ACME shoppers.',
    })
    expect((applied as { theme?: unknown }).theme).toBeUndefined()
    expect(await page.locator('[data-divinci-consent]').count()).toBe(0) // grant present → no prompt

    // The SW persisted it per-origin under divinci_site_configs.
    const stored = await sw.evaluate(
      async ([origin]) => {
        const s = await chrome.storage.local.get('divinci_site_configs')
        return (s.divinci_site_configs as Record<string, unknown>)?.[origin]
      },
      [ORIGIN],
    )
    expect(stored).toMatchObject({ welcomeMessage: 'Welcome to ACME' })
  } finally {
    await context.close()
  }
})

test('WebMCP consumer shim lists + calls a page-declared tool', async () => {
  const context = await launch()
  try {
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    // The MAIN-world shim (divinci-webmcp-main) injects at document_start.
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    // The page declares a WebMCP tool on navigator.modelContext (MAIN world).
    // Then we drive the WEBMCP_BRIDGE_NS protocol the shim answers — list + call.
    const result = await page.evaluate(async () => {
      ;(navigator as unknown as { modelContext: unknown }).modelContext = {
        tools: [
          {
            name: 'order_status',
            description: 'Look up an order',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            execute: (input: { id: string }) => ({ status: 'shipped', id: input.id }),
          },
        ],
      }
      const NS = 'divinci-webmcp-bridge'
      function rpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
        return new Promise((resolve) => {
          const onMsg = (e: MessageEvent) => {
            const d = e.data as { __ns?: string; id?: string; op?: string }
            if (e.source === window && d?.__ns === NS && d.id === req.id && d.op !== 'list' && d.op !== 'call') {
              window.removeEventListener('message', onMsg)
              resolve(e.data)
            }
          }
          window.addEventListener('message', onMsg)
          window.postMessage({ ...req, __ns: NS }, window.location.origin)
        })
      }
      const list = await rpc({ id: 'l1', op: 'list' })
      const call = await rpc({ id: 'c1', op: 'call', name: 'order_status', input: { id: 'A1' } })
      return { list, call }
    })

    expect((result.list as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain('order_status')
    expect(result.call).toMatchObject({ op: 'call-result', ok: true, result: { status: 'shipped', id: 'A1' } })
  } finally {
    await context.close()
  }
})

test('a pre-seeded grant skips the banner (gate honors stored consent)', async () => {
  const context = await launch()
  try {
    // Seed a chat grant for this origin via the SW (the page can't do this).
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }))
    await sw.evaluate(
      async ([origin]) => {
        await chrome.storage.local.set({
          divinci_origin_grants: { [origin]: { origin, scopes: ['chat'], grantedAt: 1 } },
        })
      },
      [ORIGIN],
    )

    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`)
    await page.waitForFunction(() => !!(window as unknown as { divinci?: unknown }).divinci, { timeout: 10_000 })

    // With the grant present, chat() should NOT prompt — it forwards to the
    // offscreen, which (model not loaded in this fast suite) rejects with a
    // runtime "not loaded" error. Either way: no banner.
    const result = await page.evaluate(async () => {
      const d = (window as unknown as { divinci: { chat(r: unknown): Promise<unknown> } }).divinci
      try {
        await d.chat({ messages: [{ role: 'user', content: 'hi' }] })
        return { rejected: false, message: '' }
      } catch (e) {
        return { rejected: true, message: (e as Error).message }
      }
    })

    expect(await page.locator('[data-divinci-consent]').count()).toBe(0)
    // Consent passed → reached the model layer → "not loaded" (no model in this suite).
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/not loaded/i)
  } finally {
    await context.close()
  }
})
