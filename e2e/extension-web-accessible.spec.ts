/**
 * WHERE is the web_accessible_resources boundary?
 *
 * build/web-accessible.ts asserts, in a comment that predates this test, that
 * a framed extension page's "own sub-resource scripts must ALSO be
 * web-accessible or the browser blocks them and nothing in the iframe runs".
 * Two build-time guards enforce that belief, and it is the entire reason the
 * manifest exposes eleven app chunks and every ORT binary to `<all_urls>`.
 *
 * Nobody had measured it. This does.
 *
 * The measurement needs a positive control or it proves nothing: if the probe
 * can reach an unexposed resource from the WEB PAGE too, the harness is
 * broken, not the rule. So every case is run from both contexts.
 *
 * No model download — this is a manifest question, not an inference one.
 */
import { chromium, expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test'
import http from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', '.output', 'chrome-mv3-dev')
const EXTENSION_ID = 'laeebjagghfeepomjhbfohefghonemeo'
const PORT = 8231

function exposedResources(): string[] {
  const m = JSON.parse(readFileSync(resolve(EXTENSION_PATH, 'manifest.json'), 'utf-8'))
  return m.web_accessible_resources.flatMap((e: { resources: string[] }) => e.resources)
}

/** A built chunk that no web_accessible_resources pattern covers. */
function unexposedChunk(): string {
  const patterns = exposedResources()
  const glob = (g: string) =>
    new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
  const found = readdirSync(resolve(EXTENSION_PATH, 'chunks'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `chunks/${f}`)
    .find((f) => !patterns.some((p) => glob(p).test(f)))
  if (!found) throw new Error('every chunk is exposed — no probe available')
  return found
}

const url = (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`

async function canFetch(ctx: Frame | Page, path: string) {
  return ctx.evaluate(async (u: string) => {
    try {
      const r = await fetch(u)
      return { ok: r.ok, status: r.status }
    } catch (e) {
      return { ok: false, status: 0, error: String(e).slice(0, 80) }
    }
  }, url(path))
}

async function canRunScript(ctx: Frame, path: string) {
  return ctx.evaluate(
    (u: string) =>
      new Promise<{ loaded: boolean }>((res) => {
        const el = document.createElement('script')
        el.src = u
        el.onload = () => res({ loaded: true })
        el.onerror = () => res({ loaded: false })
        document.head.appendChild(el)
        setTimeout(() => res({ loaded: false }), 5000)
      }),
    url(path),
  )
}

test.describe('web_accessible_resources', () => {
  let context: BrowserContext
  let server: http.Server

  test.beforeAll(async () => {
    expect(existsSync(EXTENSION_PATH), 'build first: pnpm build:dev').toBe(true)
    server = http.createServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><html><head><title>host</title></head><body>host</body></html>')
    })
    await new Promise<void>((r) => server.listen(PORT, r))
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
      ],
    })
  })

  test.afterAll(async () => {
    await context?.close()
    await new Promise<void>((r) => server?.close(() => r()))
  })

  async function hostPage(): Promise<Page> {
    const page = await context.newPage()
    // Installed before any page script so the iframe's `ready` post cannot
    // arrive before the listener exists.
    await page.addInitScript(() => {
      ;(window as unknown as Record<string, unknown>).__inferenceReady = false
      window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { __divinciInference?: boolean; ready?: boolean } | null
        if (d?.__divinciInference && d.ready) {
          ;(window as unknown as Record<string, unknown>).__inferenceReady = true
        }
      })
    })
    await page.goto(`http://localhost:${PORT}/`)
    return page
  }

  async function inferenceFrame(page: Page): Promise<Frame> {
    // Poll page.frames() rather than querySelectorAll: the content script
    // appends the iframe INSIDE the WXT shadow root, which a document query
    // does not pierce. Playwright sees frames regardless.
    const deadline = Date.now() + 25_000
    let f = page.frames().find((fr) => fr.url().includes('inference.html'))
    while (!f && Date.now() < deadline) {
      await page.waitForTimeout(250)
      f = page.frames().find((fr) => fr.url().includes('inference.html'))
    }
    expect(f, 'the content script did not attach the inference iframe').toBeTruthy()
    return f!
  }

  test('the boundary is the WEB PAGE, not the framed extension document', async () => {
    const page = await hostPage()
    const frame = await inferenceFrame(page)
    const probe = unexposedChunk()

    const fromPage = {
      exposed: await canFetch(page, 'inference.html'),
      unexposed: await canFetch(page, 'panel.html'),
    }
    const fromFrame = {
      exposed: await canFetch(frame, 'inference.html'),
      unexposedPage: await canFetch(frame, 'panel.html'),
      unexposedChunk: await canFetch(frame, probe),
      unexposedScript: await canRunScript(frame, probe),
    }
    console.log('probe chunk:', probe)
    console.log('from page :', JSON.stringify(fromPage))
    console.log('from frame:', JSON.stringify(fromFrame))

    // Positive control. Without this the rest proves nothing.
    expect(fromPage.exposed.ok, 'an exposed resource must be reachable from the page').toBe(true)
    expect(fromPage.unexposed.ok, 'THE HARNESS IS BROKEN: the page reached an unexposed resource')
      .toBe(false)

    // The measured rule: once the extension document is loaded — which does
    // require an entry — it is a same-origin extension context and the
    // manifest stops applying to what it loads.
    expect(fromFrame.exposed.ok).toBe(true)
    expect(
      fromFrame.unexposedPage.ok,
      'Chrome tightened this: a framed extension page can no longer read ' +
        'unexposed resources. The chunk/ORT entries in WEB_ACCESSIBLE_RESOURCES ' +
        'are load-bearing again — restore whatever was trimmed.',
    ).toBe(true)
    expect(fromFrame.unexposedChunk.ok).toBe(true)
    expect(
      fromFrame.unexposedScript.loaded,
      'a <script src> to an unexposed chunk no longer executes in the frame',
    ).toBe(true)
  })

  test('the robot iframe finishes booting', async () => {
    // The other framed page. Its scripts, its 3D bundle and its PNG are all
    // sub-resources of robot.html, so this is the second half of the same
    // question: does exposing the DOCUMENT suffice?
    const page = await context.newPage()
    const mounted = page.waitForEvent('console', {
      predicate: (m) => m.text().includes('[divinci-robot] 3D robot mounted'),
      timeout: 30_000,
    })
    await page.goto(`http://localhost:${PORT}/`)
    await page.evaluate((u) => {
      const f = document.createElement('iframe')
      f.src = u
      document.body.appendChild(f)
    }, url('robot.html'))
    await mounted
  })

  test('the inference iframe finishes booting', async () => {
    // The real functional signal: entrypoints/inference/main.ts posts
    // `{__divinciInference, ready}` at the END of its module, so this is only
    // true if the iframe's whole chunk graph loaded AND executed.
    const page = await hostPage()
    await inferenceFrame(page)
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__inferenceReady === true,
      undefined,
      { timeout: 30_000 },
    )
  })
})
