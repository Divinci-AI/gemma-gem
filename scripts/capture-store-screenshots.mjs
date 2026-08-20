/**
 * Capture Chrome Web Store screenshots from the REAL extension, loaded
 * unpacked in real Chromium — not mockups, not a static render of the HTML.
 * The store's screenshots must show the product as installed.
 *
 * Output is exactly 1280x800, which is what the CWS listing form wants
 * (the other accepted size is 640x400). deviceScaleFactor stays 1 so the PNG
 * is 1280x800 pixels, not a 2x retina image that the form rejects.
 *
 *   pnpm build:dev && node scripts/capture-store-screenshots.mjs
 *
 * These are UI-state shots and involve no model download. The "hero" shot of a
 * live local-model stream needs the 2.9 GB weights + a WebGPU GPU; capture that
 * one with RUN_REAL_INFERENCE=1 against the panel, by hand.
 */
import { chromium } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXT = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const OUT = resolve(__dirname, '..', 'store-assets')

if (!existsSync(EXT)) {
  throw new Error(`No dev build at ${EXT}. Run \`pnpm build:dev\` first.`)
}
mkdirSync(OUT, { recursive: true })

const WIDTH = 1280
const HEIGHT = 800

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
  ],
})

// The MV3 service worker is how we learn the extension id.
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 })
const extensionId = new URL(sw.url()).host
console.log('extension id:', extensionId)

const shots = [
  // The side panel fills a 1280x800 frame on its own.
  { file: '01-side-panel.png', path: 'panel.html', settle: 3500 },
]

for (const shot of shots) {
  const page = await ctx.newPage()
  await page.setViewportSize({ width: WIDTH, height: HEIGHT })
  await page.goto(`chrome-extension://${extensionId}/${shot.path}`, {
    waitUntil: 'domcontentloaded',
  })
  // The panel renders a 3D mascot iframe; give WebGL a beat to draw so the
  // screenshot is not of an empty canvas.
  await page.waitForTimeout(shot.settle)
  await page.screenshot({ path: resolve(OUT, shot.file), fullPage: false })
  console.log('captured', shot.file)
  await page.close()
}

/**
 * The popup is ~340 px wide by design, so shooting it into a 1280x800 viewport
 * leaves two thirds of the frame blank — a technically-valid screenshot that
 * reads as a broken one. Capture it at its NATURAL size, then compose it onto
 * the required canvas. The pixels of the UI are untouched; only the surrounding
 * space is ours.
 */
const POPUP_W = 380
const POPUP_H = 760
const popupPage = await ctx.newPage()
await popupPage.setViewportSize({ width: POPUP_W, height: POPUP_H })
await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
  waitUntil: 'domcontentloaded',
})
await popupPage.waitForTimeout(2500)
const popupShot = await popupPage.screenshot({ type: 'png' })
await popupPage.close()

const composed = await ctx.newPage()
await composed.setViewportSize({ width: WIDTH, height: HEIGHT })
await composed.setContent(`<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{
    display:flex;align-items:center;justify-content:center;gap:56px;
    background:linear-gradient(135deg,#eef1ff 0%,#f7f8fc 55%,#eaf0ff 100%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    color:#1c2033;
  }
  .copy{max-width:430px}
  .copy h1{font-size:40px;line-height:1.15;margin:0 0 18px;letter-spacing:-.02em}
  .copy p{font-size:19px;line-height:1.5;margin:0 0 14px;color:#48506b}
  .pill{display:inline-block;margin-top:8px;padding:8px 16px;border-radius:999px;
        background:#fff;border:1px solid #d9dff5;font-size:15px;color:#3b3f5c}
  img{width:${POPUP_W}px;height:${POPUP_H}px;border-radius:14px;
      box-shadow:0 24px 60px rgba(28,32,51,.20);border:1px solid #dfe3f2;background:#fff}
</style>
<div class="copy">
  <h1>Run Gemma 4 in your browser.</h1>
  <p>The model runs on your own GPU via WebGPU. No API keys, no per-token cost.</p>
  <p>It loads once per browser profile and stays available in every tab.</p>
  <span class="pill">Local by default — chats stay on your device</span>
</div>
<img src="data:image/png;base64,${popupShot.toString('base64')}" alt="">`)
await composed.waitForTimeout(600)
await composed.screenshot({ path: resolve(OUT, '02-popup.png') })
console.log('captured 02-popup.png')
await composed.close()

/**
 * Small promotional tile — REQUIRED by the listing form, 440x280 exactly.
 * Uses the extension's own shipped 128px icon so the tile and the installed
 * item cannot drift apart.
 */
const tile = await ctx.newPage()
await tile.setViewportSize({ width: 440, height: 280 })
// Read the icon off disk and inline it. Referencing `chrome-extension://` from
// a setContent page is a cross-origin load that never resolves, so the page
// never fires `load` and setContent times out.
const iconDataUri =
  'data:image/png;base64,' + readFileSync(resolve(EXT, 'icon', '128.png')).toString('base64')
await tile.setContent(`<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:440px;height:280px;overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       background:linear-gradient(135deg,#4f46e5 0%,#6366f1 50%,#7c83ff 100%);
       color:#fff;text-align:center;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .icon{width:76px;height:76px;border-radius:18px;background:#fff;margin-bottom:16px;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 10px 26px rgba(0,0,0,.22)}
  .icon img{width:60px;height:60px}
  h1{font-size:25px;margin:0 0 8px;letter-spacing:-.01em}
  p{font-size:15px;margin:0;opacity:.92}
</style>
<div class="icon"><img src="${iconDataUri}" alt=""></div>
<h1>Divinci Local Inference</h1>
<p>Gemma 4 on your GPU — private, no API cost</p>`)
await tile.waitForTimeout(600)
await tile.screenshot({ path: resolve(OUT, 'promo-tile-440x280.png') })
console.log('captured promo-tile-440x280.png')
await tile.close()

await ctx.close()
console.log('\nWrote to store-assets/.')
