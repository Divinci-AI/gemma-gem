/**
 * chat-core / IndexedDbConversationBackend — the production `ConversationBackend`
 * for LocalTranscriptStore. One object store keyed by conversation id; raw
 * IndexedDB (no dependency). Browser-only (uses the `indexedDB` global), so it
 * is NOT imported by the node-tested store logic — those tests use
 * InMemoryConversationBackend.
 */

import type { ConversationBackend } from '@/chat-core/local-transcript-store'
import type { StoredConversation } from '@/chat-core/transcript-store'

const DB_NAME = 'divinci-local-chat'
const STORE = 'conversations'
const VERSION = 1

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export class IndexedDbConversationBackend implements ConversationBackend {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.dbPromise
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open()
    return db.transaction(STORE, mode).objectStore(STORE)
  }

  async getAll(): Promise<StoredConversation[]> {
    return promisify((await this.tx('readonly')).getAll() as IDBRequest<StoredConversation[]>)
  }

  async get(id: string): Promise<StoredConversation | null> {
    const result = await promisify(
      (await this.tx('readonly')).get(id) as IDBRequest<StoredConversation | undefined>,
    )
    return result ?? null
  }

  async put(conv: StoredConversation): Promise<void> {
    await promisify((await this.tx('readwrite')).put(conv))
  }

  async delete(id: string): Promise<void> {
    await promisify((await this.tx('readwrite')).delete(id))
  }
}
