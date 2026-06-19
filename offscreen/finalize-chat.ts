/**
 * Pure finalization logic for a chat turn that MAY route to the Kimi
 * tool loop. Extracted from the offscreen entrypoint (`entrypoints/offscreen/
 * main.ts`) so the routing decision — the part that decides whether to call
 * Kimi, how to compute the combined duration, when to strip tool-call
 * envelopes, and how to honor a mid-loop abort — is testable WITHOUT booting
 * the full chrome runtime + ChatHost + WebGPU stack.
 *
 * Same precedent as `settings-helpers.ts`. This module owns the decisions;
 * `main.ts` owns the chrome plumbing (emit, abort flag, settings state).
 */

import { stripToolCallEnvelopes } from '@/offscreen/tool-call-parser'
import { runKimiLoop } from '@/offscreen/kimi-caller'
import { REGISTERED_TOOLS } from '@/shared/tool-definitions'
import type { ChatToolCall } from '@/shared/messages'
import type { UserSettings } from '@/shared/models'

/** The raw Gemma 4 generation result, before any tool routing. */
export interface GemmaChatResult {
  fullText: string
  tokensGenerated: number
  durationMs: number
}

/** Payload for a `divinci:tool-status` event (sans transport fields). */
export interface ToolStatusUpdate {
  status: 'routing' | 'done' | 'error'
  calls: Array<{ name: string; args: Record<string, unknown> }>
  iterations?: number
  error?: string
}

export type FinalizeResult =
  | { aborted: true }
  | {
      aborted: false
      fullText: string
      tokensGenerated: number
      durationMs: number
      toolCalls?: ChatToolCall[]
    }

type ToolCreds = Pick<
  UserSettings,
  'cfAccountId' | 'cfApiToken' | 'braveApiKey' | 'serperApiKey'
>

export interface FinalizeDeps {
  /** Original conversation forwarded to Kimi when routing. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** Tool calls parsed from Gemma's output (the routing trigger). */
  toolCalls: ChatToolCall[]
  /** Raw Gemma result. */
  gemma: GemmaChatResult
  /** Credential settings (CF + search keys). */
  settings: ToolCreds
  /** Live abort flag — re-checked after the (long) Kimi loop. */
  isAborted: () => boolean
  /** Emit a tool-status event to the caller. */
  onToolStatus: (s: ToolStatusUpdate) => void
  /**
   * Register the loop's AbortController so an external Stop can cancel the
   * in-flight CF/web-search fetches. Called only on the routed path.
   */
  registerAbort?: (controller: AbortController) => void
  /** Injectable for tests; defaults to the real Kimi loop. */
  runKimi?: typeof runKimiLoop
}

/**
 * Decide the final chat-done payload, routing through Kimi when Gemma emitted
 * tool calls AND Cloudflare credentials are configured.
 *
 * Invariants this encodes (each previously a bug):
 *  - durationMs = Gemma generation time + Kimi loop wall-clock time.
 *  - The un-routed path strips `<|tool_call>…<tool_call|>` envelopes so raw
 *    markup never reaches the user; Kimi's synthesized answer is already clean.
 *  - A Stop during or after the loop yields `{ aborted: true }`, never a stale
 *    answer.
 */
export async function finalizeChatResult(deps: FinalizeDeps): Promise<FinalizeResult> {
  const { messages, toolCalls, gemma, settings, isAborted, onToolStatus } = deps
  const runKimi = deps.runKimi ?? runKimiLoop

  const toolStatusCalls = toolCalls.map((tc) => ({
    name: tc.name,
    args: tc.args ?? {},
  }))
  const hasToolCalls = toolCalls.length > 0
  const cfConfigured = Boolean(settings.cfAccountId && settings.cfApiToken)

  let fullText = gemma.fullText
  let durationMs = gemma.durationMs
  let routedByKimi = false

  if (hasToolCalls && cfConfigured) {
    onToolStatus({ status: 'routing', calls: toolStatusCalls })

    const kimiAbort = new AbortController()
    deps.registerAbort?.(kimiAbort)

    try {
      const kimiResult = await runKimi(
        messages,
        REGISTERED_TOOLS,
        { cfAccountId: settings.cfAccountId!, cfApiToken: settings.cfApiToken! },
        { braveApiKey: settings.braveApiKey, serperApiKey: settings.serperApiKey },
        undefined,
        kimiAbort.signal,
      )

      fullText = kimiResult.response
      durationMs = (gemma.durationMs ?? 0) + kimiResult.durationMs
      routedByKimi = true

      onToolStatus({
        status: 'done',
        calls: toolStatusCalls,
        iterations: kimiResult.iterations,
      })
    } catch (kimiErr) {
      // A Stop mid-loop surfaces as an AbortError — clean cancellation, not a
      // tool failure. Don't fall through to emit a stale answer.
      if (isAborted()) return { aborted: true }
      onToolStatus({
        status: 'error',
        calls: toolStatusCalls,
        error: (kimiErr as Error).message ?? String(kimiErr),
      })
    }
  }

  // Re-check after the (potentially long) loop: the user may have hit Stop
  // while it ran but before the next signal check fired.
  if (isAborted()) return { aborted: true }

  return {
    aborted: false,
    fullText: routedByKimi ? fullText : stripToolCallEnvelopes(fullText),
    tokensGenerated: gemma.tokensGenerated,
    durationMs,
    toolCalls: hasToolCalls ? toolCalls : undefined,
  }
}
