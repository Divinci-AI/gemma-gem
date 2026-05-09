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

// Caller (port id) -> in-flight requestId map. Used so an `internal:abort`
// from a different caller doesn't accidentally cancel someone else's chat.
let activeChat: { caller: string; requestId: string } | null = null

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
  if (activeChat) {
    emit(req.caller, {
      type: 'divinci:error',
      requestId: req.requestId,
      message: 'Another generation is in progress',
      fatal: false,
    })
    return
  }

  activeChat = { caller: req.caller, requestId: req.requestId }
  let aborted = false

  try {
    const result = await host.chat(
      {
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        topP: req.topP,
      },
      (delta) => {
        if (aborted) return
        emit(req.caller, {
          type: 'divinci:chat-token',
          requestId: req.requestId,
          delta,
        })
      },
    )

    if (aborted) {
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
    activeChat = null
  }

  // Track abort intent so the streamer callback short-circuits.
  // We can't return early from the await above; just suppress further
  // events.
  function setAborted() {
    aborted = true
  }
  // Expose to the abort handler below.
  ;(globalThis as unknown as { __setAborted: () => void }).__setAborted = setAborted
}

function handleAbort(req: InternalAbortRequest): void {
  if (!activeChat || activeChat.requestId !== req.requestId) return
  if (activeChat.caller !== req.caller) {
    log.warn('Abort from different caller ignored')
    return
  }
  ;(globalThis as unknown as { __setAborted?: () => void }).__setAborted?.()
  host.abort()
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
