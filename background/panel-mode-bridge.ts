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
      if (
        type !== 'internal:open-sidepanel' &&
        type !== 'internal:open-popout' &&
        type !== 'internal:open-overlay' &&
        type !== 'internal:close-sidepanel'
      ) {
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

      if (type === 'internal:close-sidepanel') {
        // No-op if no dock is open on the active tab (disabling is harmless).
        void closeSidePanel().then(
          () => sendResponse({ ok: true }),
          (e) => {
            log.debug('sidePanel close failed:', e)
            sendResponse({ ok: false, error: String(e) })
          },
        )
        return true
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

interface SidePanelApi {
  open: (o: { tabId?: number; windowId?: number }) => Promise<void>
  setOptions: (o: { tabId: number; path?: string; enabled: boolean }) => Promise<void>
}
function sidePanelApi(): SidePanelApi {
  const sp = (chrome as unknown as { sidePanel?: SidePanelApi }).sidePanel
  if (!sp?.open) throw new Error('sidePanel API unavailable')
  return sp
}

async function activeTabId(): Promise<number | undefined> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return active?.id
}

async function openSidePanel(sender: chrome.runtime.MessageSender): Promise<void> {
  const sidePanel = sidePanelApi()
  // open() must be called synchronously after the user gesture, so do NOT await
  // a setOptions() before it — closeSidePanel re-arms (enabled:true) on close,
  // so the tab is always enabled by the time the Dock toggle calls open().
  if (typeof sender.tab?.id === 'number') {
    await sidePanel.open({ tabId: sender.tab.id })
    return
  }
  const tabId = await activeTabId()
  if (typeof tabId !== 'number') throw new Error('no target tab for sidePanel.open')
  await sidePanel.open({ tabId })
}

async function closeSidePanel(): Promise<void> {
  const sidePanel = sidePanelApi()
  const tabId = await activeTabId()
  if (typeof tabId !== 'number') return
  // No sidePanel.close() exists; disabling for this tab closes an open panel.
  // Re-enable immediately so the Dock toggle can reopen it later (enabling does
  // not auto-open — it only restores availability).
  await sidePanel.setOptions({ tabId, enabled: false })
  await sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true })
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
