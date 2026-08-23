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
import { startWakeWord, stopWakeWord } from '@/offscreen/wake-host'
import {
  computeCacheBreakdown,
  emptyBreakdown,
  type CacheBreakdown,
} from '@/offscreen/cache-breakdown'
import { clampSettings } from '@/offscreen/settings-helpers'
import { parseToolCalls } from '@/offscreen/tool-call-parser'
import { finalizeChatResult } from '@/offscreen/finalize-chat'
import { makeAccountChatRunner } from '@/offscreen/account-chat-client'
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
import { DEFAULT_SETTINGS, type UserSettings } from '@/shared/models'

const host = new ChatHost()

// Global safety net for the WebGPU/ONNX inference path. The per-request
// try/catch in handleLoad/handleChat already turns awaited failures into a
// divinci:error event; this catches anything that escapes (e.g. a rejection
// from a detached streamer microtask) so it's logged loudly instead of
// silently dying. A hard GPU-process crash kills this whole renderer and
// cannot be caught here — the SW's auto-warm crash-loop guard handles that.
self.addEventListener('unhandledrejection', (event) => {
  log.error('offscreen unhandledrejection:', (event as PromiseRejectionEvent).reason)
})
self.addEventListener('error', (event) => {
  log.error('offscreen error:', (event as ErrorEvent).message || event)
})

// Per-model cached-bytes breakdown. Recomputed after load-done and on
// clear-cache (via recomputeCacheBreakdown()). Read out of getStatus().
let cacheBreakdown: CacheBreakdown = emptyBreakdown()

// User-configurable inference defaults, applied as fallbacks in handleChat
// when the web-app didn't pass an explicit value. Per-call params from
// chat.divinci.app always override these.
//
// NOTE: offscreen documents only get `chrome.runtime` — NOT chrome.storage
// (documented MV3 limitation; touching chrome.storage here throws at init
// and prevents the onMessage listener below from ever registering, which
// made the popup show "extension idle" and the Load button do nothing).
// The SW owns persistence on our behalf: it hydrates these via an
// internal:set-settings message right after creating the offscreen, and
// writes popup-driven changes to chrome.storage. We start from defaults
// until hydrated.
let userSettings: UserSettings = { ...DEFAULT_SETTINGS }

// All chats currently in the system: queued (waiting on ChatHost.chatQueueTail)
// and running (head of the queue). Keyed by `${caller}::${requestId}` so
// handleAbort can find the right one whether it's running or still queued.
// The `aborted` flag is read by the streamer callback to suppress token
// emission, AND read at the start of runChat to short-circuit a queued
// chat that was aborted before its turn to run.
// `kimiAbort` is created lazily when a routed (Kimi) tool loop starts, so a
// mid-loop abort cancels the in-flight CF/web-search fetches instead of letting
// the loop run to completion and emit an answer the user already cancelled.
type ChatState = {
  caller: string
  requestId: string
  aborted: boolean
  kimiAbort?: AbortController
  /**
   * Cancels the GENERATION. `aborted` alone only suppressed token emission —
   * the comment above claimed a runChat short-circuit that did not exist, so
   * an aborted chat still generated to max_new_tokens with nobody listening,
   * holding the single GPU queue. ChatHost checks this signal before it starts.
   */
  genAbort: AbortController
}
const chats = new Map<string, ChatState>()
function chatKey(caller: string, requestId: string): string {
  return `${caller}::${requestId}`
}

/**
 * Render settings for logging with secrets reduced to presence booleans.
 * The CF API token and Brave/Serper keys must never hit the console — the
 * offscreen devtools console is readable by anyone with the machine.
 */
function redactSettings(s: UserSettings): Record<string, unknown> {
  return {
    temperature: s.temperature,
    maxNewTokens: s.maxNewTokens,
    hasCfAccountId: Boolean(s.cfAccountId),
    hasCfApiToken: Boolean(s.cfApiToken),
    hasBraveApiKey: Boolean(s.braveApiKey),
    hasSerperApiKey: Boolean(s.serperApiKey),
  }
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
  // Snapshot cache state BEFORE the load: if the weights are already on disk
  // this load reads from cache (no network), so the UI should say "Loading
  // from cache" not "Downloading". The breakdown is recomputed at offscreen
  // init + after every load, so it's accurate even for a freshly-recreated
  // offscreen (e.g. after a page refresh that tore down the previous one).
  const fromCache = cacheBreakdown[req.modelId]?.isCached === true
  try {
    await host.load(req.modelId, (info) => {
      emit(req.caller, {
        type: 'divinci:load-progress',
        requestId: req.requestId,
        modelId: req.modelId,
        phase: info.phase,
        fraction: info.fraction,
        bytesLoaded: info.bytesLoaded,
        bytesTotal: info.bytesTotal,
        currentFile: info.currentFile,
        fromCache,
      })
    })
    // After a successful load, the model's bytes are now in Cache API
    // (transformers.js wrote them during the fetch). Refresh the
    // breakdown so the popup reflects the new on-disk state.
    void recomputeCacheBreakdown()
    emit(req.caller, {
      type: 'divinci:load-done',
      requestId: req.requestId,
      modelId: req.modelId,
      loadTimeMs: Date.now() - start,
      fromCache,
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

  // Speculative tool-call wiring: pass the declared tools to
  // apply_chat_template and parse the model's output. Templates that
  // don't reference `tools` ignore it; Gemma 4 IS one that uses it
  // (its tokenizer_config.json includes the {%- if tools -%} branch).
  // Web app does not yet round-trip the parsed toolCalls; we surface
  // them best-effort so the wire is exercised end-to-end. See
  // project_browser_llm_emerging_standards.md.
  if (req.tools && req.tools.length > 0) {
    log.info(
      `divinci:chat forwarding ${req.tools.length} tool(s) to apply_chat_template`
    )
  }

  const state: ChatState = {
    caller: req.caller,
    requestId: req.requestId,
    aborted: false,
    genAbort: new AbortController(),
  }
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
        modelId: req.modelId,
        messages: req.messages,
        // User-configurable defaults via the popup are fallbacks; per-call
        // params from chat.divinci.app override. ?? short-circuits only on
        // null/undefined (so explicit 0 still wins over the user default).
        maxNewTokens: req.maxNewTokens ?? userSettings.maxNewTokens,
        temperature: req.temperature ?? userSettings.temperature,
        topP: req.topP,
        tools: req.tools,
        signal: state.genAbort.signal,
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
      // Best-effort tool-call extraction. Empty array on plain chat (and
      // the field is omitted on the wire by chat-done's optional shape),
      // so callers that don't care pay no cost.
      const toolCalls = req.tools && req.tools.length > 0
        ? parseToolCalls(result.fullText, req.tools, req.requestId)
        : []

      // Routing decision + finalization lives in the pure finalizeChatResult
      // helper (offscreen/finalize-chat.ts) so it's unit-testable without the
      // chrome/ChatHost stack. Here we just supply the chrome-side deps: the
      // live abort flag, the tool-status emitter, and the abort registration
      // (so handleAbort can cancel an in-flight Kimi loop).
      //
      // Account mode: when the user has signed into their Divinci account and
      // set a workspace, route tool-calls through the server proxy (server-held
      // keys) instead of the local Cloudflare/Kimi loop. The executor is the
      // SW-backed account runner; routingEnabled=true since the gate is "signed
      // in + workspace set", not local CF creds.
      const accountMode = Boolean(
        userSettings.useDivinciAccount && userSettings.divinciWorkspaceId
      )
      const finalized = await finalizeChatResult({
        messages: req.messages,
        toolCalls,
        gemma: {
          fullText: result.fullText,
          tokensGenerated: result.tokensGenerated,
          durationMs: result.durationMs,
        },
        settings: {
          cfAccountId: userSettings.cfAccountId,
          cfApiToken: userSettings.cfApiToken,
          braveApiKey: userSettings.braveApiKey,
          serperApiKey: userSettings.serperApiKey,
        },
        isAborted: () => state.aborted,
        onToolStatus: (s) => {
          emit(req.caller, {
            type: 'divinci:tool-status',
            requestId: req.requestId,
            ...s,
          })
        },
        registerAbort: (controller) => {
          state.kimiAbort = controller
        },
        runKimi: accountMode
          ? makeAccountChatRunner({
              workspaceId: userSettings.divinciWorkspaceId!,
              releaseId: userSettings.divinciReleaseId,
            })
          : undefined,
        routingEnabled: accountMode ? true : undefined,
      })

      if (finalized.aborted) {
        emit(req.caller, { type: 'divinci:aborted', requestId: req.requestId })
        return
      }

      emit(req.caller, {
        type: 'divinci:chat-done',
        requestId: req.requestId,
        fullText: finalized.fullText,
        tokensGenerated: finalized.tokensGenerated,
        durationMs: finalized.durationMs,
        toolCalls: finalized.toolCalls,
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
    // Stop a generation that has not begun (queued, or still rendering its
    // prompt). host.abort() below only reaches one that is already streaming.
    state.genAbort.abort()
    abortedAny = true
    // Cancel an in-flight Kimi tool loop (CF + web-search fetches) if one is
    // running for this chat. The Gemma generation is interrupted separately
    // via host.abort() below.
    state.kimiAbort?.abort()
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
        loadedModelIds: host.loadedModelIds(),
        activeModelId: host.getActiveModelId(),
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
      void (message.modelId
        ? host.unload(message.modelId)
        : host.unloadAll()
      ).catch((e) => log.error('unload failed:', e))
      break
    case 'internal:set-active':
      host.setActive(message.modelId)
      break
    case 'internal:clear-cache':
      void clearAllCaches().then(() => recomputeCacheBreakdown())
      break
    case 'internal:set-settings': {
      userSettings = clampSettings(message, userSettings)
      // Persistence happens in the SW — the offscreen has no chrome.storage.
      // NEVER log the raw settings object: it holds the CF API token and the
      // Brave/Serper keys, and the offscreen console is reachable via devtools.
      // Log presence metadata only (matches the monorepo PII rule).
      log.info('User settings updated:', redactSettings(userSettings))
      break
    }
  }
})

// Wake-word (Phase B0) — isolated listener so the typed InternalRequest union
// above stays untouched. The popup grants mic permission (offscreen can't
// prompt) then sends enable; detection opens the Divinci panel.
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === 'internal:wake-enable') {
    void startWakeWord().catch((e) => log.error('[wake] enable failed:', e))
  } else if (message?.type === 'internal:wake-disable') {
    void stopWakeWord().catch((e) => log.error('[wake] disable failed:', e))
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
