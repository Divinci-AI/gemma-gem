/**
 * chat-core / LocalInference — `InferenceClient` over the offscreen Gemma model.
 *
 * The offscreen doc runs the model; surfaces reach it over a transport (the
 * sidebar/page-wide chat use a `chrome.runtime` port; tests use a fake). This
 * class owns the request/stream/▸done protocol — the logic currently inline in
 * `entrypoints/content.ts` — so every surface shares one implementation.
 *
 * Transport-injected (no `chrome.*` here) → unit-testable and surface-agnostic.
 */

import type { ModelId } from '@/shared/models'
import type { DivinciExternalRequest, DivinciExternalEvent } from '@/shared/messages'
import type { InferenceClient, InferenceRequest, InferenceResult } from '@/chat-core/inference'

/** The seam to the offscreen model. A surface supplies the concrete transport. */
export interface LocalTransport {
  /** Forward a request (chat / abort) to the offscreen. */
  send(req: DivinciExternalRequest): void
  /** Subscribe to offscreen events; returns an unsubscribe fn. */
  subscribe(handler: (event: DivinciExternalEvent) => void): () => void
}

let seq = 0
function newRequestId(): string {
  seq += 1
  // No Math.random in case this ever runs under a deterministic harness; the
  // monotonic counter + a per-instance prefix is unique enough within a tab.
  return `local-${seq}-${Date.now()}`
}

export class LocalInference implements InferenceClient {
  readonly kind = 'local' as const
  readonly label: string

  constructor(
    private readonly transport: LocalTransport,
    private readonly opts: { modelId: ModelId; label: string; isLoaded: () => boolean },
  ) {
    this.label = opts.label
  }

  isReady(): boolean {
    return this.opts.isLoaded()
  }

  chat(req: InferenceRequest): Promise<InferenceResult> {
    const requestId = newRequestId()
    let streamed = ''

    return new Promise<InferenceResult>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        unsubscribe()
        if (onAbort) req.signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const unsubscribe = this.transport.subscribe((ev) => {
        // Only this request's events. Events without a requestId (load-*) and
        // other requests' events are ignored here — surfaces handle those.
        const evReqId = (ev as { requestId?: string }).requestId
        if (evReqId !== undefined && evReqId !== requestId) return

        switch (ev.type) {
          case 'divinci:chat-token':
            streamed += ev.delta
            req.onToken?.(ev.delta)
            return
          case 'divinci:tool-status':
            req.onToolStatus?.({
              status: ev.status,
              calls: ev.calls,
              iterations: ev.iterations,
              error: ev.error,
            })
            return
          case 'divinci:chat-done':
            finish(() =>
              resolve({
                // fullText is authoritative; fall back to streamed tokens.
                text: ev.fullText || streamed,
                tokensGenerated: ev.tokensGenerated,
                durationMs: ev.durationMs,
                toolCalls: ev.toolCalls,
              }),
            )
            return
          case 'divinci:aborted':
            finish(() => resolve({ text: streamed, aborted: true }))
            return
          case 'divinci:error':
            finish(() => reject(new Error(ev.message)))
            return
        }
      })

      const onAbort = req.signal
        ? () => this.transport.send({ type: 'divinci:abort', requestId })
        : null
      if (onAbort) {
        if (req.signal!.aborted) onAbort()
        else req.signal!.addEventListener('abort', onAbort)
      }

      this.transport.send({
        type: 'divinci:chat',
        requestId,
        modelId: this.opts.modelId,
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        tools: req.tools,
      })
    })
  }
}
