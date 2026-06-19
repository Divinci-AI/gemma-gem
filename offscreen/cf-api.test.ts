import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cfChatCompletions, toCfToolDefinitions } from './cf-api'
import type { ChatTool } from '@/shared/messages'

// ---- toCfToolDefinitions (pure function, no mocks needed) ----

describe('toCfToolDefinitions', () => {
  it('converts a ChatTool with all fields', () => {
    const tool: ChatTool = {
      name: 'web_search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }
    const result = toCfToolDefinitions([tool])
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ])
  })

  it('supplies default parameters when ChatTool has none', () => {
    const tool: ChatTool = { name: 'noop' }
    const result = toCfToolDefinitions([tool])
    expect(result).toHaveLength(1)
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('handles empty tool array', () => {
    expect(toCfToolDefinitions([])).toEqual([])
  })

  it('maps multiple tools', () => {
    const tools: ChatTool[] = [
      { name: 'tool_a', description: 'First' },
      { name: 'tool_b', description: 'Second' },
    ]
    const result = toCfToolDefinitions(tools)
    expect(result).toHaveLength(2)
    expect(result[0].function.name).toBe('tool_a')
    expect(result[1].function.name).toBe('tool_b')
  })
})

// ---- cfChatCompletions (requires fetch mock) ----

describe('cfChatCompletions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends a valid request and returns parsed response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-1',
        object: 'chat.completion',
        created: 123456,
        model: '@cf/moonshotai/kimi-k2.7-code',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await cfChatCompletions({
      accountId: 'test-account',
      apiToken: 'test-token',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result.choices[0].message.content).toBe('Hello!')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const callUrl = mockFetch.mock.calls[0][0]
    expect(callUrl).toContain('/accounts/test-account/ai/v1/chat/completions')

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.model).toBe('@cf/moonshotai/kimi-k2.7-code')
    expect(callBody.messages).toEqual([{ role: 'user', content: 'Hi' }])
    expect(callBody.stream).toBe(false)
  })

  it('includes tools in the request body when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-2',
        object: 'chat.completion',
        created: 123457,
        model: '@cf/moonshotai/kimi-k2.7-code',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const cfTools = [
      { type: 'function' as const, function: { name: 'web_search' } },
    ]
    const result = await cfChatCompletions({
      accountId: 'a',
      apiToken: 't',
      messages: [{ role: 'user', content: 'search' }],
      tools: cfTools,
      toolChoice: 'auto',
    })

    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].message.tool_calls![0].function.name).toBe('web_search')

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.tools).toEqual(cfTools)
    expect(callBody.tool_choice).toBe('auto')
  })

  it('sends Authorization header with the API token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-3',
        object: 'chat.completion',
        created: 123458,
        model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await cfChatCompletions({
      accountId: 'acc',
      apiToken: 'secret-token',
      messages: [{ role: 'user', content: 'test' }],
    })

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer secret-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('throws on HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      cfChatCompletions({
        accountId: 'a',
        apiToken: 'bad',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow('CF Workers AI API error 401')
  })

  it('throws on empty choices response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-4',
        object: 'chat.completion',
        created: 123459,
        model: 'test',
        choices: [],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      cfChatCompletions({
        accountId: 'a',
        apiToken: 't',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow('returned empty choices')
  })

  it('respects custom model override', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-5',
        object: 'chat.completion',
        created: 123460,
        model: 'custom-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await cfChatCompletions({
      accountId: 'a',
      apiToken: 't',
      model: 'custom-model',
      messages: [{ role: 'user', content: 'x' }],
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.model).toBe('custom-model')
  })

  it('defaults to kimi-k2.7-code when no model given', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-6',
        object: 'chat.completion',
        created: 123461,
        model: '@cf/moonshotai/kimi-k2.7-code',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await cfChatCompletions({
      accountId: 'a',
      apiToken: 't',
      messages: [{ role: 'user', content: 'x' }],
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.model).toBe('@cf/moonshotai/kimi-k2.7-code')
  })
})
