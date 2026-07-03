/**
 * Content-script entrypoint — mounts the shared chat panel as an in-page overlay
 * (a launcher + slide-in right-hand sidebar, shadow-DOM isolated, on every page).
 *
 * All UI + chat logic lives in @/ui/chat-panel (mountChatPanel), shared with the
 * standalone panel page (browser side-panel dock + pop-out window). This wrapper
 * supplies the content-script CONTEXT:
 *   - the shadow-root mount target (createShadowRootUi),
 *   - host-page access (readPageText / pageHref / pageTitle) for grounding, and
 *   - the PAGE-CONTEXT INFERENCE BACKEND: a hidden chrome-extension iframe that
 *     runs on-device models with working WebGPU. The MV3 offscreen document
 *     can't run WebGPU inference in the current Chrome (loads/generates hang on
 *     a WASM-CPU fallback); a framed extension page CAN (the robot iframe proves
 *     WebGL works there, and LFM2.5 generates in ~200ms). So the overlay routes
 *     local traffic through this iframe instead of the SW/offscreen port.
 */

import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { mountChatPanel, SIDEBAR_CSS, type DockBackend } from '@/ui/chat-panel'
import type { DivinciExternalEvent, InternalStatusResponse } from '@/shared/messages'

/**
 * Create the page-context inference iframe and a DockBackend over it. The
 * content script posts `{ __divinciReq, req }` to the frame and receives
 * `{ __divinciInference, event | statusResponse | ready }` back. Sends are
 * queued until the frame signals ready.
 */
function createIframeBackend(): { backend: DockBackend; attach: () => void } {
  const iframe = document.createElement('iframe')
  iframe.src = chrome.runtime.getURL('inference.html')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText =
    'position:fixed;width:1px;height:1px;border:0;left:-9999px;top:-9999px;opacity:0;pointer-events:none'
  // Attach LATE (after the shadow-root UI mounts). Appending the iframe early —
  // before/around the async createShadowRootUi — got it silently dropped from the
  // DOM (verified live: appendChild ran, backend='ok', yet zero iframes existed).
  // Phase 0 appended after mount and worked; so we defer the insertion here.
  const attach = (): void => {
    if (!iframe.isConnected) document.documentElement.appendChild(iframe)
    // Map the document relationship: append a plain probe DIV + the iframe, then
    // stamp what THIS (content-script) document sees. The main world compares.
    const probe = document.createElement('div')
    probe.id = 'dv-probe'
    document.body.appendChild(probe)
    const de = document.documentElement
    de.setAttribute('data-divinci-iframe-now', String(iframe.isConnected))
    de.setAttribute('data-divinci-probe-div', String(!!document.getElementById('dv-probe')))
    de.setAttribute('data-divinci-body-kids', String(document.body.children.length))
    de.setAttribute('data-divinci-is-top', String(window === window.top))
    de.setAttribute('data-divinci-doc-url', String(document.location.href).slice(0, 60))
    setTimeout(() => {
      de.setAttribute('data-divinci-iframe-later', String(iframe.isConnected))
    }, 1500)
  }

  let ready = false
  const outbox: unknown[] = []
  const subscribers = new Set<(ev: DivinciExternalEvent) => void>()
  const statusCbs = new Map<string, (r: InternalStatusResponse) => void>()
  let statusSeq = 0

  const post = (msg: unknown): void => {
    iframe.contentWindow?.postMessage(msg, '*')
  }
  const flush = (): void => {
    ready = true
    while (outbox.length) post(outbox.shift())
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return
    const d = e.data as {
      __divinciInference?: boolean
      ready?: boolean
      event?: DivinciExternalEvent
      statusResponse?: InternalStatusResponse
      statusId?: string
    } | null
    if (!d || !d.__divinciInference) return
    // First message of any kind proves the frame is up — flush the outbox.
    if (!ready) flush()
    if (d.ready) return
    if (d.statusResponse) {
      const cb = d.statusId ? statusCbs.get(d.statusId) : undefined
      if (cb && d.statusId) {
        statusCbs.delete(d.statusId)
        cb(d.statusResponse)
      }
      return
    }
    if (d.event) for (const h of subscribers) h(d.event)
  })

  const backend: DockBackend = {
    send(req) {
      const msg = { __divinciReq: true, req }
      if (ready) post(msg)
      else outbox.push(msg)
    },
    subscribe(handler) {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },
    queryStatus(cb) {
      const statusId = `s${++statusSeq}`
      statusCbs.set(statusId, cb)
      const msg = { __divinciReq: true, req: { type: 'internal:status' }, statusId }
      if (ready) post(msg)
      else outbox.push(msg)
      // Bound the callback map if the frame never answers.
      setTimeout(() => statusCbs.delete(statusId), 5000)
    },
  }
  return { backend, attach }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Avoid running inside our own extension pages or obvious non-content frames.
  // The launcher only makes sense on real web pages.
  allFrames: false,

  async main(ctx) {
    // Spin up the page-context inference backend once per page. Guarded so a
    // torn-down extension context (navigation mid-setup) doesn't throw.
    let backend: DockBackend | undefined
    let attachBackend: (() => void) | undefined
    try {
      const created = createIframeBackend()
      backend = created.backend
      attachBackend = created.attach
      // Visible diagnostic (isolated-world console.* doesn't surface to the page):
      // stamp on <html> so a driver can read whether the backend wired up.
      document.documentElement.setAttribute('data-divinci-backend', 'ok')
    } catch (e) {
      backend = undefined
      document.documentElement.setAttribute(
        'data-divinci-backend',
        'error: ' + String((e as Error)?.message ?? e).slice(0, 200),
      )
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'divinci-local-sidebar',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      // Keep page hotkeys from firing while the user types in our textarea, and
      // keep page CSS from leaking in (createIsolatedElement applies an
      // `all:initial` reset on the host).
      isolateEvents: true,
      css: SIDEBAR_CSS,
      onMount: (container) =>
        mountChatPanel(container, {
          mode: 'overlay',
          surface: 'overlay',
          onInvalidated: ctx.onInvalidated,
          backend,
          host: {
            // Raw visible text of the page (the panel normalizes + caps it).
            readPageText: () =>
              (
                document.querySelector<HTMLElement>('main, article, [role="main"]') ??
                document.body
              )?.innerText ?? '',
            pageHref: () => location.href,
            pageTitle: () => document.title,
          },
        }),
      onRemove: (mounted) => mounted?.dispose(),
    })

    ui.mount()

    // Insert the inference iframe now that the UI has mounted and the DOM has
    // settled — appending it earlier got it silently dropped. The backend's
    // send/queryStatus outbox queues until the frame loads + signals ready.
    attachBackend?.()
    document.documentElement.setAttribute('data-divinci-iframe', 'attached')
  },
})
