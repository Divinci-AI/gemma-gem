import { describe, it, expect, vi } from 'vitest'
import { LocalInference, type LocalTransport } from '@/chat-core/local-inference'
import type { DivinciExternalEvent, DivinciExternalRequest } from '@/shared/messages'

/** Fake transport: records sent requests, lets the test push events back. */
function fakeTransport() {
  let handler: ((ev: DivinciExternalEvent) => void) | null = null
  const sent: DivinciExternalRequest[] = []
  const transport: LocalTransport = {
    send: (r) => sent.push(r),
    subscribe: (h) => {
      handler = h
      return () => { handler = null }
    },
  }
  return { transport, sent, emit: (ev: DivinciExternalEvent) => handler?.(ev), hasHandler: () => handler !== null }
}

function makeInference(t: LocalTransport, isLoaded = true) {
  return new LocalInference(t, { modelId: 'gemma-4-e2b', label: 'Gemma 4 E2B', isLoaded: () => isLoaded })
}

describe('LocalInference', () => {
  it('isReady reflects the model-loaded getter', () => {
    expect(makeInference(fakeTransport().transport, true).isReady()).toBe(true)
    expect(makeInference(fakeTransport().transport, false).isReady()).toBe(false)
  })

  it('sends divinci:chat, streams tokens, and resolves with fullText on chat-done', async () => {
    const f = fakeTransport()
    const onToken = vi.fn()
    const p = makeInference(f.transport).chat({ messages: [{ role: 'user', content: 'hi' }], onToken })

    const chat = f.sent[0] as Extract<DivinciExternalRequest, { type: 'divinci:chat' }>
    expect(chat.type).toBe('divinci:chat')
    expect(chat.messages).toEqual([{ role: 'user', content: 'hi' }])
    const id = chat.requestId

    f.emit({ type: 'divinci:chat-token', requestId: id, delta: 'Hel' })
    f.emit({ type: 'divinci:chat-token', requestId: id, delta: 'lo' })
    f.emit({ type: 'divinci:chat-done', requestId: id, fullText: 'Hello', tokensGenerated: 2, durationMs: 7 })

    const r = await p
    expect(r).toMatchObject({ text: 'Hello', tokensGenerated: 2, durationMs: 7 })
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo'])
    expect(f.hasHandler()).toBe(false) // unsubscribed on settle
  })

  it('forwards tool-status updates', async () => {
    const f = fakeTransport()
    const onToolStatus = vi.fn()
    const p = makeInference(f.transport).chat({ messages: [], onToolStatus })
    const id = (f.sent[0] as { requestId: string }).requestId
    f.emit({ type: 'divinci:tool-status', requestId: id, status: 'routing', calls: [{ name: 'web_search', args: {} }] })
    f.emit({ type: 'divinci:chat-done', requestId: id, fullText: 'done', tokensGenerated: 0, durationMs: 0 })
    await p
    expect(onToolStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'routing' }))
  })

  it('ignores events for other request ids', async () => {
    const f = fakeTransport()
    const onToken = vi.fn()
    const p = makeInference(f.transport).chat({ messages: [], onToken })
    const id = (f.sent[0] as { requestId: string }).requestId
    f.emit({ type: 'divinci:chat-token', requestId: 'OTHER', delta: 'nope' })
    expect(onToken).not.toHaveBeenCalled()
    f.emit({ type: 'divinci:chat-done', requestId: id, fullText: 'x', tokensGenerated: 0, durationMs: 0 })
    await p
  })

  it('on abort, sends divinci:abort and resolves with the partial text', async () => {
    const f = fakeTransport()
    const ac = new AbortController()
    const p = makeInference(f.transport).chat({ messages: [], signal: ac.signal })
    const id = (f.sent[0] as { requestId: string }).requestId
    f.emit({ type: 'divinci:chat-token', requestId: id, delta: 'partial' })
    ac.abort()
    expect(f.sent.some((r) => r.type === 'divinci:abort' && (r as { requestId: string }).requestId === id)).toBe(true)
    f.emit({ type: 'divinci:aborted', requestId: id })
    expect(await p).toEqual({ text: 'partial', aborted: true })
  })

  it('rejects on a divinci:error event', async () => {
    const f = fakeTransport()
    const p = makeInference(f.transport).chat({ messages: [] })
    const id = (f.sent[0] as { requestId: string }).requestId
    f.emit({ type: 'divinci:error', requestId: id, message: 'boom', fatal: false })
    await expect(p).rejects.toThrow(/boom/)
  })
})
