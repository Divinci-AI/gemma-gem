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

export type InternalRequest = InternalLoadRequest | InternalChatRequest | InternalAbortRequest

/** Offscreen-doc-emitted event. The background routes it back to `caller`. */
export interface InternalEvent {
  type: 'internal:event'
  caller: string
  event: DivinciExternalEvent
}

export type Message = InternalRequest | InternalEvent
