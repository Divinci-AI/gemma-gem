/**
 * chat-core / LocalTranscriptStore — `TranscriptStore` backed by an injectable
 * async key-value backend (§1 persistence).
 *
 * The CRUD/ordering/title logic lives here and is fully unit-testable in node
 * via `InMemoryConversationBackend`. The extension uses
 * `IndexedDbConversationBackend` (idb-conversation-backend.ts). An
 * `AccountTranscriptStore` (SDK-backed) will mirror this once the OAuth
 * transcript gaps are filled — see chat-core/README.
 */

import type {
  TranscriptStore,
  StoredConversation,
  StoredMessage,
  ConversationSummary,
} from '@/chat-core/transcript-store'

/** A conversation-record backend (one record per conversation, keyed by id). */
export interface ConversationBackend {
  getAll(): Promise<StoredConversation[]>
  get(id: string): Promise<StoredConversation | null>
  put(conv: StoredConversation): Promise<void>
  delete(id: string): Promise<void>
}

const DEFAULT_TITLE = 'New chat'

/** First line of the first user message, trimmed to a tab-friendly length. */
function deriveTitle(content: string): string {
  const firstLine = content.trim().split('\n')[0]?.trim() ?? ''
  if (!firstLine) return DEFAULT_TITLE
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine
}

export class LocalTranscriptStore implements TranscriptStore {
  constructor(
    private readonly backend: ConversationBackend,
    // Injected for deterministic tests.
    private readonly now: () => number = () => Date.now(),
    private readonly genId: () => string = () => crypto.randomUUID(),
  ) {}

  async list(): Promise<ConversationSummary[]> {
    const all = await this.backend.getAll()
    return all
      .map(({ messages: _messages, ...summary }) => summary)
      .sort((a, b) => b.updatedAt - a.updatedAt) // newest activity first
  }

  async get(id: string): Promise<StoredConversation | null> {
    return this.backend.get(id)
  }

  async create(init: { title?: string } = {}): Promise<StoredConversation> {
    const ts = this.now()
    const conv: StoredConversation = {
      id: this.genId(),
      title: init.title ?? DEFAULT_TITLE,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
    }
    await this.backend.put(conv)
    return conv
  }

  async appendMessage(
    id: string,
    message: Omit<StoredMessage, 'id' | 'createdAt'>,
  ): Promise<StoredMessage> {
    const conv = await this.backend.get(id)
    if (!conv) throw new Error(`conversation ${id} not found`)
    const stored: StoredMessage = { ...message, id: this.genId(), createdAt: this.now() }
    conv.messages.push(stored)
    conv.updatedAt = stored.createdAt
    // Auto-title from the first user message while still untitled.
    if (conv.title === DEFAULT_TITLE && message.role === 'user') {
      conv.title = deriveTitle(message.content)
    }
    await this.backend.put(conv)
    return stored
  }

  async rename(id: string, title: string): Promise<void> {
    const conv = await this.backend.get(id)
    if (!conv) return
    conv.title = title.trim() || DEFAULT_TITLE
    conv.updatedAt = this.now()
    await this.backend.put(conv)
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id)
  }

  async setServerTranscriptId(id: string, serverTranscriptId: string): Promise<void> {
    const conv = await this.backend.get(id)
    if (!conv) return
    conv.serverTranscriptId = serverTranscriptId
    await this.backend.put(conv)
  }

  /** Record account-mirror progress (server transcript id + dedupe offset). */
  async setMirrorState(
    id: string,
    state: { serverTranscriptId: string; mirroredCount: number },
  ): Promise<void> {
    const conv = await this.backend.get(id)
    if (!conv) return
    conv.serverTranscriptId = state.serverTranscriptId
    conv.mirroredCount = state.mirroredCount
    await this.backend.put(conv)
  }
}

/**
 * In-memory backend — for tests and as the reference implementation. Clones on
 * read/write so callers can't mutate stored records by reference (mirrors the
 * IndexedDB structured-clone boundary).
 */
export class InMemoryConversationBackend implements ConversationBackend {
  private readonly map = new Map<string, StoredConversation>()

  async getAll(): Promise<StoredConversation[]> {
    return [...this.map.values()].map((c) => structuredClone(c))
  }
  async get(id: string): Promise<StoredConversation | null> {
    const c = this.map.get(id)
    return c ? structuredClone(c) : null
  }
  async put(conv: StoredConversation): Promise<void> {
    this.map.set(conv.id, structuredClone(conv))
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id)
  }
}
