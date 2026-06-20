import { describe, it, expect } from 'vitest'
import { LocalTranscriptStore, InMemoryConversationBackend } from '@/chat-core/local-transcript-store'

/** Deterministic store: monotonic clock + sequential ids. */
function makeStore() {
  let t = 1000
  let n = 0
  const store = new LocalTranscriptStore(
    new InMemoryConversationBackend(),
    () => (t += 1),
    () => `id-${++n}`,
  )
  return store
}

describe('LocalTranscriptStore', () => {
  it('creates a conversation with a generated id and default title', async () => {
    const c = await makeStore().create()
    expect(c.id).toBe('id-1')
    expect(c.title).toBe('New chat')
    expect(c.messages).toEqual([])
  })

  it('appends messages with ids/timestamps and bumps updatedAt', async () => {
    const store = makeStore()
    const conv = await store.create()
    const m = await store.appendMessage(conv.id, { role: 'user', content: 'hi there' })
    expect(m).toMatchObject({ role: 'user', content: 'hi there' })
    expect(m.id).toBeTruthy()
    const got = await store.get(conv.id)
    expect(got!.messages).toHaveLength(1)
    expect(got!.updatedAt).toBe(m.createdAt)
  })

  it('auto-titles from the first user message while untitled', async () => {
    const store = makeStore()
    const conv = await store.create()
    await store.appendMessage(conv.id, { role: 'user', content: 'How do I center a div?\nmore' })
    expect((await store.get(conv.id))!.title).toBe('How do I center a div?')
  })

  it('truncates a long auto-title', async () => {
    const store = makeStore()
    const conv = await store.create()
    await store.appendMessage(conv.id, { role: 'user', content: 'x'.repeat(100) })
    const title = (await store.get(conv.id))!.title
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBe(49)
  })

  it('does not auto-title from an assistant message', async () => {
    const store = makeStore()
    const conv = await store.create()
    await store.appendMessage(conv.id, { role: 'assistant', content: 'hello' })
    expect((await store.get(conv.id))!.title).toBe('New chat')
  })

  it('lists summaries newest-activity-first and omits messages', async () => {
    const store = makeStore()
    const a = await store.create({ title: 'A' })
    const b = await store.create({ title: 'B' })
    await store.appendMessage(a.id, { role: 'user', content: 'bump a' }) // a now newest
    const list = await store.list()
    expect(list.map((c) => c.id)).toEqual([a.id, b.id])
    expect((list[0] as unknown as Record<string, unknown>).messages).toBeUndefined()
  })

  it('renames (falling back to default on blank) and removes', async () => {
    const store = makeStore()
    const c = await store.create()
    await store.rename(c.id, '  Renamed  ')
    expect((await store.get(c.id))!.title).toBe('Renamed')
    await store.rename(c.id, '   ')
    expect((await store.get(c.id))!.title).toBe('New chat')
    await store.remove(c.id)
    expect(await store.get(c.id)).toBeNull()
  })

  it('stamps a server transcript id (import/mirror dedupe key)', async () => {
    const store = makeStore()
    const c = await store.create()
    await store.setServerTranscriptId(c.id, 'srv-123')
    expect((await store.get(c.id))!.serverTranscriptId).toBe('srv-123')
  })

  it('records mirror state (serverChatId + serverTranscriptId + mirroredCount)', async () => {
    const store = makeStore()
    const c = await store.create()
    await store.appendMessage(c.id, { role: 'user', content: 'a' })
    await store.appendMessage(c.id, { role: 'assistant', content: 'b' })
    await store.setMirrorState(c.id, { serverChatId: 'chat-9', serverTranscriptId: 'srv-9', mirroredCount: 2 })
    const got = await store.get(c.id)
    expect(got!.serverChatId).toBe('chat-9')
    expect(got!.serverTranscriptId).toBe('srv-9')
    expect(got!.mirroredCount).toBe(2)
  })

  it('toggles emoji reactions on a message (add then remove, deduped)', async () => {
    const store = makeStore()
    const c = await store.create()
    const m = await store.appendMessage(c.id, { role: 'assistant', content: 'hi' })
    expect(await store.toggleReaction(c.id, m.id, '👍')).toEqual(['👍'])
    expect(await store.toggleReaction(c.id, m.id, '❤️')).toEqual(['👍', '❤️'])
    expect(await store.toggleReaction(c.id, m.id, '👍')).toEqual(['❤️']) // toggle off
    const got = await store.get(c.id)
    expect(got!.messages[0].reactions).toEqual(['❤️'])
  })

  it('stamps server message ids onto a contiguous run from startIndex', async () => {
    const store = makeStore()
    const c = await store.create()
    const a = await store.appendMessage(c.id, { role: 'user', content: 'a' })
    const b = await store.appendMessage(c.id, { role: 'assistant', content: 'b' })
    await store.setServerMessageIds(c.id, 0, ['srv-a', 'srv-b'])
    const got = await store.get(c.id)
    expect(got!.messages.find((m) => m.id === a.id)!.serverMessageId).toBe('srv-a')
    expect(got!.messages.find((m) => m.id === b.id)!.serverMessageId).toBe('srv-b')
  })

  it('toggleReaction is a no-op for unknown conversation/message', async () => {
    const store = makeStore()
    const c = await store.create()
    expect(await store.toggleReaction('nope', 'x', '👍')).toEqual([])
    expect(await store.toggleReaction(c.id, 'nope', '👍')).toEqual([])
  })

  it('appendMessage on a missing conversation throws', async () => {
    await expect(makeStore().appendMessage('nope', { role: 'user', content: 'x' })).rejects.toThrow(/not found/)
  })

  it('isolates stored records from caller mutation', async () => {
    const store = makeStore()
    const conv = await store.create()
    conv.title = 'mutated locally'
    expect((await store.get(conv.id))!.title).toBe('New chat')
  })
})
