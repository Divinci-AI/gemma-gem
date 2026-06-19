/**
 * Cloudflare Workers AI API client.
 *
 * Calls the OpenAI-compatible chat completions endpoint for models hosted
 * on Cloudflare Workers AI (e.g., Kimi K2.7-Code). This is the external
 * model that handles tool-calling rounds when Gemma 4 detects tool intent.
 *
 * Endpoint:
 *   POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions
 */

import type { ChatTool } from '@/shared/messages'
import { log } from '@/shared/logger'

// ---- Types matching the OpenAI Chat Completions shape returned by CF ----

export interface CfChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: CfToolCall[]
  /** Used for tool response messages to indicate which tool call this responds to. */
  tool_call_id?: string
  name?: string
}

export interface CfToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON-stringified arguments object. */
    arguments: string
  }
}

export interface CfToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface CfChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: CfChatMessage
    finish_reason: 'stop' | 'tool_calls' | 'length' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ---- Public API ----

export interface CfChatOptions {
  accountId: string
  apiToken: string
  model?: string
  messages: CfChatMessage[]
  tools?: CfToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
  maxTokens?: number
  temperature?: number
  /** AbortSignal for cancellation. */
  signal?: AbortSignal
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.7-code'

/**
 * Send a chat completion request to the CF Workers AI OpenAI-compatible
 * endpoint and return the parsed response.
 *
 * Throws on HTTP errors, JSON parse failures, and network errors.
 */
export async function cfChatCompletions(
  opts: CfChatOptions,
): Promise<CfChatCompletionResponse> {
  const { accountId, apiToken, messages, tools, toolChoice, signal } = opts
  const model = opts.model ?? DEFAULT_MODEL

  const url = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    stream: false,
  }

  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = toolChoice ?? 'auto'
  }

  log.info(
    `[cf-api] calling ${model} (${messages.length} messages, ${tools?.length ?? 0} tools)`,
  )

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown')
    throw new Error(
      `CF Workers AI API error ${response.status}: ${errorBody}`,
    )
  }

  const json: unknown = await response.json()
  const result = json as CfChatCompletionResponse

  if (!result.choices || result.choices.length === 0) {
    throw new Error('CF Workers AI API returned empty choices')
  }

  return result
}

/**
 * Convert our internal ChatTool array to the CF API's tool definition format.
 */
export function toCfToolDefinitions(tools: ChatTool[]): CfToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {
        type: 'object',
        properties: {} as Record<string, unknown>,
      },
    },
  }))
}
