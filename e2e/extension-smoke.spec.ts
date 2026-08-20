/**
 * Extension smoke test — runs the real built extension in real Chromium.
 *
 * What it verifies:
 *  1. The unpacked extension loads from `.output/chrome-mv3-dev/` without
 *     manifest errors.
 *  2. The `key` field in wxt.config.ts produces the documented stable ID
 *     `laeebjagghfeepomjhbfohefghonemeo`. This ID is hardcoded in the
 *     web app's `extension-capabilities.ts` — a regression here would
 *     silently break the picker for every user.
 *  3. The externally_connectable matches list lets a `localhost:8080`
 *     page open a connection and call `divinci:ping`.
 *  4. The bridge's one-shot ping handler returns the expected pong shape
 *     (extensionVersion + supportedModels including `gemma-4-e2b`).
 *  5. The bridge rejects connections from a disallowed origin (defense-
 *     in-depth check on top of the Chromium-enforced allowlist).
 *
 * ⚠️ The ping test binds TEST_PAGE_PORT (8080) for its probe page, which is the
 * SAME port the Divinci local dev stack serves on (docker/local.yml). With that
 * stack up, the probe page is never what loads — the real web app is — and the
 * test fails with `expect(window.__probeResult).toBeTruthy()` receiving
 * undefined, which reads as a broken externally_connectable rather than a port
 * collision. Check `lsof -nP -iTCP:8080 -sTCP:LISTEN` before believing it.
 *
 * What it does NOT verify (out of scope for smoke):
 *  - Model download + load (covered by extension-inference.spec.ts; gated
 *    behind RUN_REAL_INFERENCE=1).
 *  - Real WebGPU inference output.
 *  - Web-app UI integration (DivinciChatPanel picker behavior is unit-
 *    tested separately).
 */

import { chromium, expect, test } from '@playwright/test'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const EXPECTED_EXTENSION_ID = 'laeebjagghfeepomjhbfohefghonemeo'
const TEST_PAGE_PORT = 8080

function makeProbePage(extensionId: string): string {
  // The page calls chrome.runtime.sendMessage and stashes the result on
  // window so the test can read it back via page.evaluate. document.title
  // is also updated as a coarse readiness signal.
  return `<!doctype html>
<html><head><title>pending</title></head>
<body>
<script>
(() => {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    document.title = 'NO_CHROME_RUNTIME'
    window.__probeResult = { ok: false, reason: 'chrome.runtime.sendMessage unavailable' }
    return
  }
  chrome.runtime.sendMessage(
    ${JSON.stringify(extensionId)},
    { type: 'divinci:ping' },
    (resp) => {
      if (chrome.runtime.lastError) {
        document.title = 'PROBE_ERROR'
        window.__probeResult = { ok: false, reason: chrome.runtime.lastError.message }
      } else if (!resp) {
        document.title = 'PROBE_EMPTY'
        window.__probeResult = { ok: false, reason: 'empty response' }
      } else {
        document.title = 'PROBE_OK'
        window.__probeResult = { ok: true, response: resp }
      }
    }
  )
})()
</script>
</body></html>`
}

let server: http.Server

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(
      `Extension build not found at ${EXTENSION_PATH}. Run \`pnpm build\` first.`,
    )
  }

  // Tiny static server. The page contents are dynamic-per-extension-id but
  // for the smoke run that's fine — we always probe the canonical ID. A
  // single fixed handler keeps the setup short.
  server = await new Promise<http.Server>((res, rej) => {
    const s = http.createServer((req, _res) => {
      _res.setHeader('Content-Type', 'text/html; charset=utf-8')
      _res.end(makeProbePage(EXPECTED_EXTENSION_ID))
    })
    s.on('error', rej)
    s.listen(TEST_PAGE_PORT, '127.0.0.1', () => res(s))
  })
})

test.afterAll(async () => {
  await new Promise<void>((res) => server?.close(() => res()))
})

test('built extension loads with the documented stable ID', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  })
  try {
    // Wait for the SW or any extension page to register so we can read
    // its URL and extract the ID. serviceWorkers() is the cleanest path
    // for MV3.
    let serviceWorker = context.serviceWorkers()[0]
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }
    const swUrl = serviceWorker.url()
    const idMatch = swUrl.match(/^chrome-extension:\/\/([a-p]{32})\//)
    expect(idMatch, `unexpected SW url: ${swUrl}`).not.toBeNull()
    expect(idMatch![1]).toBe(EXPECTED_EXTENSION_ID)
  } finally {
    await context.close()
  }
})

test('divinci:ping from allowed dev origin returns a valid pong', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  })
  try {
    // Make sure the SW is up so the onMessageExternal listener is wired.
    if (!context.serviceWorkers()[0]) {
      await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }

    const page = await context.newPage()
    await page.goto(`http://localhost:${TEST_PAGE_PORT}/`)
    await page.waitForFunction(() => document.title !== 'pending', { timeout: 10_000 })

    const probe = await page.evaluate(
      () => (window as unknown as { __probeResult: unknown }).__probeResult,
    )
    expect(probe).toBeTruthy()
    expect(probe).toMatchObject({
      ok: true,
      response: {
        type: 'divinci:pong',
      },
    })
    const resp = (probe as { response: { extensionVersion: string; supportedModels: string[] } }).response
    expect(typeof resp.extensionVersion).toBe('string')
    expect(resp.extensionVersion.length).toBeGreaterThan(0)
    expect(resp.supportedModels).toContain('gemma-4-e2b')
  } finally {
    await context.close()
  }
})

test('extension does not respond to ping from disallowed origin', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  })
  try {
    if (!context.serviceWorkers()[0]) {
      await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }

    // about:blank is not in externally_connectable.matches → chrome.runtime
    // should not even be exposed to the page. Verify both the absence of
    // chrome.runtime AND that any direct chrome.runtime.sendMessage call
    // would fail.
    const page = await context.newPage()
    await page.goto('about:blank')
    const probe = await page.evaluate((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (globalThis as any).chrome
      const hasRuntime = !!(c && c.runtime && c.runtime.sendMessage)
      if (!hasRuntime) return { ok: false, reason: 'no_runtime', id }
      return new Promise<{ ok: boolean; reason: string; id: string }>((res) => {
        try {
          c.runtime.sendMessage(id, { type: 'divinci:ping' }, (resp: unknown) => {
            const err = c.runtime.lastError
            if (err) res({ ok: false, reason: err.message, id })
            else res({ ok: !!resp, reason: 'unexpected_response', id })
          })
        } catch (e) {
          res({ ok: false, reason: (e as Error).message, id })
        }
      })
    }, EXPECTED_EXTENSION_ID)

    // Either the chrome.runtime API isn't exposed (preferred — Chromium
    // enforces the allowlist) OR a sendMessage call fails. Both outcomes
    // mean the disallowed origin couldn't reach the bridge.
    expect(probe.ok).toBe(false)
  } finally {
    await context.close()
  }
})
