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
  /** Emoji reactions on this message (local-first; deduped). */
  reactions?: string[]
  /** Server message id once this message has been mirrored to the account
   * AIChat — lets reactions sync to the server's emojis map. */
  serverMessageId?: string
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** The account AIChat id, set once mirrored; reuse key for the next mirror +
   * the share action. Absent = not yet mirrored (local-only). */
  serverChatId?: string
  /** The mirrored AIChat's transcript id (reference / future import). */
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
