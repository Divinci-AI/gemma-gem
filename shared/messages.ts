/**
 * Message protocol for the Divinci Local Inference extension.
 *
 * Three runtime contexts talk through these messages:
 *
 *   Web app  ───(externally_connectable port)───►  Background SW
 *                                                       │
 *                                                       ▼
 *                                                 Offscreen doc
 *                                                 (WebGPU + model)
 *
 * The web-app-facing protocol (DivinciExternal*) is the contract
 * the chat.divinci.app `ExtensionTransport` class is built against;
 * the internal protocol (Internal*) lives inside the extension only.
 *
 * Naming: `*Request` → main thread → worker direction; `*Event` →
 * worker → main direction. Each request carries a `requestId` so
 * streaming events can be correlated with the call that produced them.
 */

import type { ModelId } from './models'

// ---- External protocol (web app ↔ extension via externally_connectable) ----

export interface DivinciExternalPing {
  type: 'divinci:ping'
  /** Web app version, for debugging compatibility issues. */
  clientVersion?: string
}

export interface DivinciExternalPong {
  type: 'divinci:pong'
  extensionVersion: string
  supportedModels: ModelId[]
}

export interface DivinciExternalLoadRequest {
  type: 'divinci:load'
  requestId: string
  modelId: ModelId
}

export interface DivinciExternalChatRequest {
  type: 'divinci:chat'
  requestId: string
  modelId: ModelId
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** Hard cap on tokens to generate. */
  maxNewTokens?: number
  /** Sampling temperature; 0 disables. */
  temperature?: number
  topP?: number
}

export interface DivinciExternalAbortRequest {
  type: 'divinci:abort'
  requestId: string
}

export type DivinciExternalRequest =
  | DivinciExternalPing
  | DivinciExternalLoadRequest
  | DivinciExternalChatRequest
  | DivinciExternalAbortRequest

// ---- Events sent back over the same port ----

export interface DivinciExternalLoadProgressEvent {
  type: 'divinci:load-progress'
  requestId: string
  fraction: number | null
  bytesLoaded: number
  bytesTotal: number | null
  currentFile?: string
}

/**
 * Sent when a chat is enqueued behind another chat (multi-tab fairness).
 * Position 0 means "next up"; position N means "N chats ahead of you".
 * Optional — only fired when getQueueDepth() > 1 at submit time.
 */
export interface DivinciExternalQueuedEvent {
  type: 'divinci:queued'
  requestId: string
  position: number
}

export interface DivinciExternalLoadDoneEvent {
  type: 'divinci:load-done'
  requestId: string
  loadTimeMs: number
}

export interface DivinciExternalChatTokenEvent {
  type: 'divinci:chat-token'
  requestId: string
  delta: string
}

export interface DivinciExternalChatDoneEvent {
  type: 'divinci:chat-done'
  requestId: string
  fullText: string
  tokensGenerated: number
  durationMs: number
}

export interface DivinciExternalAbortedEvent {
  type: 'divinci:aborted'
  requestId: string
}

export interface DivinciExternalErrorEvent {
  type: 'divinci:error'
  requestId?: string
  message: string
  fatal: boolean
}

export type DivinciExternalEvent =
  | DivinciExternalPong
  | DivinciExternalLoadProgressEvent
  | DivinciExternalLoadDoneEvent
  | DivinciExternalQueuedEvent
  | DivinciExternalChatTokenEvent
  | DivinciExternalChatDoneEvent
  | DivinciExternalAbortedEvent
  | DivinciExternalErrorEvent

// ---- Internal protocol (background ↔ offscreen, one Chrome runtime hop) ----

export interface InternalLoadRequest {
  type: 'internal:load'
  requestId: string
  modelId: ModelId
  /** Caller (port id) that should receive progress + done events. */
  caller: string
}

export interface InternalChatRequest {
  type: 'internal:chat'
  requestId: string
  modelId: ModelId
  caller: string
  messages: DivinciExternalChatRequest['messages']
  maxNewTokens?: number
  temperature?: number
  topP?: number
}

export interface InternalAbortRequest {
  type: 'internal:abort'
  requestId: string
  caller: string
}

/**
 * Same-origin status query (used by the popup UI). Not exposed over
 * externally_connectable; the popup talks directly to the offscreen via
 * chrome.runtime.sendMessage.
 */
export interface InternalStatusRequest {
  type: 'internal:status'
}

export interface InternalStatusResponse {
  type: 'internal:status-response'
  currentModelId: ModelId | null
  /** Model id of the in-flight load, if any. null when not loading. */
  loadingModelId: ModelId | null
  isLoaded: boolean
  queueDepth: number
  /** Currently downloading file path + bytes (when not idle), for the popup. */
  loadProgress: {
    fraction: number | null
    bytesLoaded: number
    bytesTotal: number | null
    currentFile?: string
  } | null
  /**
   * Last load error message, or null. Cleared on next successful load
   * or on dispose. Popup uses this to render an error toast.
   */
  lastError: string | null
  /**
   * Per-model breakdown of cached bytes on disk. `bytes` is the sum of
   * Cache API blob sizes whose URLs match the model's HF repo. `isCached`
   * is true when bytes > 0 — i.e. a future load() will be fast (cache
   * hit) rather than re-downloading. Populated lazily by the offscreen
   * (recomputed after load-done and clear-cache events).
   */
  cacheBreakdown: Record<ModelId, { isCached: boolean; bytes: number }>
  /** Current user-configurable defaults; web-app params override these per-call. */
  settings: {
    temperature: number
    maxNewTokens: number
  }
}

/**
 * Same-origin: persist user-configurable inference defaults. Applied at
 * the offscreen handleChat layer as fallbacks when the web-app doesn't
 * pass a value (web-app per-call value always wins).
 */
export interface InternalSetSettingsRequest {
  type: 'internal:set-settings'
  temperature?: number
  maxNewTokens?: number
}

/**
 * Same-origin unload request from the popup. Drops the model from VRAM.
 * Doesn't clear the on-disk Cache API entries — model bytes survive for
 * the next load. To reclaim disk, send InternalClearCacheRequest.
 */
export interface InternalUnloadRequest {
  type: 'internal:unload'
}

/**
 * Same-origin disk-cache wipe from the popup. Iterates caches.keys()
 * inside the offscreen document and deletes every entry the extension
 * owns — chiefly the ~3 GB of model weights transformers.js cached on
 * first load. Surviving an unload is by-design; this clears the bytes
 * so a future load re-downloads from HuggingFace.
 */
export interface InternalClearCacheRequest {
  type: 'internal:clear-cache'
}

export type InternalRequest =
  | InternalLoadRequest
  | InternalChatRequest
  | InternalAbortRequest
  | InternalStatusRequest
  | InternalUnloadRequest
  | InternalClearCacheRequest
  | InternalSetSettingsRequest

/** Offscreen-doc-emitted event. The background routes it back to `caller`. */
export interface InternalEvent {
  type: 'internal:event'
  caller: string
  event: DivinciExternalEvent
}

export type Message = InternalRequest | InternalEvent
