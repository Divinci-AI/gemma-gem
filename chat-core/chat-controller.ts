/**
 * chat-core / ChatController — holds a conversation, runs turns through an
 * `InferenceClient`, and emits events a UI renders. Framework-free; the sidebar,
 * popup, page-wide chat, and desktop app all subscribe to the same controller.
 *
 * Persistence (`TranscriptStore`) is optional and injected — local-only today,
 * account-mirrored once the SDK/OAuth transcript gaps are filled (see README).
 */

import type { ChatMessage, InferenceClient, ToolStatusUpdate } from '@/chat-core/inference'
import type { ChatTool, ChatToolCall } from '@/shared/messages'

export interface ChatControllerEvents {
  /** A user turn was added (echo it to the transcript). */
  onUserMessage?(message: ChatMessage): void
  /** An assistant turn is starting (show a placeholder bubble). */
  onAssistantStart?(): void
  /** Streamed token delta for the in-flight assistant turn. */
  onToken?(delta: string): void
  /** Tool-routing lifecycle for the in-flight turn. */
  onToolStatus?(update: ToolStatusUpdate): void
  /** The assistant turn finished (final text). */
  onAssistantMessage?(message: ChatMessage): void
  /** The turn was stopped; carries whatever streamed before the stop. */
  onAborted?(partialText: string): void
  /** The turn failed. */
  onError?(error: Error): void
  /** Busy = a turn is in flight (drives Send↔Stop). */
  onBusyChange?(busy: boolean): void
}

export interface ChatControllerOptions {
  /**
   * Build messages to PREPEND before the conversation history each turn — e.g.
   * a page-aware system prompt plus RAG grounding. Receives the user's text so
   * it can ground on the query, and may be async (the sidebar fetches WWW RAG
   * chunks here). Returns [] for none. Not stored in history.
   */
  prepareTurn?: (userText: string) => ChatMessage[] | Promise<ChatMessage[]>
  /** Per-turn inference params. */
  maxNewTokens?: number
  temperature?: number
  tools?: ChatTool[]
  /**
   * Discover the tools available THIS turn (e.g. the page's WebMCP tools, which
   * change per page). When set, its result is used instead of the static
   * `tools`. Returns [] for none.
   */
  resolveTools?: () => ChatTool[] | Promise<ChatTool[]>
  /**
   * Execute the tool calls the model emitted (e.g. call the page's WebMCP tools)
   * and return a text blob of results to feed back for a follow-up answer.
   * Return null/empty to skip the follow-up (no matching tool / nothing to do).
   * Enables a bounded agentic loop; absent → tool calls are surfaced but not run.
   */
  executeToolCalls?: (calls: ChatToolCall[]) => Promise<string | null>
  /** Max tool-execution hops per user turn (default 2). */
  maxToolHops?: number
}

export class ChatController {
  private messages: ChatMessage[] = []
  private busy = false
  private abortController: AbortController | null = null

  constructor(
    private inference: InferenceClient,
    private readonly events: ChatControllerEvents = {},
    private readonly options: ChatControllerOptions = {},
  ) {}

  /** A copy of the conversation (excludes the per-turn system prompt). */
  get history(): ChatMessage[] {
    return [...this.messages]
  }

  isBusy(): boolean {
    return this.busy
  }

  /** Swap the backend (e.g. local ↔ account) between turns. */
  setInference(inference: InferenceClient): void {
    this.inference = inference
  }

  /** Seed history (e.g. when opening a saved conversation). */
  setHistory(messages: ChatMessage[]): void {
    this.messages = [...messages]
  }

  /** Send a user message and run one assistant turn. No-op if blank or busy. */
  async send(text: string): Promise<void> {
    const content = text.trim()
    if (!content || this.busy) return

    const userMessage: ChatMessage = { role: 'user', content }
    this.messages.push(userMessage)
    this.events.onUserMessage?.(userMessage)

    this.busy = true
    this.abortController = new AbortController()
    this.events.onBusyChange?.(true)
    this.events.onAssistantStart?.()

    try {
      // prepareTurn (e.g. async RAG grounding) runs after the placeholder is
      // shown; its messages prepend the history but are not stored.
      const prefix = (await this.options.prepareTurn?.(content)) ?? []
      // Stopped during prepareTurn (e.g. the user hit Stop while grounding
      // fetched)? Don't start inference — treat it as an aborted turn.
      if (this.abortController?.signal.aborted) {
        this.events.onAborted?.('')
        return
      }
      // Per-turn tools (e.g. the page's WebMCP tools) override the static list.
      const tools = this.options.resolveTools ? await this.options.resolveTools() : this.options.tools
      const maxHops = this.options.maxToolHops ?? 2
      let hop = 0

      // Bounded agentic loop: run inference; if the model emits tool calls AND a
      // tool executor is configured, run them, feed the results back, and answer
      // again. Each hop streams into the SAME assistant bubble — the UI clears it
      // on the onToolStatus('routing') signal so only the final answer shows.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await this.inference.chat({
          messages: [...prefix, ...this.messages],
          maxNewTokens: this.options.maxNewTokens,
          temperature: this.options.temperature,
          tools,
          signal: this.abortController!.signal,
          onToken: (delta) => this.events.onToken?.(delta),
          onToolStatus: (u) => this.events.onToolStatus?.(u),
        })

        if (result.aborted) {
          if (result.text) this.messages.push({ role: 'assistant', content: result.text })
          this.events.onAborted?.(result.text)
          return
        }

        // The model's turn (carries any tool-call markup) is part of history.
        this.messages.push({ role: 'assistant', content: result.text })

        const calls = result.toolCalls ?? []
        const canRunTools =
          calls.length > 0 && !!this.options.executeToolCalls && hop < maxHops && !this.abortController!.signal.aborted
        if (canRunTools) {
          hop++
          const statusCalls = calls.map((c) => ({ name: c.name, args: c.args ?? c.arguments ?? {} }))
          this.events.onToolStatus?.({ status: 'routing', calls: statusCalls })
          let toolText: string | null = null
          try {
            toolText = await this.options.executeToolCalls!(calls)
          } catch (e) {
            this.events.onToolStatus?.({ status: 'error', calls: statusCalls, error: (e as Error).message })
          }
          if (toolText) {
            this.events.onToolStatus?.({ status: 'done', calls: statusCalls })
            // Feed tool results back as a fenced, data-only user turn, then loop.
            this.messages.push({ role: 'user', content: toolText })
            continue
          }
        }

        // No tools to run (or hop budget spent) → this is the final answer.
        this.events.onAssistantMessage?.({ role: 'assistant', content: result.text })
        break
      }
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.busy = false
      this.abortController = null
      this.events.onBusyChange?.(false)
    }
  }

  /** Stop the in-flight turn (the InferenceClient resolves aborted). */
  stop(): void {
    this.abortController?.abort()
  }
}
