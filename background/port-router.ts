/**
 * Shared port plumbing for both bridges.
 *
 * Two bridges connect callers to the offscreen-document model:
 *   - external-bridge.ts  — origin-gated web-app ports (onConnectExternal)
 *   - internal-bridge.ts  — same-extension content-script sidebar ports
 *                           (onConnect)
 *
 * The security posture differs (the external path enforces an origin
 * allowlist; the internal path is implicitly same-extension), so each
 * bridge owns its own connection acceptance + caller registry. What's
 * IDENTICAL — and therefore lives here so the two paths can't drift —
 * is how a DivinciExternalRequest is translated into an InternalRequest
 * and forwarded to the offscreen, plus the best-effort post-to-port.
 */

import { ensureOffscreenDocument } from './offscreen-manager'
import { MODELS } from '@/shared/models'
import { log } from '@/shared/logger'
import type {
  Message,
  InternalRequest,
  DivinciExternalRequest,
  DivinciExternalEvent,
} from '@/shared/messages'

/** Best-effort write to a port; a closed port throws and is swallowed. */
export function postToPort(port: chrome.runtime.Port, event: DivinciExternalEvent): void {
  try {
    port.postMessage(event)
  } catch (e) {
    log.warn('postToPort threw — port likely closed', e)
  }
}

/**
 * Translate one DivinciExternalRequest into the matching InternalRequest
 * and forward it to the offscreen document. `caller` is the bridge-assigned
 * id the offscreen stamps onto its InternalEvent replies, so each bridge's
 * event router can fan the stream back to the right port.
 *
 * Shared verbatim by the external and internal bridges — the wire contract
 * to the offscreen is the same regardless of who's calling.
 */
export async function forwardRequest(
  caller: string,
  port: chrome.runtime.Port,
  req: DivinciExternalRequest,
): Promise<void> {
  switch (req.type) {
    case 'divinci:ping': {
      const manifest = chrome.runtime.getManifest()
      postToPort(port, {
        type: 'divinci:pong',
        extensionVersion: manifest.version,
        supportedModels: Object.keys(MODELS) as Array<keyof typeof MODELS>,
      })
      return
    }

    case 'divinci:load': {
      await ensureOffscreenDocument()
      const internal: InternalRequest = {
        type: 'internal:load',
        requestId: req.requestId,
        modelId: req.modelId,
        caller,
      }
      chrome.runtime.sendMessage(internal as Message).catch((e) => {
        log.error('Failed to forward load to offscreen:', e)
        postToPort(port, {
          type: 'divinci:error',
          requestId: req.requestId,
          message: `Failed to forward load: ${(e as Error).message}`,
          fatal: true,
        })
      })
      return
    }

    case 'divinci:chat': {
      await ensureOffscreenDocument()
      const internal: InternalRequest = {
        type: 'internal:chat',
        requestId: req.requestId,
        modelId: req.modelId,
        caller,
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        topP: req.topP,
        tools: req.tools,
      }
      chrome.runtime.sendMessage(internal as Message).catch((e) => {
        log.error('Failed to forward chat to offscreen:', e)
        postToPort(port, {
          type: 'divinci:error',
          requestId: req.requestId,
          message: `Failed to forward chat: ${(e as Error).message}`,
          fatal: false,
        })
      })
      return
    }

    case 'divinci:abort': {
      const internal: InternalRequest = {
        type: 'internal:abort',
        requestId: req.requestId,
        caller,
      }
      chrome.runtime.sendMessage(internal as Message).catch((e) => {
        log.warn('Failed to forward abort:', e)
      })
      return
    }
  }
}
