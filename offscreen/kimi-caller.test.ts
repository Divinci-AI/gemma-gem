import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runKimiLoop } from './kimi-caller'
import type { ChatTool } from '@/shared/messages'

const { mockCfChatCompletions, mockExecuteWebSearch } = vi.hoisted(() => ({
  mockCfChatCompletions: vi.fn(),
  mockExecuteWebSearch: vi.fn(),
}))

vi.mock('@/offscreen/cf-api', () => ({
  cfChatCompletions: (...args: unknown[]) => mockCfChatCompletions(...args),
  toCfToolDefinitions: vi.fn((tools: ChatTool[]) =>
    tools.map((t) => ({ type: 'function', function: { name: t.name } })),
  ),
}))

vi.mock('@/offscreen/web-search', () => ({
  executeWebSearch: (...args: unknown[]) => mockExecuteWebSearch(...args),
}))

const SAMPLE_TOOLS: ChatTool[] = [
  { name: 'web_search', description: 'Search the web' },
]

const SAMPLE_CREDENTIALS = {
  cfAccountId: 'test-account',
  cfApiToken: 'test-token',
}

const SAMPLE_SEARCH = {
  braveApiKey: 'brave-key',
}

const USER_MSG = 'What is the weather in Tokyo?'

function makeResponse(overrides: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; args: string }>
  finishReason?: 'stop' | 'tool_calls' | 'length'
}) {
  const tc = overrides.toolCalls?.map((t) => ({
    id: t.id,
    type: 'function' as const,
    function: { name: t.name, arguments: t.args },
  }))

  return {
    id: 'test-id',
    object: 'chat.completion',
    created: 123,
    model: 'kimi-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: overrides.content ?? null,
          tool_calls: tc,
        },
        finish_reason: overrides.finishReason ?? (tc ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

describe('runKimiLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns text response on first iteration (no tool calls)', async () => {
    mockCfChatCompletions.mockResolvedValue(
      makeResponse({ content: 'The weather in Tokyo is sunny.', finishReason: 'stop' }),
    )

    const result = await runKimiLoop(
      [{ role: 'user', content: USER_MSG }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    expect(result.response).toBe('The weather in Tokyo is sunny.')
    expect(result.iterations).toBe(1)
    expect(mockCfChatCompletions).toHaveBeenCalledTimes(1)
    expect(mockExecuteWebSearch).not.toHaveBeenCalled()
  })

  it('executes web_search tool and loops back to Kimi for final answer', async () => {
    mockCfChatCompletions
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Let me search for that.',
          toolCalls: [{ id: 'tc-1', name: 'web_search', args: '{"query":"Tokyo weather"}' }],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Tokyo weather is 72°F with light rain.',
          finishReason: 'stop',
        }),
      )

    mockExecuteWebSearch.mockResolvedValue('1. Tokyo Weather\n   URL: https://example.com\n   72°F, rain')

    const result = await runKimiLoop(
      [{ role: 'user', content: USER_MSG }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    expect(result.response).toBe('Tokyo weather is 72°F with light rain.')
    expect(result.iterations).toBe(2)
    expect(mockCfChatCompletions).toHaveBeenCalledTimes(2)
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1)
    expect(mockExecuteWebSearch).toHaveBeenCalledWith(
      { query: 'Tokyo weather', count: undefined },
      SAMPLE_SEARCH,
    )
  })

  it('handles multiple sequential tool calls in one iteration', async () => {
    mockCfChatCompletions
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Searching both queries.',
          toolCalls: [
            { id: 'tc-1', name: 'web_search', args: '{"query":"weather Tokyo"}' },
            { id: 'tc-2', name: 'web_search', args: '{"query":"weather London"}' },
          ],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Tokyo: 72°F, London: 60°F.',
          finishReason: 'stop',
        }),
      )

    mockExecuteWebSearch
      .mockResolvedValueOnce('Tokyo: 72°F')
      .mockResolvedValueOnce('London: 60°F')

    const result = await runKimiLoop(
      [{ role: 'user', content: USER_MSG }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    expect(result.response).toBe('Tokyo: 72°F, London: 60°F.')
    expect(result.iterations).toBe(2)
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2)
  })

  it('handles tool execution errors gracefully', async () => {
    mockCfChatCompletions
      .mockResolvedValueOnce(
        makeResponse({
          content: null,
          toolCalls: [{ id: 'tc-1', name: 'web_search', args: '{}' }],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: 'I received an error while searching.',
          finishReason: 'stop',
        }),
      )

    // Simulate tool execution failure
    mockExecuteWebSearch.mockRejectedValue(new Error('API timeout'))

    const result = await runKimiLoop(
      [{ role: 'user', content: USER_MSG }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    // Should have caught the error and returned an error message as tool result,
    // then Kimi's follow-up response
    expect(result.response).toBe('I received an error while searching.')
    expect(result.iterations).toBe(2)
  })

  it('handles missing query parameter in web_search', async () => {
    mockCfChatCompletions
      .mockResolvedValueOnce(
        makeResponse({
          content: null,
          toolCalls: [{ id: 'tc-1', name: 'web_search', args: '{"count":3}' }],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: 'I need a query to search.',
          finishReason: 'stop',
        }),
      )

    mockExecuteWebSearch.mockRejectedValue(new Error('should not be called'))

    const result = await runKimiLoop(
      [{ role: 'user', content: 'search' }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    // The executeTool function should catch missing query before calling executeWebSearch
    expect(result.iterations).toBe(2)
  })

  it('falls back when max iterations reached', async () => {
    // Return tool_calls for all 5 iterations (never finishing)
    for (let i = 0; i < 5; i++) {
      mockCfChatCompletions.mockResolvedValueOnce(
        makeResponse({
          content: null,
          toolCalls: [{ id: `tc-${i}`, name: 'web_search', args: `{"query":"loop ${i}"}` }],
          finishReason: 'tool_calls',
        }),
      )
    }
    mockExecuteWebSearch.mockResolvedValue('some results')

    const result = await runKimiLoop(
      [{ role: 'user', content: 'loop test' }],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
      5, // maxIterations = 5
    )

    expect(result.iterations).toBe(5)
    expect(result.response).toContain('unable to complete')
    expect(mockCfChatCompletions).toHaveBeenCalledTimes(5)
  })

  it('preserves conversation history across loop iterations (messages grow each round)', async () => {
    mockCfChatCompletions
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Let me search.',
          toolCalls: [{ id: 'tc-1', name: 'web_search', args: '{"query":"test"}' }],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: 'Final answer.',
          finishReason: 'stop',
        }),
      )

    mockExecuteWebSearch.mockResolvedValue('search result')

    const result = await runKimiLoop(
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'test query' },
      ],
      SAMPLE_TOOLS,
      SAMPLE_CREDENTIALS,
      SAMPLE_SEARCH,
    )

    expect(result.response).toBe('Final answer.')
    expect(mockCfChatCompletions).toHaveBeenCalledTimes(2)

    const call1Args = mockCfChatCompletions.mock.calls[1][0]
    expect(call1Args.messages.length).toBeGreaterThan(2)
    expect(call1Args.messages.some((m: { role: string }) => m.role === 'tool')).toBe(true)
  })
})
