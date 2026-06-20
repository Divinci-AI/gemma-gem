/**
 * chat-core / ChatController — holds a conversation, runs turns through an
 * `InferenceClient`, and emits events a UI renders. Framework-free; the sidebar,
 * popup, page-wide chat, and desktop app all subscribe to the same controller.
 *
 * Persistence (`TranscriptStore`) is optional and injected — local-only today,
 * account-mirrored once the SDK/OAuth transcript gaps are filled (see README).
 */

import type { ChatMessage, InferenceClient, ToolStatusUpdate } from '@/chat-core/inference'
import type { ChatTool } from '@/shared/messages'

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
   * Build a system prompt prepended to the conversation each turn (e.g. the
   * sidebar's page-aware prompt). Returns undefined for none.
   */
  systemPrompt?: () => string | undefined
  /** Per-turn inference params. */
  maxNewTokens?: number
  temperature?: number
  tools?: ChatTool[]
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
      const result = await this.inference.chat({
        messages: this.withSystemPrompt(),
        maxNewTokens: this.options.maxNewTokens,
        temperature: this.options.temperature,
        tools: this.options.tools,
        signal: this.abortController.signal,
        onToken: (delta) => this.events.onToken?.(delta),
        onToolStatus: (u) => this.events.onToolStatus?.(u),
      })

      if (result.aborted) {
        // Keep the partial assistant text in history (matches the sidebar's
        // prior behavior — a stopped turn is still part of the conversation).
        if (result.text) this.messages.push({ role: 'assistant', content: result.text })
        this.events.onAborted?.(result.text)
      } else {
        const assistantMessage: ChatMessage = { role: 'assistant', content: result.text }
        this.messages.push(assistantMessage)
        this.events.onAssistantMessage?.(assistantMessage)
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

  private withSystemPrompt(): ChatMessage[] {
    const sys = this.options.systemPrompt?.()
    return sys ? [{ role: 'system', content: sys }, ...this.messages] : [...this.messages]
  }
}
