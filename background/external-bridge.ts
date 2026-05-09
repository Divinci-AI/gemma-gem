/**
 * External-port bridge: connects authorized web-app origins (chat.divinci.app,
 * staging, dev, localhost) to the offscreen-document model.
 *
 * Flow per port:
 *   1. Web app calls `chrome.runtime.connect(extensionId, { name: ... })`
 *   2. We accept the port, assign it a `caller` id, register listeners
 *   3. Web app posts DivinciExternalRequest objects on the port
 *   4. We translate each into an InternalRequest and forward to the
 *      offscreen doc via chrome.runtime.sendMessage
 *   5. Offscreen emits InternalEvent envelopes back; we route the
 *      `event` payload to the matching port by `caller` id
 *
 * One offscreen doc + one ChatHost = one in-flight chat across ALL
 * connected web pages. That's intentional: GPU memory is finite, and
 * contention between two pages would just produce a worse experience
 * for both. The second concurrent caller gets a `divinci:error` with
 * "Another generation is in progress".
 */

import { ensureOffscreenDocument } from './offscreen-manager'
import { ALLOWED_WEB_APP_ORIGINS, MODELS } from '@/shared/models'
import { log } from '@/shared/logger'
import type {
  Message,
  InternalRequest,
  InternalEvent,
  DivinciExternalRequest,
  DivinciExternalEvent,
} from '@/shared/messages'

interface CallerEntry {
  port: chrome.runtime.Port
  origin: string
}

const callers = new Map<string, CallerEntry>()
let nextCallerSeq = 0

function newCallerId(origin: string): string {
  nextCallerSeq += 1
  return `c${nextCallerSeq}-${origin}`
}

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return false
  return ALLOWED_WEB_APP_ORIGINS.some((allowed) => origin === allowed)
}

function postToPort(port: chrome.runtime.Port, event: DivinciExternalEvent): void {
  try {
    port.postMessage(event)
  } catch (e) {
    log.warn('postToPort threw — port likely closed', e)
  }
}

async function handleExternalRequest(
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

export function setupExternalBridge(): void {
  // One-shot ping endpoint for capability probes. Web app uses
  // chrome.runtime.sendMessage(extensionId, {type:"divinci:ping"})
  // before opening a port, so it can decide whether to surface the
  // extension picker option without paying the port-setup cost.
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!isAllowedOrigin(sender.origin)) return
    if (msg?.type === 'divinci:ping') {
      const manifest = chrome.runtime.getManifest()
      sendResponse({
        type: 'divinci:pong',
        extensionVersion: manifest.version,
        supportedModels: Object.keys(MODELS),
      })
      return true
    }
    return undefined
  })

  chrome.runtime.onConnectExternal.addListener((port) => {
    const origin = port.sender?.origin
    if (!isAllowedOrigin(origin)) {
      log.warn('Rejecting external port from disallowed origin:', origin)
      port.disconnect()
      return
    }

    const caller = newCallerId(origin!)
    callers.set(caller, { port, origin: origin! })
    log.info('External port connected:', caller)

    port.onMessage.addListener((msg: DivinciExternalRequest) => {
      void handleExternalRequest(caller, port, msg)
    })

    port.onDisconnect.addListener(() => {
      log.info('External port disconnected:', caller)
      callers.delete(caller)
      // Best-effort: cancel any in-flight work for this caller.
      chrome.runtime
        .sendMessage({
          type: 'internal:abort',
          requestId: '*',
          caller,
        } as InternalRequest as Message)
        .catch(() => {})
    })
  })

  // Route InternalEvent envelopes from the offscreen doc back out to the
  // matching port. Internal sends from the offscreen doc come through
  // the same chrome.runtime.onMessage as everything else.
  chrome.runtime.onMessage.addListener((msg: InternalEvent) => {
    if (msg?.type !== 'internal:event') return
    const entry = callers.get(msg.caller)
    if (!entry) return // caller went away while a token was in flight
    postToPort(entry.port, msg.event)
  })
}
