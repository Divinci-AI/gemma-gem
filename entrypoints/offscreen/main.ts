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

// Caller (port id) + requestId of the in-flight chat, plus a flag the
// streamer reads on each token to decide whether to suppress emission
// (used after an abort so we don't post tokens for a request the caller
// doesn't want anymore). One generation at a time: ChatHost enforces it.
let activeChat: { caller: string; requestId: string; aborted: boolean } | null = null

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

  const chatState = { caller: req.caller, requestId: req.requestId, aborted: false }
  activeChat = chatState

  try {
    const result = await host.chat(
      {
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        topP: req.topP,
      },
      (delta) => {
        if (chatState.aborted) return
        emit(req.caller, {
          type: 'divinci:chat-token',
          requestId: req.requestId,
          delta,
        })
      },
    )

    if (chatState.aborted) {
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
    if (activeChat === chatState) activeChat = null
  }
}

function handleAbort(req: InternalAbortRequest): void {
  if (!activeChat) return
  if (activeChat.caller !== req.caller) {
    log.warn('Abort from different caller ignored')
    return
  }
  // requestId === '*' is a wildcard meaning "any in-flight chat for this
  // caller". Used by the bridge on port disconnect to clean up an orphaned
  // generation when a SW eviction or web-app navigation kills the port —
  // without this match the chat keeps streaming tokens to a dead port and
  // the GPU stays busy until max_new_tokens is hit.
  if (req.requestId !== '*' && activeChat.requestId !== req.requestId) return
  activeChat.aborted = true
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
