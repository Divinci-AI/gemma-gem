import { describe, it, expect, beforeEach } from 'vitest'
import { ChromeStorageConversationBackend } from '@/chat-core/chrome-storage-conversation-backend'
import { LocalTranscriptStore } from '@/chat-core/local-transcript-store'
import type { StoredConversation } from '@/chat-core/transcript-store'

// Minimal in-memory chrome.storage.local mock (get(string) / set(obj)).
let store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
    },
  },
}

function conv(id: string): StoredConversation {
  return { id, title: id, createdAt: 1, updatedAt: 1, messages: [] }
}

describe('ChromeStorageConversationBackend', () => {
  beforeEach(() => { store = {} })

  it('put/get/getAll/delete round-trips through chrome.storage.local', async () => {
    const b = new ChromeStorageConversationBackend()
    expect(await b.getAll()).toEqual([])
    await b.put(conv('a'))
    await b.put(conv('b'))
    expect(await b.get('a')).toMatchObject({ id: 'a' })
    expect((await b.getAll()).map((c) => c.id).sort()).toEqual(['a', 'b'])
    await b.delete('a')
    expect(await b.get('a')).toBeNull()
    expect((await b.getAll()).map((c) => c.id)).toEqual(['b'])
  })

  it('persists under a single extension-global key (not page-scoped)', async () => {
    await new ChromeStorageConversationBackend().put(conv('x'))
    expect(store['divinci_conversations']).toMatchObject({ x: { id: 'x' } })
  })

  it('works end-to-end as a LocalTranscriptStore backend', async () => {
    const tStore = new LocalTranscriptStore(new ChromeStorageConversationBackend(), () => 5, () => 'id-1')
    const c = await tStore.create()
    await tStore.appendMessage(c.id, { role: 'user', content: 'hello world' })
    const got = await tStore.get(c.id)
    expect(got!.messages).toHaveLength(1)
    expect(got!.title).toBe('hello world')
  })
})
