/**
 * Panel-mode bridge — opens the three chat surfaces on behalf of the UI's
 * hamburger toggle row (ui/chat-panel.ts).
 *
 * The overlay is the content script (always present, just open/closed); the
 * Dock (chrome.sidePanel) and Pop-out (a window) are the same panel.html page
 * opened on demand. Content scripts and extension pages can't call
 * chrome.sidePanel.open / chrome.windows.create themselves, so they message the
 * SW, which performs the privileged open here.
 *
 * Mutual exclusion is intentionally loose: chrome.sidePanel has no close() API,
 * so switching surfaces opens the target without force-closing the others. The
 * UI hides the overlay locally when it hands off to dock/pop-out.
 */
import { STORAGE_KEY_OPEN } from '@/shared/models'
import { log } from '@/shared/logger'

// One reusable pop-out window. Re-clicking "Pop-out" focuses the existing
// window instead of spawning duplicates.
let popoutWindowId: number | null = null

export function setupPanelModeBridge(): void {
  chrome.runtime.onMessage.addListener(
    (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
      const type = (msg as { type?: string })?.type
      if (type !== 'internal:open-sidepanel' && type !== 'internal:open-popout' && type !== 'internal:open-overlay') {
        return
      }

      if (type === 'internal:open-sidepanel') {
        // sidePanel.open() requires a user gesture; the content-script click that
        // sent this message carries it through to the onMessage handler.
        void openSidePanel(sender).then(
          () => sendResponse({ ok: true }),
          (e) => {
            log.debug('sidePanel.open failed:', e)
            sendResponse({ ok: false, error: String(e) })
          },
        )
        return true // async sendResponse
      }

      if (type === 'internal:open-popout') {
        void openPopout().then(
          () => sendResponse({ ok: true }),
          (e) => {
            log.debug('windows.create failed:', e)
            sendResponse({ ok: false, error: String(e) })
          },
        )
        return true
      }

      // internal:open-overlay — re-open the in-page overlay. The cross-tab sync
      // in mountChatPanel (overlay mode) watches STORAGE_KEY_OPEN and opens.
      void chrome.storage.local.set({ [STORAGE_KEY_OPEN]: true }).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) }),
      )
      return true
    },
  )

  // Forget the pop-out id when the user closes that window.
  chrome.windows.onRemoved.addListener((id) => {
    if (id === popoutWindowId) popoutWindowId = null
  })
}

async function openSidePanel(sender: chrome.runtime.MessageSender): Promise<void> {
  const sidePanel = (
    chrome as unknown as {
      sidePanel?: { open: (o: { tabId?: number; windowId?: number }) => Promise<void> }
    }
  ).sidePanel
  if (!sidePanel?.open) throw new Error('sidePanel API unavailable')
  // Prefer the sender's tab (content-script overlay). Fall back to the active
  // tab in the focused window (panel-page sender has no tab).
  const tabId = sender.tab?.id
  if (typeof tabId === 'number') {
    await sidePanel.open({ tabId })
    return
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (typeof active?.id === 'number') {
    await sidePanel.open({ tabId: active.id })
    return
  }
  if (typeof active?.windowId === 'number') {
    await sidePanel.open({ windowId: active.windowId })
    return
  }
  throw new Error('no target tab/window for sidePanel.open')
}

async function openPopout(): Promise<void> {
  if (typeof popoutWindowId === 'number') {
    try {
      await chrome.windows.update(popoutWindowId, { focused: true })
      return
    } catch {
      popoutWindowId = null // stale id; fall through to create
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html?surface=popout'),
    type: 'popup',
    width: 440,
    height: 760,
  })
  popoutWindowId = win?.id ?? null
}
