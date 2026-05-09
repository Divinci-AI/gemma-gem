/**
 * Offscreen document entrypoint.
 *
 * Hosts the WebGPU model (the only place in a Chrome MV3 extension where
 * WebGPU is reliably available — service workers can't, content scripts
 * have the wrong lifetime). Listens for InternalRequest messages from
 * the background SW and emits InternalEvent messages back, which the
 * background then routes to the originating external port.
 *
 * One ChatHost singleton, one in-flight generation at a time.
 */

import { ChatHost } from '@/offscreen/chat-host'
import { log } from '@/shared/logger'
import type {
  Message,
  InternalRequest,
  InternalLoadRequest,
  InternalChatRequest,
  InternalAbortRequest,
  DivinciExternalEvent,
} from '@/shared/messages'

const host = new ChatHost()

// All chats currently in the system: queued (waiting on ChatHost.chatQueueTail)
// and running (head of the queue). Keyed by `${caller}::${requestId}` so
// handleAbort can find the right one whether it's running or still queued.
// The `aborted` flag is read by the streamer callback to suppress token
// emission, AND read at the start of runChat to short-circuit a queued
// chat that was aborted before its turn to run.
type ChatState = { caller: string; requestId: string; aborted: boolean }
const chats = new Map<string, ChatState>()
function chatKey(caller: string, requestId: string): string {
  return `${caller}::${requestId}`
}

function emit(caller: string, event: DivinciExternalEvent): void {
  const msg: Message = { type: 'internal:event', caller, event }
  chrome.runtime.sendMessage(msg).catch((e) => {
    // The background may be in the middle of a SW shutdown — it'll
    // re-spin on next message. Nothing actionable here.
    log.debug('emit() to background dropped:', e)
  })
}

async function handleLoad(req: InternalLoadRequest): Promise<void> {
  const start = Date.now()
  try {
    await host.load(req.modelId, (info) => {
      emit(req.caller, {
        type: 'divinci:load-progress',
        requestId: req.requestId,
        fraction: info.fraction,
        bytesLoaded: info.bytesLoaded,
        bytesTotal: info.bytesTotal,
        currentFile: info.currentFile,
      })
    })
    emit(req.caller, {
      type: 'divinci:load-done',
      requestId: req.requestId,
      loadTimeMs: Date.now() - start,
    })
  } catch (err) {
    emit(req.caller, {
      type: 'divinci:error',
      requestId: req.requestId,
      message: (err as Error).message ?? String(err),
      fatal: true,
    })
  }
}

async function handleChat(req: InternalChatRequest): Promise<void> {
  if (!host.isLoaded(req.modelId)) {
    emit(req.caller, {
      type: 'divinci:error',
      requestId: req.requestId,
      message: `Model ${req.modelId} not loaded — call divinci:load first`,
      fatal: false,
    })
    return
  }

  const state: ChatState = { caller: req.caller, requestId: req.requestId, aborted: false }
  const key = chatKey(req.caller, req.requestId)

  // Per-caller depth: count chats already in the system for THIS caller
  // (not global) so the queued event doesn't leak cross-caller activity.
  // Cross-origin attackers (well, our other allowed origins) shouldn't
  // be able to observe each other's chat traffic via the queue depth.
  // Compute BEFORE adding our own state so the position reflects how
  // many chats are ahead of us for this caller specifically.
  const aheadForCaller = [...chats.values()].filter((c) => c.caller === req.caller).length
  chats.set(key, state)

  if (aheadForCaller > 0) {
    emit(req.caller, {
      type: 'divinci:queued',
      requestId: req.requestId,
      position: aheadForCaller,
    })
  }

  try {
    // host.chat() handles the serial queueing across callers. We pass an
    // onToken that short-circuits if we've been aborted (so a late abort
    // doesn't leak tokens). If state.aborted is true BEFORE the model
    // starts (queued chat aborted before its turn), the streamer just
    // never fires for any tokens; the abort short-circuit also keeps any
    // late tokens out of fullText for the response event.
    const result = await host.chat(
      {
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        topP: req.topP,
      },
      (delta) => {
        if (state.aborted) return
        emit(req.caller, {
          type: 'divinci:chat-token',
          requestId: req.requestId,
          delta,
        })
      },
    )

    if (state.aborted) {
      emit(req.caller, { type: 'divinci:aborted', requestId: req.requestId })
    } else {
      emit(req.caller, {
        type: 'divinci:chat-done',
        requestId: req.requestId,
        fullText: result.fullText,
        tokensGenerated: result.tokensGenerated,
        durationMs: result.durationMs,
      })
    }
  } catch (err) {
    emit(req.caller, {
      type: 'divinci:error',
      requestId: req.requestId,
      message: (err as Error).message ?? String(err),
      fatal: false,
    })
  } finally {
    chats.delete(key)
  }
}

function handleAbort(req: InternalAbortRequest): void {
  // Wildcard match (requestId === '*') aborts every chat owned by this
  // caller. Used by the bridge on port disconnect to clean up orphaned
  // generations when a SW eviction or web-app navigation kills the port
  // — without this the chats keep streaming tokens to a dead port and
  // the GPU stays busy until max_new_tokens is hit.
  let abortedAny = false
  for (const [, state] of chats) {
    if (state.caller !== req.caller) continue
    if (req.requestId !== '*' && state.requestId !== req.requestId) continue
    state.aborted = true
    abortedAny = true
  }
  // Only interrupt the currently-running ChatHost generation if at least
  // one of the aborted chats is the one actually executing right now.
  // ChatHost.abort() interrupts whichever chat is at the head of the queue
  // — fine because queued-but-not-yet-started chats short-circuit via
  // their state.aborted flag when their turn comes.
  if (abortedAny) host.abort()
}

chrome.runtime.onMessage.addListener((message: InternalRequest) => {
  switch (message.type) {
    case 'internal:load':
      void handleLoad(message)
      break
    case 'internal:chat':
      void handleChat(message)
      break
    case 'internal:abort':
      handleAbort(message)
      break
  }
})

log.info('Divinci offscreen ready')
