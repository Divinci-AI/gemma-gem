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
}

export type ChatTokenFn = (delta: string) => void

export class ChatHost {
  private currentModelId: ModelId | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null
  private loading: Promise<void> | null = null
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

  async load(modelId: ModelId, onProgress?: LoadProgressFn): Promise<void> {
    if (this.isLoaded(modelId)) return
    if (this.loading) return this.loading
    this.loading = this._load(modelId, onProgress).finally(() => {
      this.loading = null
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
        onProgress?.({
          fraction: typeof p.progress === 'number' && Number.isFinite(p.progress) ? p.progress / 100 : null,
          bytesLoaded: totalLoaded,
          bytesTotal: totalExpected,
          currentFile: lastFile,
        })
      }
    }

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

    this.tokenizer = tokenizer
    this.model = model
    this.currentModelId = modelId
    log.info(`Loaded ${modelId}`)
  }

  /**
   * Queue depth (chats waiting for their turn, plus the one running).
   * 0 = nothing in flight. Use this to surface a "queued" UI hint to the
   * user when their chat has to wait.
   */
  getQueueDepth(): number {
    return this.pending
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
  }

  getCurrentModelId(): ModelId | null {
    return this.currentModelId
  }
}
