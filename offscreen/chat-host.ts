/**
 * Minimal chat host: wraps @huggingface/transformers around the
 * Divinci external chat protocol. Owns one model instance + one
 * in-flight generation at a time. No agent-loop awareness, no
 * tool-calling, no thinking-block parsing — that all lives in
 * the web-app side. The extension is a transport, not a brain.
 *
 * Lifecycle:
 *   const host = new ChatHost();
 *   await host.load("gemma-4-e2b", onProgress);
 *   await host.chat({ messages, maxNewTokens, ... }, onToken);
 *   host.abort();    // mid-generation
 *   host.dispose();  // model offload
 */

import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  InterruptableStoppingCriteria,
  env,
} from '@huggingface/transformers'
import { MODELS, type ModelId } from '@/shared/models'
import type { ChatTool } from '@/shared/messages'
import { log } from '@/shared/logger'

// Self-host the ONNX Runtime WASM files; copied at build time by wxt.config.
if (env.backends.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')
}

export type LoadProgressFn = (info: {
  fraction: number | null
  bytesLoaded: number
  bytesTotal: number | null
  currentFile?: string
}) => void

export interface ChatOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxNewTokens?: number
  temperature?: number
  topP?: number
  /**
   * Optional tool descriptors. Passed to apply_chat_template; templates
   * that don't reference `tools` (most non-instruct models) silently
   * ignore the field. Gemma 4's chat template DOES use it — see the
   * `{%- if tools -%}` branch in tokenizer_config.json. Output parsing
   * is the caller's responsibility (parseToolCalls in tool-call-parser.ts).
   */
  tools?: ChatTool[]
}

export type ChatTokenFn = (delta: string) => void

export class ChatHost {
  private currentModelId: ModelId | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null
  private loading: Promise<void> | null = null
  /** Model id of the in-flight load (if any). null when not loading. */
  private loadingModelId: ModelId | null = null
  /**
   * Generation counter that distinguishes "this load is current" from
   * "this load was superseded by a dispose() call". dispose() bumps it.
   * After from_pretrained resolves we compare the counter we captured at
   * load-start against the current value — if they differ, dispose ran
   * during our load and we discard the result rather than re-installing
   * the model after the user explicitly asked to unload.
   */
  private loadGeneration = 0
  /**
   * Last load failure reason. Cleared at the start of every load() and
   * on successful completion. Surfaced to the popup via the status
   * response so the UI can render an error toast.
   */
  private lastError: string | null = null
  // The transformers.js StoppingCriteria currently steering an active
  // generate() loop. interrupt() it to stop within one token.
  private activeStopper: InstanceType<typeof InterruptableStoppingCriteria> | null = null
  // Serial queue: each chat() request waits for the previous to settle.
  // ChatHost runs ONE generation at a time on ONE GPU device; concurrent
  // callers (e.g. two browser tabs hitting the extension simultaneously)
  // get queued, not rejected. The tail tracks whichever chat is most
  // recently appended; new chat()s chain on after it. We keep a `pending`
  // count for observability (used by getQueueDepth()).
  private chatQueueTail: Promise<unknown> = Promise.resolve()
  private pending = 0

  isLoaded(modelId?: ModelId): boolean {
    if (!this.model) return false
    return modelId == null || modelId === this.currentModelId
  }

  getLoadingModelId(): ModelId | null {
    return this.loadingModelId
  }

  getLastError(): string | null {
    return this.lastError
  }

  async load(modelId: ModelId, onProgress?: LoadProgressFn): Promise<void> {
    if (this.isLoaded(modelId)) return
    // Concurrent load of a DIFFERENT model is a UX bug if silently joined
    // to the in-flight one (caller never sees their model load). Reject
    // with a clear message; popup catches this and shows the error toast.
    if (this.loading && this.loadingModelId !== modelId) {
      throw new Error(
        `Already loading ${this.loadingModelId}; wait for it or unload first`
      )
    }
    if (this.loading) return this.loading
    this.lastError = null
    this.loadingModelId = modelId
    this.loading = this._load(modelId, onProgress)
      .catch((e) => {
        this.lastError = (e as Error).message ?? String(e)
        throw e
      })
      .finally(() => {
        this.loading = null
        this.loadingModelId = null
      })
    return this.loading
  }

  private async _load(modelId: ModelId, onProgress?: LoadProgressFn): Promise<void> {
    const config = MODELS[modelId]
    if (!config) throw new Error(`Unknown modelId: ${modelId}`)

    if (this.model && this.currentModelId !== modelId) {
      log.info(`Unloading ${this.currentModelId} before loading ${modelId}`)
      await this.dispose()
    }

    // Snapshot the current generation BEFORE awaiting from_pretrained so
    // we can detect a dispose-during-load race below.
    const myGeneration = this.loadGeneration
    log.info(`Loading ${modelId} (${config.hfModelId} @ ${config.revision} dtype=${config.dtype})`)

    let totalLoaded = 0
    let totalExpected: number | null = null
    let lastFile: string | undefined

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progress_callback = (p: any): void => {
      if (p.status === 'progress') {
        totalLoaded = Math.max(totalLoaded, p.loaded ?? 0)
        if (typeof p.total === 'number') totalExpected = p.total
        lastFile = p.file
        const snapshot = {
          fraction:
            typeof p.progress === 'number' && Number.isFinite(p.progress) ? p.progress / 100 : null,
          bytesLoaded: totalLoaded,
          bytesTotal: totalExpected,
          currentFile: lastFile,
        }
        this.latestProgress = snapshot
        onProgress?.(snapshot)
      }
    }

    try {
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(config.hfModelId, {
          revision: config.revision,
          progress_callback,
        }),
        AutoModelForCausalLM.from_pretrained(config.hfModelId, {
          revision: config.revision,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dtype: config.dtype as any,
          device: 'webgpu',
          progress_callback,
        }),
      ])

      // Generation check: dispose() bumps loadGeneration. If it ran while
      // we were awaiting from_pretrained, the user has explicitly asked
      // to unload — don't re-install the model state, just dispose the
      // newly-loaded one and exit. Without this check the dispose silently
      // gets undone by our late assignments.
      if (myGeneration !== this.loadGeneration) {
        log.info(`Load of ${modelId} superseded by dispose; discarding result`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { await (model as any)?.dispose?.() } catch (e) { log.warn('discard-dispose threw', e) }
        return
      }

      this.tokenizer = tokenizer
      this.model = model
      this.currentModelId = modelId
      log.info(`Loaded ${modelId}`)
    } finally {
      // Clear the download bar regardless of success/failure/supersession.
      // Bug 1 fix: previously this only ran on success, so a failed load
      // left the popup showing a frozen "75% downloading…" forever.
      this.latestProgress = null
    }
  }

  /**
   * Queue depth (chats waiting for their turn, plus the one running).
   * 0 = nothing in flight. Use this to surface a "queued" UI hint to the
   * user when their chat has to wait.
   */
  getQueueDepth(): number {
    return this.pending
  }

  /**
   * Latest in-flight load progress, or null when not currently loading.
   * Used by the popup UI to render a download bar without subscribing to
   * the chat-host event stream. Updated on every progress callback during
   * load(). Cleared (back to null) once load completes or fails.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private latestProgress: any = null
  getLatestProgress(): {
    fraction: number | null
    bytesLoaded: number
    bytesTotal: number | null
    currentFile?: string
  } | null {
    return this.latestProgress
  }

  async chat(opts: ChatOptions, onToken: ChatTokenFn): Promise<{
    fullText: string
    tokensGenerated: number
    durationMs: number
  }> {
    if (!this.model || !this.tokenizer) throw new Error('Model not loaded — call load() first')

    this.pending += 1
    // Append our work as the new tail. Suppress prior-chat errors at the
    // queue boundary so a thrown chat doesn't poison the queue for everyone
    // after it. Each caller still sees its own errors via the returned promise.
    const myWork = this.chatQueueTail
      .catch(() => undefined)
      .then(() => this.runChat(opts, onToken))
    this.chatQueueTail = myWork.catch(() => undefined)
    try {
      return await myWork
    } finally {
      this.pending -= 1
    }
  }

  private async runChat(opts: ChatOptions, onToken: ChatTokenFn): Promise<{
    fullText: string
    tokensGenerated: number
    durationMs: number
  }> {
    const start = Date.now()
    let tokensGenerated = 0
    let fullText = ''

    try {
      const inputs = this.tokenizer.apply_chat_template(opts.messages, {
        add_generation_prompt: true,
        tokenize: true,
        return_tensor: true,
        return_dict: true,
        // Forward-compatible: templates that don't use `tools` ignore it.
        // Gemma 4's template renders each tool as a <|tool>declaration:...<tool|>
        // block in the system turn, then the model can emit
        // <|tool_call>call:NAME{args}<tool_call|> in its output.
        tools: opts.tools,
      })

      const streamer = new TextStreamer(this.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => {
          tokensGenerated += 1
          fullText += text
          onToken(text)
        },
      })

      const stopper = new InterruptableStoppingCriteria()
      this.activeStopper = stopper

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateOpts: Record<string, any> = {
        ...inputs,
        max_new_tokens: opts.maxNewTokens ?? 512,
        do_sample: typeof opts.temperature === 'number' && opts.temperature > 0,
        streamer,
        stopping_criteria: stopper,
      }
      if (typeof opts.temperature === 'number' && opts.temperature > 0) {
        generateOpts.temperature = opts.temperature
      }
      if (typeof opts.topP === 'number') generateOpts.top_p = opts.topP

      await this.model.generate(generateOpts)

      return { fullText, tokensGenerated, durationMs: Date.now() - start }
    } finally {
      this.activeStopper = null
    }
  }

  /**
   * Interrupt the active generation. Returns true if there was something
   * to interrupt; the chat() promise will still resolve (with the partial
   * output collected so far) once the loop reaches its next token boundary.
   */
  abort(): boolean {
    if (this.activeStopper) {
      this.activeStopper.interrupt()
      return true
    }
    return false
  }

  async dispose(): Promise<void> {
    // Bump generation FIRST so any in-flight _load (awaiting from_pretrained
    // right now) sees the change when it resumes and discards its result
    // instead of re-installing the model state we're about to clear.
    this.loadGeneration += 1
    if (this.model?.dispose) {
      try {
        await this.model.dispose()
      } catch (e) {
        log.warn('model.dispose() threw', e)
      }
    }
    this.model = null
    this.tokenizer = null
    this.currentModelId = null
    this.activeStopper = null
    this.chatQueueTail = Promise.resolve()
    this.pending = 0
    this.latestProgress = null
    this.lastError = null
  }

  getCurrentModelId(): ModelId | null {
    return this.currentModelId
  }
}
