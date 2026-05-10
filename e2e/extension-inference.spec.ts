/**
 * Full-inference E2E — gated by `RUN_REAL_INFERENCE=1`.
 *
 * Loads the extension, opens a `localhost:8080` page, opens a port,
 * triggers a real model load + chat, and asserts tokens stream. Needs:
 *  - WebGPU-capable hardware (Apple Silicon, recent NVIDIA, recent
 *    integrated Intel/AMD; the smoke spec has none of these requirements).
 *  - ~3 GB of free disk for the cached model weights.
 *  - Outbound HTTPS to huggingface.co for the first run.
 *  - At least 10 minutes of patience on the first run; subsequent runs
 *    use the Cache API entry for faster startup.
 *
 * Skipped by default because (a) GitHub-hosted runners don't have
 * WebGPU, (b) it's slow, and (c) the smoke spec catches the highest-
 * leverage regressions (manifest, ID, ping, allowlist) without any of
 * those costs.
 *
 * To run:
 *   pnpm build                 # produce .output/chrome-mv3-dev/
 *   RUN_REAL_INFERENCE=1 pnpm e2e --project=full-inference
 */

import { chromium, expect, test } from '@playwright/test'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const EXTENSION_ID = 'laeebjagghfeepomjhbfohefghonemeo'
const PORT = 8080

function inferencePage(): string {
  // Page opens a port to the extension, fires divinci:load → divinci:chat,
  // and stashes the streamed tokens on window so the test can poll them.
  return `<!doctype html>
<html><head><title>pending</title></head>
<body>
<script>
(async () => {
  const log = []
  window.__streamLog = log
  const port = chrome.runtime.connect(${JSON.stringify(EXTENSION_ID)}, { name: 'e2e' })

  port.onMessage.addListener((msg) => {
    log.push(msg)
    if (msg.type === 'divinci:load-done') {
      port.postMessage({
        type: 'divinci:chat',
        requestId: 'r-chat',
        modelId: 'gemma-4-e2b',
        messages: [{ role: 'user', content: 'Reply with the single word: ready.' }],
        maxNewTokens: 8,
        temperature: 0,
      })
    }
    if (msg.type === 'divinci:chat-done') {
      document.title = 'CHAT_DONE'
    }
    if (msg.type === 'divinci:error') {
      document.title = 'ERROR:' + msg.message
    }
  })
  port.postMessage({
    type: 'divinci:load',
    requestId: 'r-load',
    modelId: 'gemma-4-e2b',
  })
  document.title = 'loading'
})()
</script>
</body></html>`
}

let server: http.Server

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`Run \`pnpm build\` first to produce ${EXTENSION_PATH}`)
  }
  server = await new Promise<http.Server>((res, rej) => {
    const s = http.createServer((_req, _res) => {
      _res.setHeader('Content-Type', 'text/html; charset=utf-8')
      _res.end(inferencePage())
    })
    s.on('error', rej)
    s.listen(PORT, '127.0.0.1', () => res(s))
  })
})

test.afterAll(async () => {
  await new Promise<void>((res) => server?.close(() => res()))
})

test('real Gemma 4 E2B load + chat streams tokens end-to-end', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--enable-features=Vulkan,WebGPU',
    ],
  })
  try {
    if (!context.serviceWorkers()[0]) {
      await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }
    const page = await context.newPage()
    await page.goto(`http://localhost:${PORT}/`)

    // Up to 10 min for the first load (HF download). Subsequent runs hit
    // the disk cache and are much faster.
    await page.waitForFunction(() => document.title === 'CHAT_DONE', { timeout: 600_000 })

    const log = await page.evaluate(
      () => (window as unknown as { __streamLog: Array<{ type: string }> }).__streamLog,
    )
    const tokenEvents = log.filter((m) => m.type === 'divinci:chat-token')
    expect(tokenEvents.length).toBeGreaterThan(0)
    const doneEvent = log.find((m) => m.type === 'divinci:chat-done')
    expect(doneEvent).toBeDefined()
  } finally {
    await context.close()
  }
})
