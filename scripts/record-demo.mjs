/**
 * Record a real demo of the extension answering locally — including with the
 * network switched OFF, which is the only proof that matters for "runs on your
 * machine". Nothing here is staged: it drives the built extension in Chromium.
 *
 *   pnpm build:dev && node scripts/record-demo.mjs
 *
 * Reuses .playwright-hero-profile so the model is already cached; a cold
 * profile would spend the whole recording downloading.
 */
import { chromium } from '@playwright/test'
import { existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXT = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const PROFILE = resolve(__dirname, '..', '.playwright-hero-profile')
const OUT = resolve(__dirname, '..', 'store-assets', 'demo')
const MODEL = process.env.MODEL || 'Qwen2.5 0.5B'

const log = (...a) => console.log(new Date().toISOString(), ...a)
if (!existsSync(EXT)) throw new Error('No dev build. Run `pnpm build:dev`.')
mkdirSync(OUT, { recursive: true })

const W = 1280
const H = 800

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--window-size=${W},${H}`,
    '--enable-unsafe-webgpu',
  ],
})

let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 60_000 })
const id = new URL(sw.url()).host

const page = await ctx.newPage()
await page.setViewportSize({ width: W, height: H })
await page.goto(`chrome-extension://${id}/panel.html`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500) // let the mascot settle; opening beat of the video

// Make sure the model is loaded (cached → fast).
const picker = page.locator('select').first()
if (await picker.isVisible().catch(() => false)) {
  const opts = await picker.locator('option').allTextContents()
  const match = opts.find((o) => o.toLowerCase().includes(MODEL.toLowerCase()))
  if (match) await picker.selectOption({ label: match })
  await page.waitForTimeout(1200)
}
const loadBtn = page.getByRole('button', { name: /^Load /i }).first()
if (await loadBtn.isVisible().catch(() => false)) {
  await loadBtn.click()
  log('loading model…')
}

const composer = page.getByPlaceholder(/Load the model|Message|Ask/i).first()
const deadline = Date.now() + 20 * 60 * 1000
while (Date.now() < deadline) {
  const ph = await composer.getAttribute('placeholder').catch(() => null)
  if (ph && !/Load the model/i.test(ph)) break
  await page.waitForTimeout(3000)
}
log('model ready')
await page.waitForTimeout(1500)

async function ask(question, settleMs = 9000) {
  await composer.click()
  // Typed with a delay so the recording reads as someone using it.
  await composer.type(question, { delay: 45 })
  await page.waitForTimeout(600)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(settleMs)
}

await ask('What is WebGPU, in one sentence?')

// The point of the whole video: cut the network, ask again, still get an answer.
log('going offline')
await ctx.setOffline(true)
await page.waitForTimeout(1800)
await ask('Now answer with no internet: name three colours.', 11_000)
await page.waitForTimeout(2500)

const video = page.video()
await ctx.close() // video is only finalised on close

if (video) {
  const src = await video.path()
  const dest = resolve(OUT, 'divinci-local-inference-demo.webm')
  renameSync(src, dest)
  log('wrote', dest)
} else {
  log('no video handle; files in', OUT, readdirSync(OUT))
}
