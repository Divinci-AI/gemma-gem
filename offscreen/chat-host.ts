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

// Persist downloaded model weights in the Cache API (extension-origin, disk-
// backed, kept off the quota by the `unlimitedStorage` permission) so a reload
// after the offscreen document is torn down (page refresh, SW eviction, memory
// reclaim) reads from disk instead of re-fetching ~2.9 GB from Hugging Face.
// This is transformers.js's default, but we set it explicitly so a library
// default flip can't silently turn caching off. allowRemoteModels stays on for
// the first-ever download; allowLocalModels off (we have no bundled weights).
env.useBrowserCache = true
env.allowRemoteModels = true
env.allowLocalModels = false

export type LoadProgressFn = (info: {
  fraction: number | null
  bytesLoaded: number
  bytesTotal: number | null
  currentFile?: string
}) => void

export interface ChatOptions {
  /** Which loaded model to generate with. Defaults to the active model. */
  modelId?: ModelId
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
  // Multiple models can be resident at once (each independently loaded /
  // unloaded). `activeModelId` is the one chats target by default.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private loaded = new Map<ModelId, { model: any; tokenizer: any }>()
  private activeModelId: ModelId | null = null
  // Models whose load was cancelled (unloaded) mid-flight — the resolving
  // _load() sees this and discards its result instead of adding to the map.
  private unloadedDuringLoad = new Set<ModelId>()
  private loading: Promise<void> | null = null
  /** Model id of the in-flight load (if any). null when not loading. */
  private loadingModelId: ModelId | null = null
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
    return modelId == null ? this.loaded.size > 0 : this.loaded.has(modelId)
  }

  /** All currently-resident model ids. */
  loadedModelIds(): ModelId[] {
    return [...this.loaded.keys()]
  }

  getActiveModelId(): ModelId | null {
    return this.activeModelId
  }

  /** Make an already-loaded model the active chat target (instant, no reload). */
  setActive(modelId: ModelId): boolean {
    if (!this.loaded.has(modelId)) return false
    this.activeModelId = modelId
    return true
  }

  getLoadingModelId(): ModelId | null {
    return this.loadingModelId
  }

  getLastError(): string | null {
    return this.lastError
  }

  async load(modelId: ModelId, onProgress?: LoadProgressFn): Promise<void> {
    // Already resident → just make it the active chat target (instant switch).
    if (this.loaded.has(modelId)) { this.activeModelId = modelId; return }
    // One load at a time (single GPU). A different model already loading →
    // reject clearly; the same model already loading → join it.
    if (this.loading && this.loadingModelId !== modelId) {
      throw new Error(
        `Already loading ${this.loadingModelId}; wait for it to finish first`
      )
    }
    if (this.loading) return this.loading
    this.lastError = null
    this.loadingModelId = modelId
    this.unloadedDuringLoad.delete(modelId)
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

    // NOTE: does NOT dispose other resident models — multiple can coexist.
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

      // If the user unloaded THIS model while it was loading, discard the
      // freshly-loaded result instead of adding it to the resident map.
      if (this.unloadedDuringLoad.has(modelId)) {
        this.unloadedDuringLoad.delete(modelId)
        log.info(`Load of ${modelId} superseded by unload; discarding result`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { await (model as any)?.dispose?.() } catch (e) { log.warn('discard-dispose threw', e) }
        return
      }

      this.loaded.set(modelId, { model, tokenizer })
      this.activeModelId = modelId // newly loaded becomes the active target
      log.info(`Loaded ${modelId} (${this.loaded.size} resident)`)
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
    const targetId = opts.modelId ?? this.activeModelId
    if (!targetId || !this.loaded.has(targetId)) {
      throw new Error('Model not loaded — call load() first')
    }

    this.pending += 1
    // Append our work as the new tail. Suppress prior-chat errors at the
    // queue boundary so a thrown chat doesn't poison the queue for everyone
    // after it. Each caller still sees its own errors via the returned promise.
    const myWork = this.chatQueueTail
      .catch(() => undefined)
      .then(() => this.runChat(opts, onToken, targetId))
    this.chatQueueTail = myWork.catch(() => undefined)
    try {
      return await myWork
    } finally {
      this.pending -= 1
    }
  }

  private async runChat(opts: ChatOptions, onToken: ChatTokenFn, modelId: ModelId): Promise<{
    fullText: string
    tokensGenerated: number
    durationMs: number
  }> {
    const entry = this.loaded.get(modelId)
    if (!entry) throw new Error(`Model ${modelId} not loaded`)
    const { model, tokenizer } = entry
    const start = Date.now()
    let tokensGenerated = 0
    let fullText = ''

    try {
      // Per-model chat-template override (e.g. LFM2.5, whose shipped template uses
      // a Jinja `{% generation %}` block tjs 4.2.0 can't parse). Falls back to the
      // tokenizer's own template when the model config declares none.
      const templateOverride = MODELS[modelId]?.chatTemplate
      // Diagnostic (offscreen console): confirms which model + whether the
      // per-model chat-template override is active for this turn.
      console.warn(`[divinci] chat turn model=${modelId} templateOverride=${templateOverride ? 'yes' : 'no'}`)
      const inputs = tokenizer.apply_chat_template(opts.messages, {
        add_generation_prompt: true,
        tokenize: true,
        return_tensor: true,
        return_dict: true,
        ...(templateOverride ? { chat_template: templateOverride } : {}),
        // Forward-compatible: templates that don't use `tools` ignore it.
        // Gemma 4's template renders each tool as a <|tool>declaration:...<tool|>
        // block in the system turn, then the model can emit
        // <|tool_call>call:NAME{args}<tool_call|> in its output.
        tools: opts.tools,
      })

      // Watchdog: if generation produces NO token within this window it's almost
      // certainly hung in prefill (a silent runtime incompatibility — generate()
      // never returns and never throws, so the chat sits on '…' forever). Cleared
      // on the first token (a slow-but-working generation is fine).
      let clearWatch: () => void = () => {}
      const streamer = new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => {
          if (tokensGenerated === 0) clearWatch()
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

      const NO_TOKEN_TIMEOUT_MS = 30_000
      const watchdog = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(new Error(
            `No output from ${modelId} in ${NO_TOKEN_TIMEOUT_MS / 1000}s — ` +
            `generation appears stuck (possible WebGPU/runtime incompatibility). ` +
            `Open the extension's offscreen console for details.`
          ))
        }, NO_TOKEN_TIMEOUT_MS)
        clearWatch = () => clearTimeout(t)
      })
      // If generate resolves first, cancel the watchdog. If it hangs with no
      // token, the watchdog rejects → surfaces a real error instead of '…'.
      await Promise.race([
        model.generate(generateOpts).then((r: unknown) => { clearWatch(); return r }),
        watchdog,
      ])

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

  /** Unload ONE resident model (frees its GPU memory). If it was active, the
   *  next remaining resident model becomes active (or none). */
  async unload(modelId: ModelId): Promise<void> {
    // If it's mid-load, mark it so the resolving _load discards its result.
    if (this.loadingModelId === modelId) this.unloadedDuringLoad.add(modelId)
    const entry = this.loaded.get(modelId)
    if (entry?.model?.dispose) {
      try { await entry.model.dispose() } catch (e) { log.warn('model.dispose() threw', e) }
    }
    this.loaded.delete(modelId)
    if (this.activeModelId === modelId) {
      const rest = [...this.loaded.keys()]
      this.activeModelId = rest.length > 0 ? rest[0] : null
    }
  }

  /** Unload ALL resident models. */
  async unloadAll(): Promise<void> {
    if (this.loadingModelId) this.unloadedDuringLoad.add(this.loadingModelId)
    for (const [, entry] of this.loaded) {
      if (entry.model?.dispose) {
        try { await entry.model.dispose() } catch (e) { log.warn('model.dispose() threw', e) }
      }
    }
    this.loaded.clear()
    this.activeModelId = null
    this.activeStopper = null
    this.chatQueueTail = Promise.resolve()
    this.pending = 0
    this.latestProgress = null
    this.lastError = null
  }

  /** Back-compat alias: dispose() unloads everything. */
  async dispose(): Promise<void> {
    return this.unloadAll()
  }

  /** The active chat-target model id (back-compat name). */
  getCurrentModelId(): ModelId | null {
    return this.activeModelId
  }
}
