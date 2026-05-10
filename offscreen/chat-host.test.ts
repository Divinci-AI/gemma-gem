/**
 * ChatHost queue + abort tests.
 *
 * Mocks the transformers.js + chrome.runtime surface so we can exercise
 * the queue logic without WebGPU. The queue is the highest-leverage piece
 * of behavior to lock down — it serializes inference across multi-tab
 * traffic and the abort plumbing depends on its scoping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Mock chrome.runtime so chat-host.ts module-init doesn't blow up ----
// (chat-host calls chrome.runtime.getURL at top-level to set ORT WASM path.)
;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
}

// ---- Mock @huggingface/transformers ----
// All we need: AutoTokenizer/AutoModelForCausalLM constructors that return
// fake instances, plus a TextStreamer + InterruptableStoppingCriteria pair.
// The real transformers.js is heavy (WASM, WebGPU); we bypass it entirely.

interface FakeStopper {
  interrupt: () => void
  interrupted: boolean
}

interface FakeModel {
  generate: (opts: {
    streamer: { callback_function: (t: string) => void }
    stopping_criteria: FakeStopper
    max_new_tokens?: number
  }) => Promise<unknown>
  dispose: () => Promise<void>
}

let fakeModel: FakeModel
let modelLoadCalled = 0
let stopperCreated = 0

function makeFakeModel(): FakeModel {
  return {
    async generate(opts) {
      // Emit tokens slowly so the test can race aborts mid-stream.
      const tokens = ['hello', ' world']
      for (const t of tokens) {
        if (opts.stopping_criteria.interrupted) break
        opts.streamer.callback_function(t)
        await new Promise((r) => setTimeout(r, 10))
      }
      return null
    },
    async dispose() {
      /* no-op */
    },
  }
}

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn(async () => ({
      apply_chat_template: vi.fn(() => ({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] })),
      all_special_ids: [],
    })),
  },
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(async () => {
      modelLoadCalled += 1
      fakeModel = makeFakeModel()
      return fakeModel
    }),
  },
  TextStreamer: vi.fn(function (this: { callback_function: (t: string) => void }, _tok: unknown, opts: { callback_function: (t: string) => void }) {
    this.callback_function = opts.callback_function
  }),
  InterruptableStoppingCriteria: vi.fn(function (this: FakeStopper) {
    stopperCreated += 1
    this.interrupted = false
    this.interrupt = () => {
      this.interrupted = true
    }
  }),
  env: { backends: { onnx: { wasm: { wasmPaths: '' } } } },
}))

// Import after mocks are registered.
const { ChatHost } = await import('./chat-host')

describe('ChatHost queue', () => {
  beforeEach(() => {
    modelLoadCalled = 0
    stopperCreated = 0
  })

  it('serializes two concurrent chats — second waits for first', async () => {
    const host = new ChatHost()
    await host.load('gemma-4-e2b')

    const order: string[] = []
    const collected: Record<string, string> = { A: '', B: '' }

    const a = host.chat({ messages: [{ role: 'user', content: 'q-A' }] }, (t) => {
      order.push(`A:${t.trim() || t}`)
      collected.A += t
    })
    const b = host.chat({ messages: [{ role: 'user', content: 'q-B' }] }, (t) => {
      order.push(`B:${t.trim() || t}`)
      collected.B += t
    })

    await Promise.all([a, b])

    // All A tokens must come before any B token (serial queue).
    const firstBIndex = order.findIndex((o) => o.startsWith('B:'))
    const lastAIndex = order.map((o, i) => (o.startsWith('A:') ? i : -1)).filter((i) => i >= 0).pop()
    expect(firstBIndex).toBeGreaterThan(lastAIndex!)
    expect(collected.A).toBe('hello world')
    expect(collected.B).toBe('hello world')
  })

  it('a thrown chat does not poison the queue — subsequent chats still run', async () => {
    const host = new ChatHost()
    await host.load('gemma-4-e2b')

    // Stub generate to throw on the first call only.
    let callIdx = 0
    vi.spyOn(fakeModel, 'generate').mockImplementation(async (opts) => {
      callIdx += 1
      if (callIdx === 1) throw new Error('first chat blew up')
      // Second call: emit normally.
      opts.streamer.callback_function('ok')
      return null
    })

    const a = host.chat({ messages: [{ role: 'user', content: 'q-A' }] }, () => undefined)
    const b = host.chat({ messages: [{ role: 'user', content: 'q-B' }] }, () => undefined).then(
      (r) => r.fullText
    )

    await expect(a).rejects.toThrow('first chat blew up')
    expect(await b).toBe('ok')
  })

  it('abort during running chat interrupts the StoppingCriteria', async () => {
    const host = new ChatHost()
    await host.load('gemma-4-e2b')

    // Make generate emit slowly so we have time to call abort mid-stream.
    vi.spyOn(fakeModel, 'generate').mockImplementation(async (opts) => {
      for (let i = 0; i < 20; i++) {
        if (opts.stopping_criteria.interrupted) return null
        opts.streamer.callback_function(`tok${i} `)
        await new Promise((r) => setTimeout(r, 5))
      }
      return null
    })

    let collected = ''
    const chatPromise = host.chat({ messages: [{ role: 'user', content: '' }] }, (t) => {
      collected += t
    })

    // Wait for at least one token, then abort.
    await new Promise((r) => setTimeout(r, 15))
    const aborted = host.abort()
    expect(aborted).toBe(true)
    await chatPromise
    // Should have stopped well before all 20 tokens.
    expect(collected.split(' ').filter(Boolean).length).toBeLessThan(20)
  })

  it('getQueueDepth tracks pending count across queued chats', async () => {
    const host = new ChatHost()
    await host.load('gemma-4-e2b')

    expect(host.getQueueDepth()).toBe(0)

    const c1 = host.chat({ messages: [{ role: 'user', content: '' }] }, () => undefined)
    // Microtask: pending should have incremented.
    expect(host.getQueueDepth()).toBeGreaterThan(0)
    const c2 = host.chat({ messages: [{ role: 'user', content: '' }] }, () => undefined)
    expect(host.getQueueDepth()).toBe(2)

    await Promise.all([c1, c2])
    expect(host.getQueueDepth()).toBe(0)
  })

  it('chat() before load() throws "Model not loaded"', async () => {
    const host = new ChatHost()
    await expect(
      host.chat({ messages: [{ role: 'user', content: '' }] }, () => undefined)
    ).rejects.toThrow('Model not loaded')
  })

  it('isLoaded returns true only after a successful load()', async () => {
    const host = new ChatHost()
    expect(host.isLoaded()).toBe(false)
    expect(host.isLoaded('gemma-4-e2b')).toBe(false)
    await host.load('gemma-4-e2b')
    expect(host.isLoaded()).toBe(true)
    expect(host.isLoaded('gemma-4-e2b')).toBe(true)
    expect(host.isLoaded('gemma-4-e4b')).toBe(false)
  })

  it('dispose() clears state — subsequent chat() throws', async () => {
    const host = new ChatHost()
    await host.load('gemma-4-e2b')
    await host.dispose()
    expect(host.isLoaded()).toBe(false)
    expect(host.getQueueDepth()).toBe(0)
    await expect(
      host.chat({ messages: [{ role: 'user', content: '' }] }, () => undefined)
    ).rejects.toThrow('Model not loaded')
  })

  // -------- Newer popup-related invariants --------

  it('latestProgress clears after a successful load', async () => {
    const host = new ChatHost()
    let captured: unknown = undefined
    await host.load('gemma-4-e2b', (info) => {
      captured = info
    })
    // Note: the mocked from_pretrained doesn't actually fire progress
    // events (we don't simulate a real download here), so latestProgress
    // never set in the first place — but the contract is "null after
    // success", regardless of whether the inner stream fired.
    expect(host.getLatestProgress()).toBeNull()
    void captured
  })

  it('latestProgress clears after a FAILED load (Bug 1 regression)', async () => {
    // Force model load to throw mid-stream after a progress event hits.
    const transformers = await import('@huggingface/transformers')
    vi.spyOn(transformers.AutoModelForCausalLM, 'from_pretrained').mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_repo: any, opts: any) => {
        // Simulate a progress event landing first…
        opts.progress_callback?.({ status: 'progress', loaded: 100, total: 1000, progress: 10, file: 'foo.onnx_data' })
        // …then the load throws.
        throw new Error('simulated network failure mid-load')
      }
    )

    const host = new ChatHost()
    await expect(host.load('gemma-4-e2b')).rejects.toThrow('simulated network failure mid-load')
    // Bug 1: previously latestProgress kept its last value after a thrown
    // load, so the popup showed a frozen progress bar forever.
    expect(host.getLatestProgress()).toBeNull()
    // lastError is populated for the popup error toast.
    expect(host.getLastError()).toContain('simulated network failure')
  })

  it('concurrent load of a DIFFERENT model rejects with a clear error', async () => {
    // Slow the first load so the second arrives while it's still in-flight.
    const transformers = await import('@huggingface/transformers')
    let resolveSlow!: () => void
    vi.spyOn(transformers.AutoModelForCausalLM, 'from_pretrained').mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => new Promise((res) => { resolveSlow = () => res({ generate: vi.fn(), dispose: vi.fn() }) })) as any
    )

    const host = new ChatHost()
    const firstLoad = host.load('gemma-4-e2b')
    // Microtask: now in-flight on E2B. Second load asks for E4B.
    await expect(host.load('gemma-4-e4b')).rejects.toThrow(
      'Already loading gemma-4-e2b; wait for it or unload first'
    )
    resolveSlow()
    await firstLoad
  })

  it('dispose() during in-flight load discards the late result (Bug 2 regression)', async () => {
    // Slow the model load so we can call dispose() while it's pending.
    const transformers = await import('@huggingface/transformers')
    let resolveLoad!: () => void
    const fakeNewModel = { generate: vi.fn(), dispose: vi.fn() }
    vi.spyOn(transformers.AutoModelForCausalLM, 'from_pretrained').mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => new Promise((res) => { resolveLoad = () => res(fakeNewModel) })) as any
    )

    const host = new ChatHost()
    const loadPromise = host.load('gemma-4-e2b')
    // Now mid-load. Dispose. Then let the load complete.
    await host.dispose()
    expect(host.isLoaded()).toBe(false)

    resolveLoad()
    await loadPromise

    // Bug 2: previously the late from_pretrained result was committed to
    // model+tokenizer+currentModelId, silently un-disposing the user's
    // explicit unload. Now generation-check rejects the late result.
    expect(host.isLoaded()).toBe(false)
    expect(host.getCurrentModelId()).toBeNull()
    // The orphaned model.dispose was called so we don't leak its session.
    expect(fakeNewModel.dispose).toHaveBeenCalled()
  })

  it('lastError clears at the start of every load() attempt (retry semantics)', async () => {
    const transformers = await import('@huggingface/transformers')
    // First call fails…
    vi.spyOn(transformers.AutoModelForCausalLM, 'from_pretrained')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementationOnce((async () => { throw new Error('first fail') }) as any)
      // …second succeeds.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementationOnce((async () => ({ generate: vi.fn(), dispose: vi.fn() })) as any)

    const host = new ChatHost()
    await expect(host.load('gemma-4-e2b')).rejects.toThrow('first fail')
    expect(host.getLastError()).toContain('first fail')
    await host.load('gemma-4-e2b')
    expect(host.getLastError()).toBeNull()
  })
})
