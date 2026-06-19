/**
 * Integration tests for the chat-turn finalization / Kimi-routing decision.
 *
 * This is the glue that previously had NO coverage — and that gap hid three
 * real bugs caught in review (a compile-breaking `kimiResult.durationMs`
 * reference + nonsense duration math, raw `<|tool_call>` markup leaking to the
 * user on the un-routed path, and an un-cancellable Kimi loop). Each scenario
 * below pins one of those invariants. `runKimiLoop` is injected, so no CF /
 * web-search network and no chrome runtime are involved.
 */

import { describe, it, expect, vi } from 'vitest'
import { finalizeChatResult, type FinalizeDeps } from '@/offscreen/finalize-chat'
import type { ChatToolCall } from '@/shared/messages'

const TOOL_CALL: ChatToolCall = {
  id: 'r1-0',
  name: 'web_search',
  arguments: { query: 'weather in tokyo' },
  args: { query: 'weather in tokyo' },
}

function baseDeps(over: Partial<FinalizeDeps> = {}): FinalizeDeps {
  return {
    messages: [{ role: 'user', content: 'what is the weather in tokyo' }],
    toolCalls: [],
    gemma: { fullText: 'plain answer', tokensGenerated: 12, durationMs: 100 },
    settings: {},
    isAborted: () => false,
    onToolStatus: vi.fn(),
    ...over,
  }
}

describe('finalizeChatResult — plain chat (no tool calls)', () => {
  it('returns Gemma output verbatim and never emits a tool-status', async () => {
    const onToolStatus = vi.fn()
    const r = await finalizeChatResult(baseDeps({ onToolStatus }))
    expect(r).toEqual({
      aborted: false,
      fullText: 'plain answer',
      tokensGenerated: 12,
      durationMs: 100,
      toolCalls: undefined,
    })
    expect(onToolStatus).not.toHaveBeenCalled()
  })
})

describe('finalizeChatResult — tool calls but CF NOT configured', () => {
  it('strips tool-call envelopes from the raw Gemma text (no markup leak)', async () => {
    const runKimi = vi.fn()
    const r = await finalizeChatResult(
      baseDeps({
        toolCalls: [TOOL_CALL],
        gemma: {
          fullText: 'let me check <|tool_call>call:web_search{query:<|"|>tokyo<|"|>}<tool_call|>',
          tokensGenerated: 5,
          durationMs: 80,
        },
        settings: {}, // no cfAccountId/cfApiToken
        runKimi,
      }),
    )
    expect(r.aborted).toBe(false)
    if (r.aborted) return
    // Envelope gone; the still-tool-using turn reports its calls.
    expect(r.fullText).not.toContain('<|tool_call>')
    expect(r.fullText).toBe('let me check')
    expect(r.toolCalls).toEqual([TOOL_CALL])
    // Kimi must NOT run without credentials.
    expect(runKimi).not.toHaveBeenCalled()
  })
})

describe('finalizeChatResult — routed through Kimi', () => {
  const cfSettings = { cfAccountId: 'acct', cfApiToken: 'tok', serperApiKey: 'serp' }

  it('replaces output with Kimi answer and sums Gemma + Kimi durations', async () => {
    const runKimi = vi
      .fn()
      .mockResolvedValue({ response: 'It is 18°C and clear in Tokyo.', iterations: 2, durationMs: 250 })
    const onToolStatus = vi.fn()

    const r = await finalizeChatResult(
      baseDeps({
        toolCalls: [TOOL_CALL],
        gemma: { fullText: 'raw <|tool_call>...<tool_call|>', tokensGenerated: 9, durationMs: 100 },
        settings: cfSettings,
        runKimi,
        onToolStatus,
      }),
    )

    expect(r.aborted).toBe(false)
    if (r.aborted) return
    expect(r.fullText).toBe('It is 18°C and clear in Tokyo.')
    // Regression guard: durationMs = Gemma (100) + Kimi (250).
    expect(r.durationMs).toBe(350)
    expect(r.tokensGenerated).toBe(9)

    // routing → done lifecycle, with iteration count surfaced.
    expect(onToolStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'routing' }))
    expect(onToolStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'done', iterations: 2 }),
    )

    // The conversation + registered tools reached Kimi.
    expect(runKimi).toHaveBeenCalledTimes(1)
    const [messages, tools] = runKimi.mock.calls[0]
    expect(messages).toEqual([{ role: 'user', content: 'what is the weather in tokyo' }])
    expect(tools.map((t: { name: string }) => t.name)).toContain('web_search')
  })

  it('emits a tool-status error and falls back to Gemma output when Kimi throws', async () => {
    const runKimi = vi.fn().mockRejectedValue(new Error('CF 500'))
    const onToolStatus = vi.fn()

    const r = await finalizeChatResult(
      baseDeps({
        toolCalls: [TOOL_CALL],
        gemma: { fullText: 'fallback <|tool_call>x<tool_call|>', tokensGenerated: 3, durationMs: 70 },
        settings: cfSettings,
        runKimi,
        isAborted: () => false,
        onToolStatus,
      }),
    )

    expect(r.aborted).toBe(false)
    if (r.aborted) return
    // Not routed → envelopes stripped from the Gemma fallback.
    expect(r.fullText).toBe('fallback')
    expect(r.durationMs).toBe(70)
    expect(onToolStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', error: 'CF 500' }),
    )
  })

  it('registers an AbortController and treats a mid-loop abort as cancellation', async () => {
    let captured: AbortController | undefined
    // Kimi rejects (as an aborted fetch would) and the abort flag is set.
    const runKimi = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))

    const r = await finalizeChatResult(
      baseDeps({
        toolCalls: [TOOL_CALL],
        settings: cfSettings,
        runKimi,
        isAborted: () => true, // user hit Stop during the loop
        registerAbort: (c) => {
          captured = c
        },
      }),
    )

    expect(captured).toBeInstanceOf(AbortController)
    expect(r).toEqual({ aborted: true })
  })

  it('returns aborted (no stale answer) when Stop fires after the loop completes', async () => {
    const runKimi = vi
      .fn()
      .mockResolvedValue({ response: 'answer the user cancelled', iterations: 1, durationMs: 40 })

    const r = await finalizeChatResult(
      baseDeps({
        toolCalls: [TOOL_CALL],
        settings: cfSettings,
        runKimi,
        isAborted: () => true, // abort raced in just after Kimi resolved
      }),
    )
    expect(r).toEqual({ aborted: true })
  })
})
