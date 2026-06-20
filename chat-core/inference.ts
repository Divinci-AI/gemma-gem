/**
 * chat-core / inference — the surface-agnostic chat engine seam (§0 foundation).
 *
 * One `InferenceClient` interface, two implementations:
 *   - LocalInference   — wraps the offscreen-doc Gemma port (WebGPU).
 *   - AccountInference — the Divinci account proxy, built on the published
 *     `@divinci-ai/server` SDK (dogfood). The SDK already accepts an
 *     `accessToken` (Bearer), so AccountInference constructs
 *     `new DivinciServer({ accessToken, baseUrl })` rather than hand-rolling
 *     fetch — replacing the bespoke fetch in shared/divinci-account.ts.
 *
 * This module is the CONTRACT only (no DOM, no chrome). The sidebar, popup, the
 * planned page-wide chat, and the desktop app all consume it, so each surface
 * is a thin shell over the same engine. Implementations land as the §0
 * extraction proceeds.
 *
 * SDK gaps this design surfaces (to fill along the way — see chat-core/README):
 *  1. The SDK has NO chat-completions method. AccountInference needs one
 *     mapping to POST /api/v1/workspaces/:id/chat/completions (the OAuth tool
 *     proxy). → add `divinci.workspaces(id).chat.completions(...)` to the SDK.
 *  2. v1 transcript routes are api-key-only mounted; OAuth (logged-in user)
 *     callers can't reach them. The account TranscriptStore (transcript-store.ts)
 *     needs OAuth-accessible, workspace-scoped transcript routes.
 */

import type { ChatTool, ChatToolCall } from '@/shared/messages'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A tool-routing lifecycle update surfaced to the UI during a chat. */
export interface ToolStatusUpdate {
  status: 'routing' | 'done' | 'error'
  calls: Array<{ name: string; args: Record<string, unknown> }>
  iterations?: number
  error?: string
}

export interface InferenceRequest {
  messages: ChatMessage[]
  maxNewTokens?: number
  temperature?: number
  /** Tools the model may call (forward-compatible; see shared/messages). */
  tools?: ChatTool[]
  /** Cancel an in-flight generation/loop. */
  signal?: AbortSignal
  /** Streamed token deltas (local inference streams; account proxy may not). */
  onToken?: (delta: string) => void
  /** Tool-routing lifecycle (routing → done/error). */
  onToolStatus?: (update: ToolStatusUpdate) => void
}

export interface InferenceResult {
  /** The final assistant text. */
  text: string
  tokensGenerated?: number
  durationMs?: number
  /** Tool calls surfaced from the turn, when any. */
  toolCalls?: ChatToolCall[]
}

/**
 * A chat backend. `kind` lets the UI label/branch; `isReady` gates send
 * (model loaded for local; signed in + workspace set for account).
 */
export interface InferenceClient {
  readonly kind: 'local' | 'account'
  /** Human label, e.g. "Gemma 4 E2B" or "Divinci account". */
  readonly label: string
  /** Usable right now? (model loaded / signed in). */
  isReady(): boolean | Promise<boolean>
  /** Run one chat turn; resolves with the final assistant text. */
  chat(req: InferenceRequest): Promise<InferenceResult>
}
