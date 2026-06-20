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

/**
 * Forward-compatible tool descriptor for agent-style chats. Roughly
 * matches the OpenAI / Anthropic / Hermes tool-call shape; intentionally
 * loose (parameters is JSON-schema-typed) so the wire absorbs WebMCP and
 * other emerging standards without protocol churn. Today the extension
 * accepts the field but logs a warning rather than passing it through to
 * apply_chat_template — wiring tool execution end-to-end requires the
 * web app to also handle tool-call rounds, which is not yet done.
 */
export interface ChatTool {
  name: string
  description?: string
  /** JSON-Schema-shaped parameter spec. */
  parameters?: Record<string, unknown>
}

export interface ChatToolCall {
  id: string
  name: string
  /** Canonical field; OpenAI / Hermes format. Always set by the parser. */
  arguments: Record<string, unknown>
  /**
   * Divinci Agent format alias. Some models output `args` instead of
   * `arguments` inside the JSON tool-call envelope. When set, it is
   * identical to `arguments` (the parser normalizes on write). Consumers
   * that need to round-trip the raw shape to a downstream model should
   * prefer `arguments`.
   */
  args?: Record<string, unknown>
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
  /**
   * Optional tool descriptors the model is allowed to call. Forward-
   * compatible with WebMCP / OpenAI / Anthropic / Hermes shapes.
   * Today the extension warns and ignores; wiring through to
   * transformers.js apply_chat_template + parsing tool-call output is
   * planned for a future release once the web app supports tool-call
   * rounds end-to-end.
   */
  tools?: ChatTool[]
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
  /**
   * Tool calls extracted from the model's output, when the request
   * carried `tools`. Empty/absent for plain chat. Reserved for the
   * tool-use rollout — current builds always emit `undefined`.
   */
  toolCalls?: ChatToolCall[]
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

/**
 * Tool-routing status events sent during a chat that triggers the Gemma 4
 * → Kimi K2.7-Code tool-calling pipeline.
 *
 * Sequence:
 *   1. `status: 'routing'`  — tool calls detected, routing to Kimi
 *   2. `status: 'done'`      — Kimi loop completed successfully
 *   3. `status: 'error'`     — Kimi loop failed, falling back to Gemma 4 output
 */
export interface DivinciExternalToolStatusEvent {
  type: 'divinci:tool-status'
  requestId: string
  status: 'routing' | 'done' | 'error'
  calls: Array<{ name: string; args: Record<string, unknown> }>
  iterations?: number
  error?: string
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
  | DivinciExternalToolStatusEvent

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
  /** Forward-compatible field; not yet wired to apply_chat_template. */
  tools?: ChatTool[]
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
  /** Cloudflare API credential fields; persisted in chrome.storage by the SW. */
  cfAccountId?: string
  cfApiToken?: string
  braveApiKey?: string
  serperApiKey?: string
  /** Account-mode fields (Divinci OAuth proxy). Tokens are NOT here — SW-owned. */
  useDivinciAccount?: boolean
  divinciWorkspaceId?: string
  divinciReleaseId?: string
}

// ---- Divinci account (Auth0 PKCE) protocol: popup/offscreen ↔ background SW ----

/** Popup → SW: begin an interactive Auth0 PKCE sign-in. */
export interface InternalDivinciSignInRequest {
  type: 'internal:divinci-signin'
}

/** Popup → SW: clear stored Divinci OAuth tokens. */
export interface InternalDivinciSignOutRequest {
  type: 'internal:divinci-signout'
}

/** Popup → SW: query current sign-in state. */
export interface InternalDivinciAuthStatusRequest {
  type: 'internal:divinci-auth-status'
}

/** SW → popup: sign-in state + (on success) the account email. */
export interface InternalDivinciAuthStatusResponse {
  type: 'internal:divinci-auth-status-response'
  signedIn: boolean
  email?: string
  error?: string
}

/**
 * Offscreen → SW: run a chat completion through the signed-in Divinci account.
 * The SW owns the access token (refresh-on-401) and performs the authenticated
 * fetch, so the token never reaches the offscreen document.
 */
export interface InternalAccountChatRequest {
  type: 'internal:account-chat'
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  workspaceId: string
  releaseId?: string
}

/** SW → offscreen: the account-mode completion result. */
export interface InternalAccountChatResponse {
  type: 'internal:account-chat-response'
  ok: boolean
  text?: string
  error?: string
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

// ---- Page-check protocol (content script ↔ background) ----

/**
 * Request from the sidebar/contentscript: "is this URL indexed? If not, trigger a scrape."
 */
export interface InternalPageCheckRequest {
  type: 'internal:check-page'
  url: string
}

/**
 * Page-check result sent back to the sidebar/contentscript.
 */
export interface InternalPageCheckResponse {
  type: 'internal:page-status'
  url: string
  status: 'not-configured' | 'indexed' | 'triggered' | 'error' | 'checking'
  error?: string
  crawlId?: string
}

export type InternalRequest =
  | InternalLoadRequest
  | InternalChatRequest
  | InternalAbortRequest
  | InternalStatusRequest
  | InternalUnloadRequest
  | InternalClearCacheRequest
  | InternalSetSettingsRequest
  | InternalPageCheckRequest
  | InternalDivinciSignInRequest
  | InternalDivinciSignOutRequest
  | InternalDivinciAuthStatusRequest
  | InternalAccountChatRequest

/** Offscreen-doc-emitted event. The background routes it back to `caller`. */
export interface InternalEvent {
  type: 'internal:event'
  caller: string
  event: DivinciExternalEvent
}

export type Message = InternalRequest | InternalEvent
