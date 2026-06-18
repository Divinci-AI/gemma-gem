/**
 * Internal-port bridge: connects the in-page sidebar (a content script
 * injected on every web page) to the offscreen-document model.
 *
 * This is the same-extension sibling of external-bridge.ts. The content
 * script lives inside THIS extension, so it connects via
 * `chrome.runtime.connect({ name: SIDEBAR_PORT_NAME })` and arrives on
 * `chrome.runtime.onConnect` — NOT onConnectExternal. That distinction is
 * the security boundary: onConnect only ever fires for connections from
 * our own extension contexts (content scripts, popup, options), so no
 * origin allowlist is needed here. We still gate on the port name so we
 * ignore any unrelated internal connections.
 *
 * The request-translation + offscreen forwarding is shared verbatim with
 * the external path (port-router.ts) — only the connection acceptance and
 * the caller registry are local to this file.
 *
 * Caller ids are namespaced `s<n>-sidebar` so they never collide with the
 * external bridge's `c<n>-<origin>` ids. Both bridges listen on the same
 * chrome.runtime.onMessage channel for the offscreen's internal:event
 * envelopes; each looks the caller up in its OWN registry and ignores
 * envelopes addressed elsewhere.
 */

import { log } from '@/shared/logger'
import { forwardRequest, postToPort } from './port-router'
import type {
  InternalRequest,
  InternalEvent,
  DivinciExternalRequest,
  Message,
} from '@/shared/messages'

/** Port name the sidebar content script connects with. */
export const SIDEBAR_PORT_NAME = 'divinci-sidebar'

const callers = new Map<string, chrome.runtime.Port>()
let nextCallerSeq = 0

function newCallerId(): string {
  nextCallerSeq += 1
  return `s${nextCallerSeq}-sidebar`
}

export function setupInternalBridge(): void {
  chrome.runtime.onConnect.addListener((port) => {
    // Only our sidebar uses a named internal port; ignore anything else
    // (e.g. WXT's HMR ports in dev) so we don't register phantom callers.
    if (port.name !== SIDEBAR_PORT_NAME) return

    const caller = newCallerId()
    callers.set(caller, port)
    log.info('Sidebar port connected:', caller)

    port.onMessage.addListener((msg: DivinciExternalRequest) => {
      void forwardRequest(caller, port, msg)
    })

    port.onDisconnect.addListener(() => {
      log.info('Sidebar port disconnected:', caller)
      callers.delete(caller)
      // Best-effort: cancel any in-flight generation for this caller so a
      // closed tab doesn't keep the GPU busy streaming to a dead port.
      chrome.runtime
        .sendMessage({
          type: 'internal:abort',
          requestId: '*',
          caller,
        } as InternalRequest as Message)
        .catch(() => {})
    })
  })

  // Route InternalEvent envelopes from the offscreen back to the matching
  // sidebar port. Envelopes for external (web-app) callers fall through —
  // their caller id isn't in this registry — and are handled by the
  // external bridge's own listener.
  chrome.runtime.onMessage.addListener((msg: InternalEvent) => {
    if (msg?.type !== 'internal:event') return
    const port = callers.get(msg.caller)
    if (!port) return // not ours, or the sidebar closed mid-stream
    postToPort(port, msg.event)
  })
}
