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
import {
  computeCacheBreakdown,
  emptyBreakdown,
  type CacheBreakdown,
} from '@/offscreen/cache-breakdown'
import { clampSettings } from '@/offscreen/settings-helpers'
import { log } from '@/shared/logger'
import type {
  Message,
  InternalRequest,
  InternalLoadRequest,
  InternalChatRequest,
  InternalAbortRequest,
  InternalSetSettingsRequest,
  InternalStatusResponse,
  DivinciExternalEvent,
} from '@/shared/messages'
import {
  STORAGE_KEY_SETTINGS,
  DEFAULT_SETTINGS,
  type UserSettings,
} from '@/shared/models'

const host = new ChatHost()

// Per-model cached-bytes breakdown. Recomputed after load-done and on
// clear-cache (via recomputeCacheBreakdown()). Read out of getStatus().
let cacheBreakdown: CacheBreakdown = emptyBreakdown()

// User-configurable inference defaults. Loaded from chrome.storage on
// startup, applied as fallbacks in handleChat when the web-app didn't
// pass an explicit value. Per-call params from chat.divinci.app always
// override these.
let userSettings: UserSettings = { ...DEFAULT_SETTINGS }

void chrome.storage.local.get(STORAGE_KEY_SETTINGS).then((stored) => {
  const saved = stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings> | undefined
  if (saved) {
    userSettings = { ...DEFAULT_SETTINGS, ...saved }
    log.info('Loaded user settings:', userSettings)
  }
})

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

/**
 * Refresh the per-model cached-bytes snapshot from Cache API. Wraps
 * the pure helper so module-level state stays write-once-per-call.
 * Cheap: reads sizes from Content-Length headers (metadata-only).
 */
async function recomputeCacheBreakdown(): Promise<void> {
  try {
    cacheBreakdown = await computeCacheBreakdown(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof caches !== 'undefined' ? (caches as any) : undefined
    )
    log.debug('cacheBreakdown updated:', cacheBreakdown)
  } catch (e) {
    log.error('recomputeCacheBreakdown failed:', e)
  }
}

// Compute once at startup so the popup's first poll has accurate data.
void recomputeCacheBreakdown()

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
    // After a successful load, the model's bytes are now in Cache API
    // (transformers.js wrote them during the fetch). Refresh the
    // breakdown so the popup reflects the new on-disk state.
    void recomputeCacheBreakdown()
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

  // Forward-compatible tool-call surface: the wire accepts `tools`, but
  // we don't yet pass it through to apply_chat_template + parse tool-call
  // output. Warn loudly so a future caller that relies on tool calls
  // doesn't silently get a tool-less response. Wire-up tracked at
  // project_browser_llm_emerging_standards.md.
  if (req.tools && req.tools.length > 0) {
    log.warn(
      `divinci:chat received ${req.tools.length} tool(s); not yet wired to the model — running plain chat`
    )
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
        // User-configurable defaults via the popup are fallbacks; per-call
        // params from chat.divinci.app override. ?? short-circuits only on
        // null/undefined (so explicit 0 still wins over the user default).
        maxNewTokens: req.maxNewTokens ?? userSettings.maxNewTokens,
        temperature: req.temperature ?? userSettings.temperature,
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

chrome.runtime.onMessage.addListener(
  (message: InternalRequest, _sender, sendResponse) => {
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
    case 'internal:status': {
      const resp: InternalStatusResponse = {
        type: 'internal:status-response',
        currentModelId: host.getCurrentModelId(),
        loadingModelId: host.getLoadingModelId(),
        isLoaded: host.isLoaded(),
        queueDepth: host.getQueueDepth(),
        loadProgress: host.getLatestProgress(),
        lastError: host.getLastError(),
        cacheBreakdown,
        settings: { ...userSettings },
      }
      sendResponse(resp)
      return true
    }
    case 'internal:unload':
      void host.dispose().catch((e) => log.error('unload failed:', e))
      break
    case 'internal:clear-cache':
      void clearAllCaches().then(() => recomputeCacheBreakdown())
      break
    case 'internal:set-settings': {
      userSettings = clampSettings(message, userSettings)
      void chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: userSettings })
      log.info('User settings updated:', userSettings)
      break
    }
  }
})

/**
 * Wipe every Cache API entry owned by this extension origin. transformers.js
 * stores model weights here on first load; without this the user has to
 * clear extension site data via chrome://extensions to reclaim disk.
 *
 * Run from the offscreen document because that's the context that owns
 * the cache entries (same as where transformers.js writes them).
 */
async function clearAllCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') {
      log.warn('caches API not available; skipping clear')
      return
    }
    const keys = await caches.keys()
    log.info(`Clearing ${keys.length} Cache API store(s):`, keys)
    await Promise.all(keys.map((k) => caches.delete(k)))
    log.info('Cache cleared')
  } catch (e) {
    log.error('Cache clear failed:', e)
  }
}

log.info('Divinci offscreen ready')
