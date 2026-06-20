/**
 * chat-core / transcript-store — conversation persistence seam (§0 foundation
 * for the §1 page-wide chat).
 *
 * One `TranscriptStore` interface, two implementations:
 *   - LocalTranscriptStore   — IndexedDB (works offline, no account).
 *   - AccountTranscriptStore — the Divinci account, via the `@divinci-ai/server`
 *     SDK `transcripts` client (list/get/create/addMessage/ingestBatch already
 *     exist — dogfood). Gated on the SDK's transcript routes becoming reachable
 *     under OAuth (today they're api-key-only mounted — see README gap #2).
 *
 * Persistence strategy (local-first, mirror-when-signed-in):
 *  - Every conversation has a stable client `id` (UUID); LocalTranscriptStore
 *    is always written.
 *  - When signed in, the same turns also write to the account; the server
 *    transcript id is stamped onto the local record (`serverTranscriptId`) so
 *    the next turn reuses it and re-imports dedupe.
 *  - Import on sign-up/sign-in: local conversations with no `serverTranscriptId`
 *    are pushed via the SDK `transcripts.ingestBatch` (whole thread, no
 *    re-inference), then stamped.
 *
 * Contract only — no IndexedDB/SDK wiring yet.
 */

import type { ChatMessage } from '@/chat-core/inference'

export interface StoredMessage extends ChatMessage {
  /** Client-generated message id. */
  id: string
  /** Epoch ms. */
  createdAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Set once mirrored/imported to the account; absent = local-only. */
  serverTranscriptId?: string
  /** How many messages have already been mirrored to the account (the dedupe
   * offset — the next mirror sends messages[mirroredCount..]). */
  mirroredCount?: number
}

export interface StoredConversation extends ConversationSummary {
  messages: StoredMessage[]
}

export interface TranscriptStore {
  /** Newest-first conversation summaries for the list rail. */
  list(): Promise<ConversationSummary[]>
  get(id: string): Promise<StoredConversation | null>
  /** Create an empty conversation with a client UUID. */
  create(init: { title?: string }): Promise<StoredConversation>
  appendMessage(id: string, message: Omit<StoredMessage, 'id' | 'createdAt'>): Promise<StoredMessage>
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
  /** Stamp the account transcript id once mirrored/imported (dedupe key). */
  setServerTranscriptId(id: string, serverTranscriptId: string): Promise<void>
}
