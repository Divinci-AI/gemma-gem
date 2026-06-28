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
