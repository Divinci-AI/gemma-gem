/**
 * Content-script entrypoint — mounts the shared chat panel as an in-page overlay
 * (a launcher + slide-in right-hand sidebar, shadow-DOM isolated, on every page).
 *
 * All UI + chat logic lives in @/ui/chat-panel (mountChatPanel), shared with the
 * standalone panel page (browser side-panel dock + pop-out window). This wrapper
 * only supplies the content-script CONTEXT:
 *   - the shadow-root mount target (createShadowRootUi), and
 *   - host-page access (readPageText / pageHref / pageTitle) for grounding.
 * The transport (chrome.runtime.connect → SW) works identically in both
 * contexts, so it isn't abstracted.
 */

import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { mountChatPanel, SIDEBAR_CSS } from '@/ui/chat-panel'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Avoid running inside our own extension pages or obvious non-content frames.
  // The launcher only makes sense on real web pages.
  allFrames: false,

  async main(ctx) {
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
  },
})
