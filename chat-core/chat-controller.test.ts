import { describe, it, expect, vi } from 'vitest'
import { ChatController } from '@/chat-core/chat-controller'
import type { InferenceClient, InferenceRequest, InferenceResult } from '@/chat-core/inference'

/** Inference stub driven by a per-test handler. */
function stubInference(handler: (req: InferenceRequest) => Promise<InferenceResult>): InferenceClient {
  return { kind: 'local', label: 'stub', isReady: () => true, chat: vi.fn(handler) }
}

describe('ChatController', () => {
  it('runs a turn: user message → assistant message, with busy transitions', async () => {
    const events = {
      onUserMessage: vi.fn(), onAssistantStart: vi.fn(), onAssistantMessage: vi.fn(),
      onBusyChange: vi.fn(),
    }
    const c = new ChatController(stubInference(async () => ({ text: 'hello there' })), events)
    await c.send('hi')

    expect(events.onUserMessage).toHaveBeenCalledWith({ role: 'user', content: 'hi' })
    expect(events.onAssistantStart).toHaveBeenCalledOnce()
    expect(events.onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: 'hello there' })
    expect(events.onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
    expect(c.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ])
    expect(c.isBusy()).toBe(false)
  })

  it('streams token deltas through onToken', async () => {
    const onToken = vi.fn()
    const c = new ChatController(
      stubInference(async (req) => { req.onToken?.('a'); req.onToken?.('b'); return { text: 'ab' } }),
      { onToken },
    )
    await c.send('go')
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })

  it('prepends prepareTurn messages (async, query-aware) but not to history', async () => {
    let seen: InferenceRequest | null = null
    const prepareTurn = vi.fn(async (userText: string) => [
      { role: 'system' as const, content: 'PAGE CONTEXT' },
      { role: 'system' as const, content: `grounding for: ${userText}` },
    ])
    const c = new ChatController(
      stubInference(async (req) => { seen = req; return { text: 'ok' } }),
      {},
      { prepareTurn },
    )
    await c.send('hello')
    expect(prepareTurn).toHaveBeenCalledWith('hello')
    expect(seen!.messages.slice(0, 2)).toEqual([
      { role: 'system', content: 'PAGE CONTEXT' },
      { role: 'system', content: 'grounding for: hello' },
    ])
    expect(seen!.messages.at(-1)).toEqual({ role: 'user', content: 'hello' })
    expect(c.history.some((m) => m.role === 'system')).toBe(false)
  })

  it('keeps the partial text and fires onAborted when a turn is aborted', async () => {
    const onAborted = vi.fn()
    const c = new ChatController(
      stubInference(async () => ({ text: 'partial', aborted: true })),
      { onAborted },
    )
    await c.send('go')
    expect(onAborted).toHaveBeenCalledWith('partial')
    expect(c.history).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'partial' },
    ])
  })

  it('reports inference errors via onError and clears busy', async () => {
    const onError = vi.fn()
    const c = new ChatController(stubInference(async () => { throw new Error('kaboom') }), { onError })
    await c.send('go')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'kaboom' }))
    expect(c.isBusy()).toBe(false)
  })

  it('ignores blank input and rejects concurrent sends while busy', async () => {
    let resolve!: (r: InferenceResult) => void
    const c = new ChatController(stubInference(() => new Promise<InferenceResult>((r) => { resolve = r })))
    await c.send('   ') // blank → no-op
    expect(c.history).toEqual([])

    const first = c.send('one')
    await c.send('two') // busy → no-op
    expect(c.history).toEqual([{ role: 'user', content: 'one' }])
    resolve({ text: 'done' })
    await first
    expect(c.history.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('stop() during inference aborts via the request signal', async () => {
    let aborted = false
    const onAborted = vi.fn()
    const c = new ChatController(
      stubInference((req) => new Promise<InferenceResult>((resolve) => {
        if (req.signal?.aborted) { resolve({ text: '', aborted: true }); return }
        req.signal?.addEventListener('abort', () => { aborted = true; resolve({ text: 'partial', aborted: true }) })
      })),
      { onAborted },
    )
    const p = c.send('go')
    // Let send() reach inference.chat (past the prepareTurn microtask), THEN stop.
    await Promise.resolve()
    c.stop()
    await p
    expect(aborted).toBe(true)
    expect(onAborted).toHaveBeenCalledWith('partial')
  })

  it('stop() during prepareTurn skips inference and ends the turn aborted', async () => {
    const chat = vi.fn(async () => ({ text: 'should not run' }))
    const onAborted = vi.fn()
    const c = new ChatController(
      { kind: 'local', label: 'stub', isReady: () => true, chat },
      { onAborted },
      { prepareTurn: () => new Promise((r) => setTimeout(() => r([]), 5)) },
    )
    const p = c.send('go')
    c.stop() // aborts while prepareTurn's timer is pending
    await p
    expect(chat).not.toHaveBeenCalled()
    expect(onAborted).toHaveBeenCalled()
  })

  it('uses resolveTools per-turn (overrides static tools)', async () => {
    let seenTools: unknown
    const c = new ChatController(
      stubInference(async (req) => { seenTools = req.tools; return { text: 'ok' } }),
      {},
      { resolveTools: async () => [{ name: 'handoff', description: 'talk to a human' }] },
    )
    await c.send('hi')
    expect(seenTools).toEqual([{ name: 'handoff', description: 'talk to a human' }])
  })

  it('runs a bounded tool loop: tool-call → execute → feed result back → final answer', async () => {
    let hop = 0
    const chat = vi.fn(async () => {
      hop++
      return hop === 1
        ? { text: '', toolCalls: [{ id: '1', name: 'handoff', arguments: { reason: 'help' } }] }
        : { text: 'A human will reach out shortly.' }
    })
    const executeToolCalls = vi.fn(async () => 'A support agent has been notified.')
    const onToolStatus = vi.fn()
    const onAssistantMessage = vi.fn()
    const c = new ChatController(
      { kind: 'local', label: 'stub', isReady: () => true, chat },
      { onToolStatus, onAssistantMessage },
      { executeToolCalls },
    )
    await c.send('talk to a human')

    expect(chat).toHaveBeenCalledTimes(2) // initial + follow-up
    expect(executeToolCalls).toHaveBeenCalledOnce()
    expect(onToolStatus.mock.calls.map((x) => x[0].status)).toEqual(['routing', 'done'])
    expect(onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: 'A human will reach out shortly.' })
    // History carries the loop: user, assistant(toolcall), user(tool results), assistant(final).
    expect(c.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(c.history[2].content).toContain('A support agent has been notified.')
  })

  it('does not loop when executeToolCalls returns null (no matching tool)', async () => {
    const chat = vi.fn(async () => ({ text: 'hi', toolCalls: [{ id: '1', name: 'unknown', arguments: {} }] }))
    const executeToolCalls = vi.fn(async () => null)
    const onAssistantMessage = vi.fn()
    const c = new ChatController(
      { kind: 'local', label: 'stub', isReady: () => true, chat },
      { onAssistantMessage },
      { executeToolCalls },
    )
    await c.send('go')
    expect(chat).toHaveBeenCalledOnce()
    expect(onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: 'hi' })
  })

  it('caps tool hops at maxToolHops', async () => {
    const chat = vi.fn(async () => ({ text: 'loop', toolCalls: [{ id: '1', name: 'x', arguments: {} }] }))
    const executeToolCalls = vi.fn(async () => 'again')
    const c = new ChatController(
      { kind: 'local', label: 'stub', isReady: () => true, chat },
      {},
      { executeToolCalls, maxToolHops: 2 },
    )
    await c.send('go')
    // 1 initial + 2 hops = 3 inference calls, then it stops even though tools persist.
    expect(chat).toHaveBeenCalledTimes(3)
    expect(executeToolCalls).toHaveBeenCalledTimes(2)
  })
})
