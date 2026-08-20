/**
 * Generate the extension icon set from the master robot render.
 *
 * The master is a 1024x1049 render with the robot centred on navy and a small
 * sparkle in the bottom-right corner. The sparkle is deliberately EXCLUDED:
 * measured content bounds are x 257-788, y 157-870 for the robot vs x..927,
 * y..952 once the sparkle is counted, so including it shifts the robot
 * off-centre and shrinks it for no benefit at 16px.
 *
 * The art is fitted into a centred 96/128 box (75%). That is Google's own
 * guidance for store icons, and it also keeps the mark inside the inscribed
 * circle of the square — several surfaces render extension icons rounded, and
 * art cropped to the content bounds gets clipped there.
 *
 * Rendered at 4x and downsampled, because drawing straight to 16px produces
 * visibly harsh edges on the antennae.
 *
 *   node scripts/make-icons.mjs
 */
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MASTER = process.env.MASTER ||
  '/Users/michael/Documents/Divinci Marketing/divinci-robot-gemini.png'
const OUT = resolve(__dirname, '..', 'public', 'icon')

/** Robot-only content bounds in the master, measured not guessed. */
const CROP = { x: 257, y: 157, w: 788 - 257, h: 870 - 157 }
const BG = 'rgb(24, 31, 59)'
const SIZES = [16, 32, 48, 96, 128]
/** Fraction of the canvas the art occupies. */
const ART_FRACTION = 96 / 128

const dataUri = 'data:image/png;base64,' + readFileSync(MASTER).toString('base64')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()

for (const size of SIZES) {
  const b64 = await page.evaluate(
    async ({ uri, size, crop, bg, artFraction }) => {
      const img = new Image()
      img.src = uri
      await img.decode()

      const SS = 4 // supersample factor
      const big = document.createElement('canvas')
      big.width = size * SS
      big.height = size * SS
      const g = big.getContext('2d')
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.fillStyle = bg
      g.fillRect(0, 0, big.width, big.height)

      // Fit the crop inside the art box, preserving aspect ratio.
      const boxPx = size * artFraction * SS
      const scale = Math.min(boxPx / crop.w, boxPx / crop.h)
      const dw = crop.w * scale
      const dh = crop.h * scale
      g.drawImage(
        img, crop.x, crop.y, crop.w, crop.h,
        (big.width - dw) / 2, (big.height - dh) / 2, dw, dh,
      )

      const out = document.createElement('canvas')
      out.width = size
      out.height = size
      const og = out.getContext('2d')
      og.imageSmoothingEnabled = true
      og.imageSmoothingQuality = 'high'
      og.drawImage(big, 0, 0, size, size)
      return out.toDataURL('image/png').split(',')[1]
    },
    { uri: dataUri, size, crop: CROP, bg: BG, artFraction: ART_FRACTION },
  )
  const file = resolve(OUT, `${size}.png`)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  console.log(`wrote ${file}`)
}

await browser.close()
