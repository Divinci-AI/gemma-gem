/**
 * Kimi K2.7-Code tool-calling loop.
 *
 * When Gemma 4 detects tool intent in its output, we route the
 * conversation to Kimi K2.7-Code (hosted on Cloudflare Workers AI).
 * Kimi decides which tool to call, the extension executes it (web
 * search), and the results feed back into the loop until Kimi
 * produces a final text response.
 *
 * This mirrors the server-side runToolLoop() pattern from the Divinci
 * app but runs in the extension's offscreen document.
 */

import { log } from '@/shared/logger'
import type { ChatTool } from '@/shared/messages'
import {
  cfChatCompletions,
  toCfToolDefinitions,
  type CfChatMessage,
  type CfToolCall,
} from '@/offscreen/cf-api'
import { executeWebSearch, type WebSearchProvider } from '@/offscreen/web-search'
import { REGISTERED_TOOLS } from '@/shared/tool-definitions'

// ---- Configuration ----

export interface KimiCredentials {
  cfAccountId: string
  cfApiToken: string
}

export type ToolExecutor = (
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
) => Promise<string>

/**
 * Convert the extension's internal message format (from DivinciExternalChatRequest)
 * to the CF API message format needed by Kimi.
 */
function toKimiMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): CfChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}

/**
 * Execute a tool call by name. Returns a plain-text result string.
 * Returns an error message if the tool is unknown or execution fails,
 * so the model can interpret failures gracefully.
 */
async function executeTool(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  webSearchProvider: WebSearchProvider,
): Promise<string> {
  const { name } = toolCall

  switch (name) {
    case 'web_search': {
      const args = toolCall.arguments as { query?: string; count?: number }
      if (!args.query || typeof args.query !== 'string') {
        return 'Error: web_search requires a "query" string parameter.'
      }
      return await executeWebSearch(
        { query: args.query, count: args.count },
        webSearchProvider,
      )
    }
    default:
      return `Error: Unknown tool "${name}". Available tools: ${REGISTERED_TOOLS.map((t) => t.name).join(', ')}.`
  }
}

/**
 * Run the Kimi K2.7-Code tool-calling loop.
 *
 * 1. Send conversation + tool definitions to Kimi
 * 2. Kimi responds with text and/or tool_calls
 * 3. If tool_calls → execute each tool → add results as tool messages → repeat
 * 4. If text → return it as the final answer
 *
 * @param messages    Original conversation messages (system + user + assistant)
 * @param tools       Tool definitions to register with Kimi
 * @param credentials Cloudflare account ID + API token
 * @param maxIterations  Safety cap on tool loop iterations (default: 5)
 * @returns           Kimi's final text response
 */
export async function runKimiLoop(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tools: ChatTool[],
  credentials: KimiCredentials,
  webSearchProvider: WebSearchProvider,
  maxIterations = 5,
  signal?: AbortSignal,
): Promise<{ response: string; iterations: number; durationMs: number }> {
  const start = Date.now()
  const kimiMessages: CfChatMessage[] = toKimiMessages(messages)
  const toolDefinitions = toCfToolDefinitions(tools)

  let iteration = 0

  while (iteration < maxIterations) {
    if (signal?.aborted) throw new DOMException('Kimi loop aborted', 'AbortError')
    iteration++
    log.info(`[kimi] Iteration ${iteration}/${maxIterations}`)

    const response = await cfChatCompletions({
      accountId: credentials.cfAccountId,
      apiToken: credentials.cfApiToken,
      messages: kimiMessages,
      tools: toolDefinitions,
      toolChoice: 'auto',
      maxTokens: 1024,
      temperature: 0.7,
      signal,
    })

    const choice = response.choices[0]
    const msg = choice.message

    // If there are no tool calls, we're done — return the text.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const finalText = msg.content ?? ''
      log.info(`[kimi] Finished after ${iteration} iteration(s)`)
      return { response: finalText, iterations: iteration, durationMs: Date.now() - start }
    }

    // Append the assistant message WITH tool_calls to the conversation.
    kimiMessages.push({
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    })

    // Execute each tool call and add results as tool role messages.
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        args = { _rawArgs: tc.function.arguments }
      }

      log.info(`[kimi] Executing tool: ${tc.function.name}`, args)

      let result: string
      try {
        result = await executeTool(
          { id: tc.id, name: tc.function.name, arguments: args },
          webSearchProvider,
        )
      } catch (err) {
        result = `Error executing ${tc.function.name}: ${(err as Error).message ?? String(err)}`
        log.error(`[kimi] Tool ${tc.function.name} execution failed:`, err)
      }

      // SECURITY (prompt injection): `result` is untrusted web content
      // (Brave/Serper snippets) fed back into the model conversation. A
      // malicious page could embed instructions to steer Kimi. Blast radius
      // is currently bounded because `web_search` is the ONLY registered tool
      // — the worst case is a wasted extra search, no side effects. BEFORE
      // adding any side-effecting tool (email/calendar/fetch-url/file write),
      // isolate or sanitize tool-result content so injected text can't
      // trigger a destructive call. See REGISTERED_TOOLS in tool-definitions.ts.
      kimiMessages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
        name: tc.function.name,
      })
    }
  }

  // If we hit maxIterations without an answer, return a fallback.
  log.warn(`[kimi] Hit max iterations (${maxIterations}) without final answer`)
  return {
    response:
      'I was unable to complete the search in the allowed number of steps. Please try a more specific query.',
    iterations: iteration,
    durationMs: Date.now() - start,
  }
}
