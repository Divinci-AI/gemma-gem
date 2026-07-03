/**
 * Page-context inference host (iframe).
 *
 * WHY THIS EXISTS: the MV3 offscreen document can't run WebGPU model inference
 * in the current Chrome — loads/generates hang, the event loop blocks on a
 * WASM-CPU fallback (proven live: a single LFM2.5 hangs in the offscreen, abort
 * fails, the watchdog can't even fire). But a chrome-extension IFRAME framed
 * inside a normal web page IS a real page context with working GPU — the
 * robot.html iframe already runs three.js/WebGL there, and Phase 0 proved
 * LFM2.5 generates in ~200ms here. So on-device inference for the in-page dock
 * runs HERE instead of the offscreen.
 *
 * TRANSPORT: the content script posts `{ __divinciReq, req, statusId? }` (a
 * DivinciExternalRequest, or an internal:status/unload/set-active/set-settings
 * request) to this iframe's window; we run it against a ChatHost and post
 * `{ __divinciInference, event }` (a DivinciExternalEvent) or, for status,
 * `{ __divinciInference, statusResponse, statusId }` back to window.parent.
 * No caller-routing (single consumer, this page's dock) and — unlike the
 * offscreen — no account/tool finalize layer: local models generate locally.
 * Account (Kimi) routing stays on the SW/offscreen path for now.
 *
 * Unlike the offscreen, an iframe extension page DOES have chrome.storage, so we
 * hydrate the user's inference defaults directly.
 */
import { ChatHost } from '@/offscreen/chat-host'
import { emptyBreakdown } from '@/offscreen/cache-breakdown'
import { log } from '@/shared/logger'
import type { DivinciExternalEvent, InternalStatusResponse } from '@/shared/messages'
import { DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS, type UserSettings } from '@/shared/models'

const host = new ChatHost()
let userSettings: UserSettings = { ...DEFAULT_SETTINGS }

// Minimal shape of what the content script posts in. Spans the dock's
// DivinciExternalRequest (divinci:load/chat/abort) plus the internal:* control
// messages; typed loosely + narrowed per-case to avoid threading two request
// unions through here.
interface IncomingReq {
  type: string
  requestId?: string
  modelId?: string
  messages?: { role: string; content: string }[]
  maxNewTokens?: number
  temperature?: number
  topP?: number
  tools?: unknown[]
  [k: string]: unknown
}

// Hydrate inference defaults (maxNewTokens/temperature) from storage; unlike the
// offscreen, an iframe extension page has chrome.storage. Best-effort.
try {
  chrome.storage?.local.get(STORAGE_KEY_SETTINGS, (res) => {
    const s = res?.[STORAGE_KEY_SETTINGS]
    if (s && typeof s === 'object') userSettings = { ...userSettings, ...(s as Partial<UserSettings>) }
  })
} catch {
  /* no storage — keep defaults */
}

self.addEventListener('unhandledrejection', (e) =>
  log.error('inference-host unhandledrejection:', (e as PromiseRejectionEvent).reason),
)

/** Post a streamed event back to the content-script parent. */
function emit(event: DivinciExternalEvent): void {
  try {
    window.parent.postMessage({ __divinciInference: true, event }, '*')
  } catch (e) {
    log.debug('inference emit dropped:', e)
  }
}

/** Chats currently tracked, keyed by requestId, so abort can flag the right one. */
const chats = new Map<string, { aborted: boolean }>()

async function handleLoad(req: IncomingReq): Promise<void> {
  const requestId = req.requestId ?? ''
  const modelId = req.modelId as Parameters<ChatHost['load']>[0]
  const start = Date.now()
  try {
    await host.load(modelId, (info) => {
      emit({
        type: 'divinci:load-progress',
        requestId,
        modelId,
        fraction: info.fraction,
        bytesLoaded: info.bytesLoaded,
        bytesTotal: info.bytesTotal,
        currentFile: info.currentFile,
        fromCache: false,
      })
    })
    emit({ type: 'divinci:load-done', requestId, modelId, loadTimeMs: Date.now() - start, fromCache: false })
  } catch (err) {
    emit({ type: 'divinci:error', requestId, message: (err as Error)?.message ?? String(err), fatal: true })
  }
}

async function handleChat(req: IncomingReq): Promise<void> {
  const requestId = req.requestId ?? ''
  const modelId = req.modelId as Parameters<ChatHost['chat']>[0]['modelId']
  if (!host.isLoaded(modelId)) {
    emit({
      type: 'divinci:error',
      requestId,
      message: `Model ${String(modelId)} not loaded — call divinci:load first`,
      fatal: false,
    })
    return
  }
  const state = { aborted: false }
  chats.set(requestId, state)
  try {
    const result = await host.chat(
      {
        modelId,
        messages: req.messages as Parameters<ChatHost['chat']>[0]['messages'],
        maxNewTokens: req.maxNewTokens ?? userSettings.maxNewTokens,
        temperature: req.temperature ?? userSettings.temperature,
        topP: req.topP,
        tools: req.tools as Parameters<ChatHost['chat']>[0]['tools'],
      },
      (delta) => {
        if (state.aborted) return
        emit({ type: 'divinci:chat-token', requestId, delta })
      },
    )
    if (state.aborted) emit({ type: 'divinci:aborted', requestId })
    else
      emit({
        type: 'divinci:chat-done',
        requestId,
        fullText: result.fullText,
        tokensGenerated: result.tokensGenerated,
        durationMs: result.durationMs,
      })
  } catch (err) {
    emit({ type: 'divinci:error', requestId, message: (err as Error)?.message ?? String(err), fatal: false })
  } finally {
    chats.delete(requestId)
  }
}

function handleAbort(req: IncomingReq): void {
  let any = false
  for (const [id, state] of chats) {
    if (req.requestId !== '*' && id !== req.requestId) continue
    state.aborted = true
    any = true
  }
  if (any) host.abort()
}

function statusResponse(): InternalStatusResponse {
  return {
    type: 'internal:status-response',
    currentModelId: host.getCurrentModelId(),
    loadedModelIds: host.loadedModelIds(),
    activeModelId: host.getActiveModelId(),
    loadingModelId: host.getLoadingModelId(),
    isLoaded: host.isLoaded(),
    queueDepth: host.getQueueDepth(),
    loadProgress: host.getLatestProgress(),
    lastError: host.getLastError(),
    cacheBreakdown: emptyBreakdown(),
    settings: { ...userSettings },
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { __divinciReq?: boolean; req?: IncomingReq; statusId?: string } | null
  if (!data || !data.__divinciReq || !data.req) return
  const req = data.req
  // Diagnostic ack: prove parent→iframe sends arrive.
  try {
    window.parent.postMessage({ __divinciInference: true, ack: req.type }, '*')
  } catch {
    /* parent gone */
  }
  switch (req.type) {
    case 'divinci:load':
      void handleLoad(req)
      break
    case 'divinci:chat':
      void handleChat(req)
      break
    case 'divinci:abort':
      handleAbort(req)
      break
    case 'internal:status':
      try {
        window.parent.postMessage(
          { __divinciInference: true, statusResponse: statusResponse(), statusId: data.statusId },
          '*',
        )
      } catch {
        /* parent gone */
      }
      break
    case 'internal:unload':
      void (req.modelId
        ? host.unload(req.modelId as Parameters<ChatHost['unload']>[0])
        : host.unloadAll()
      ).catch((err) => log.error('inference unload failed:', err))
      break
    case 'internal:set-active':
      if (req.modelId) host.setActive(req.modelId as Parameters<ChatHost['setActive']>[0])
      break
    case 'internal:set-settings': {
      const { maxNewTokens, temperature } = req
      if (typeof maxNewTokens === 'number') userSettings = { ...userSettings, maxNewTokens }
      if (typeof temperature === 'number') userSettings = { ...userSettings, temperature }
      break
    }
  }
})

// Announce readiness so the content script can flush any queued requests.
try {
  window.parent.postMessage({ __divinciInference: true, ready: true }, '*')
} catch {
  /* parent gone */
}
log.info('Divinci inference host (iframe) ready')
