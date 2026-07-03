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
function createIframeBackend(): { backend: DockBackend; attach: (mountRoot?: ParentNode) => void } {
  const iframe = document.createElement('iframe')
  iframe.src = chrome.runtime.getURL('inference.html')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText =
    'position:fixed;width:1px;height:1px;border:0;left:-9999px;top:-9999px;opacity:0;pointer-events:none'
  // Attach LATE (after the shadow-root UI mounts). Appending the iframe early —
  // before/around the async createShadowRootUi — got it silently dropped from the
  // DOM (verified live: appendChild ran, backend='ok', yet zero iframes existed).
  // Phase 0 appended after mount and worked; so we defer the insertion here.
  const attach = (mountRoot?: ParentNode): void => {
    // Append inside the persistent WXT shadow root when available. Appending to
    // document.body got the iframe DETACHED after it loaded (contentWindow → null,
    // so all later posts silently no-op) — reproduced on multiple sites, so it's
    // our own/WXT lifecycle, not page interference. The shadow root is the
    // extension-managed UI the page + panel re-renders never touch.
    const parent = mountRoot ?? document.body
    if (!iframe.isConnected) parent.appendChild(iframe)
    iframe.addEventListener('load', () =>
      document.documentElement.setAttribute('data-divinci-iframe-loaded', 'yes'),
    )
    // Self-heal: if the iframe is ever detached, re-append it so contentWindow
    // stays live (a reload re-runs the host; the model reloads from cache).
    const reattach = new MutationObserver(() => {
      if (!iframe.isConnected) parent.appendChild(iframe)
    })
    if (parent instanceof Node) reattach.observe(parent, { childList: true })
  }

  let ready = false
  const outbox: unknown[] = []
  const subscribers = new Set<(ev: DivinciExternalEvent) => void>()
  const statusCbs = new Map<string, (r: InternalStatusResponse) => void>()
  let statusSeq = 0

  const post = (msg: unknown): void => {
    const cw = iframe.contentWindow
    const t = (msg as { req?: { type?: string } })?.req?.type ?? '?'
    document.documentElement.setAttribute('data-divinci-post', `${t}:cw=${cw ? 'y' : 'n'}`)
    cw?.postMessage(msg, '*')
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
    // Backend-side tracing (main-world capture is blind to this traffic).
    const dbg = d as { ack?: string; event?: { type?: string; message?: string } }
    if (dbg.ack) document.documentElement.setAttribute('data-divinci-last-ack', dbg.ack)
    // Load-specific stamps that the status poll can't clobber.
    if (dbg.ack === 'divinci:load')
      document.documentElement.setAttribute('data-divinci-load-acked', 'yes')
    if (dbg.event?.type)
      document.documentElement.setAttribute('data-divinci-last-event', dbg.event.type)
    if (dbg.event?.type && dbg.event.type.startsWith('divinci:load'))
      document.documentElement.setAttribute('data-divinci-load-event', dbg.event.type)
    if (dbg.event?.type === 'divinci:error')
      document.documentElement.setAttribute(
        'data-divinci-load-error',
        (dbg.event.message ?? '').slice(0, 120),
      )
    // First message of any kind proves the frame is up — flush the outbox.
    if (!ready) {
      document.documentElement.setAttribute('data-divinci-host-ready', 'yes')
      flush()
    }
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
      document.documentElement.setAttribute(
        'data-divinci-last-send',
        (req as { type?: string }).type + (ready ? ':now' : ':queued'),
      )
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
    let attachBackend: ((mountRoot?: ParentNode) => void) | undefined
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

    // Insert the inference iframe into the persistent shadow root (survives page
    // + panel re-renders; a body child was getting detached). The backend's
    // send/queryStatus outbox queues until the frame loads + signals ready.
    const mountRoot =
      (ui as unknown as { shadow?: ParentNode; shadowHost?: { shadowRoot?: ParentNode } }).shadow ??
      (ui as unknown as { shadowHost?: { shadowRoot?: ParentNode } }).shadowHost?.shadowRoot
    attachBackend?.(mountRoot)
    document.documentElement.setAttribute(
      'data-divinci-iframe',
      mountRoot ? 'attached:shadow' : 'attached:body',
    )
  },
})
