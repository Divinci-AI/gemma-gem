/**
 * Tab-session bridge (SW side).
 *
 * Two responsibilities for the per-tab chat model:
 *   1. Answer `internal:get-tab-id` — a content script can't read its own
 *      tabId; only the SW sees it via `sender.tab`. The sidebar needs it to
 *      key its per-tab active conversation.
 *   2. Prune a tab's entry from the per-tab active-conversation map when the
 *      tab closes, so STORAGE_KEY_TAB_ACTIVE doesn't accumulate dead tabIds
 *      (tabIds are reused by the browser over time).
 *
 * The conversation list/history itself stays global (chrome.storage.local);
 * only the per-tab *pointer* to the active conversation is managed here.
 */

import { STORAGE_KEY_TAB_ACTIVE } from '@/shared/models'
import type {
  Message,
  InternalGetTabIdRequest,
  InternalGetTabIdResponse,
} from '@/shared/messages'

export function setupTabSessionBridge(): void {
  chrome.runtime.onMessage.addListener(
    (msg: Message, sender, sendResponse: (r?: unknown) => void) => {
      if ((msg as InternalGetTabIdRequest)?.type !== 'internal:get-tab-id') return undefined
      const resp: InternalGetTabIdResponse = {
        type: 'internal:get-tab-id-response',
        tabId: typeof sender.tab?.id === 'number' ? sender.tab.id : null,
      }
      sendResponse(resp)
      return true
    },
  )

  // Drop a closed tab's active-conversation pointer.
  chrome.tabs?.onRemoved.addListener((tabId) => {
    void chrome.storage.local.get(STORAGE_KEY_TAB_ACTIVE).then((stored) => {
      const map = (stored[STORAGE_KEY_TAB_ACTIVE] as Record<string, string> | undefined) ?? {}
      if (!(String(tabId) in map)) return
      delete map[String(tabId)]
      void chrome.storage.local.set({ [STORAGE_KEY_TAB_ACTIVE]: map })
    })
  })
}
