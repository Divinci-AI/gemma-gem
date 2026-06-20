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

  it('prepends the system prompt to the inference messages but not to history', async () => {
    let seen: InferenceRequest | null = null
    const c = new ChatController(
      stubInference(async (req) => { seen = req; return { text: 'ok' } }),
      {},
      { systemPrompt: () => 'PAGE CONTEXT' },
    )
    await c.send('hello')
    expect(seen!.messages[0]).toEqual({ role: 'system', content: 'PAGE CONTEXT' })
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

  it('stop() aborts the in-flight request signal', async () => {
    let aborted = false
    const c = new ChatController(
      stubInference((req) => new Promise<InferenceResult>((resolve) => {
        req.signal?.addEventListener('abort', () => { aborted = true; resolve({ text: '', aborted: true }) })
      })),
    )
    const p = c.send('go')
    c.stop()
    await p
    expect(aborted).toBe(true)
  })
})
