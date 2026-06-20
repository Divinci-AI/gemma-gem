/**
 * chat-core / ChromeStorageConversationBackend — `ConversationBackend` over
 * chrome.storage.local.
 *
 * Why not IndexedDB from the content script? A content script's `indexedDB` is
 * the HOST PAGE's origin database, so history would be siloed per website.
 * chrome.storage.local is the EXTENSION's storage — global across pages and
 * reachable from the SW too — so conversations are one shared history (and the
 * SW can read them for account mirroring). Conversations are small text records;
 * with the `unlimitedStorage` permission there's no quota concern.
 *
 * Stored as a single map under one key. The LocalTranscriptStore serializes its
 * writes (persistQueue), so the get→set in put/delete isn't subject to races
 * from a single consumer.
 */

import type { ConversationBackend } from '@/chat-core/local-transcript-store'
import type { StoredConversation } from '@/chat-core/transcript-store'

const KEY = 'divinci_conversations'

export class ChromeStorageConversationBackend implements ConversationBackend {
  private async readMap(): Promise<Record<string, StoredConversation>> {
    const stored = await chrome.storage.local.get(KEY)
    return (stored[KEY] as Record<string, StoredConversation> | undefined) ?? {}
  }

  private async writeMap(map: Record<string, StoredConversation>): Promise<void> {
    await chrome.storage.local.set({ [KEY]: map })
  }

  async getAll(): Promise<StoredConversation[]> {
    return Object.values(await this.readMap())
  }

  async get(id: string): Promise<StoredConversation | null> {
    return (await this.readMap())[id] ?? null
  }

  async put(conv: StoredConversation): Promise<void> {
    const map = await this.readMap()
    map[conv.id] = conv
    await this.writeMap(map)
  }

  async delete(id: string): Promise<void> {
    const map = await this.readMap()
    delete map[id]
    await this.writeMap(map)
  }
}
