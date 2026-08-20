/**
 * Capture the "hero" store screenshot: the side panel mid-stream from the
 * LOCAL model. Needs the 2.9 GB Gemma 4 E2B weights and a WebGPU GPU, so it is
 * separate from capture-store-screenshots.mjs, which needs neither.
 *
 * Uses a PERSISTENT user-data dir (.playwright-hero-profile) so the weights
 * survive a retry — re-downloading 2.9 GB because a selector moved is not a
 * mistake worth making twice.
 *
 *   nohup node scripts/capture-hero-screenshot.mjs > /tmp/hero.log 2>&1 &
 *
 * Progress is logged with timestamps; the model download dominates the runtime.
 *
 * ⚠️ CHECK FREE SWAP BEFORE RUNNING. transformers.js fetches each shard into an
 * ArrayBuffer before writing it to the Cache API, so a ~1.4 GB shard is a ~1.4 GB
 * renderer allocation. Attempted 2026-08-20 with swap at 6.84/8 GB used and the
 * renderer was killed at 38%: sockets closed, no process held the buffer, the
 * partial cache was purged — and the panel's progress bar simply FROZE on its
 * last value with no error. It is indistinguishable from a slow download.
 *
 * That machine reported "62% memory free" throughout, which counts purgeable
 * pages and is worthless here; `sysctl vm.swapusage` is the number that matters.
 * The network was not the problem — plain curl sustained 11.4 MB/s on the same
 * shard immediately afterwards.
 */
import { chromium } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXT = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const OUT = resolve(__dirname, '..', 'store-assets')
const PROFILE = resolve(__dirname, '..', '.playwright-hero-profile')

const log = (...a) => console.log(new Date().toISOString(), ...a)

if (!existsSync(EXT)) throw new Error(`No dev build at ${EXT}. Run \`pnpm build:dev\`.`)
mkdirSync(OUT, { recursive: true })
mkdirSync(PROFILE, { recursive: true })

const WIDTH = 1280
const HEIGHT = 800

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    // WebGPU is not enabled by default in headless/automation contexts.
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
  ],
})

let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 60_000 })
const extensionId = new URL(sw.url()).host
log('extension id:', extensionId)

const page = await ctx.newPage()
await page.setViewportSize({ width: WIDTH, height: HEIGHT })
page.on('console', (m) => log('[panel]', m.text().slice(0, 300)))
await page.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

const loadButton = page.getByRole('button', { name: /Load Gemma 4 E2B/i }).first()
if (await loadButton.isVisible().catch(() => false)) {
  log('clicking Load — this downloads ~2.9 GB on a cold profile')
  await loadButton.click()
} else {
  log('no Load button visible; assuming the model is already cached')
}

// Ready == the composer stops telling us to load the model.
const composer = page.getByPlaceholder(/Load the model to start chatting|Ask|Message/i).first()
const DEADLINE = Date.now() + 60 * 60 * 1000 // 1h; the download is the long pole
let ready = false
while (Date.now() < DEADLINE) {
  const ph = await composer.getAttribute('placeholder').catch(() => null)
  if (ph && !/Load the model/i.test(ph)) {
    ready = true
    break
  }
  const body = await page.locator('body').innerText().catch(() => '')
  const pct = body.match(/(\d{1,3})\s?%/)
  log('waiting for model…', pct ? `${pct[1]}%` : '(no progress shown)')
  await page.waitForTimeout(15_000)
}
if (!ready) throw new Error('model never became ready within the deadline')
log('model ready')

await composer.click()
await composer.fill('In two sentences, why does running a model locally in the browser protect privacy?')
await page.keyboard.press('Enter')
log('prompt sent; waiting for the stream to have visible text')

// Screenshot mid-stream: enough tokens to look alive, before it finishes.
const start = Date.now()
while (Date.now() - start < 120_000) {
  const body = await page.locator('body').innerText().catch(() => '')
  if (body.length > 400 && /privacy|device|local/i.test(body)) break
  await page.waitForTimeout(1500)
}
await page.waitForTimeout(2500)
await page.screenshot({ path: resolve(OUT, '00-hero-local-stream.png'), fullPage: false })
log('captured 00-hero-local-stream.png')

await ctx.close()
log('done')
