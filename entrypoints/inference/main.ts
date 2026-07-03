/**
 * Page-context inference host (Phase 0 de-risk).
 *
 * The MV3 offscreen document can't run WebGPU model inference in the current
 * Chrome (loads/generates hang — the event loop blocks on a WASM-CPU fallback),
 * but a chrome-extension IFRAME framed inside a normal web page IS a real page
 * context with working GPU (the robot.html iframe proves WebGL works there). So
 * we host the ChatHost here instead of the offscreen.
 *
 * Phase 0: on load, run a single LFM2.5 load+generate self-test and report the
 * result to the parent (content script) via postMessage. If this generates
 * where the offscreen hangs, the re-architecture is proven and Phase 1 wires the
 * real chat routing through here.
 */
import { ChatHost } from '@/offscreen/chat-host'

function report(payload: Record<string, unknown>): void {
  try { window.parent.postMessage({ __divinciInference: true, ...payload }, '*') } catch { /* ignore */ }
  // Also stamp a global for direct inspection if needed.
  ;(window as unknown as { __INFERENCE_TEST__?: unknown }).__INFERENCE_TEST__ = payload
  console.warn('[inference-host]', JSON.stringify(payload))
}

async function selfTest(): Promise<void> {
  try {
    const gpu = (navigator as unknown as { gpu?: unknown }).gpu
    report({ phase: 'boot', hasWebGPU: !!gpu })
    const host = new ChatHost()
    report({ phase: 'loading', model: 'lfm2.5-230m' })
    await host.load('lfm2.5-230m')
    report({ phase: 'loaded' })
    let out = ''
    let toks = 0
    const t0 = performance.now()
    await host.chat(
      { modelId: 'lfm2.5-230m', messages: [{ role: 'user', content: 'Say hi in 3 words' }], maxNewTokens: 24 },
      (delta) => { out += delta; toks++ },
    )
    report({ phase: 'done', status: toks > 0 ? 'OK' : 'EMPTY', tokens: toks, genMs: Math.round(performance.now() - t0), sample: out.slice(0, 100) })
  } catch (e) {
    report({ phase: 'error', message: String((e as Error)?.message ?? e).slice(0, 300) })
  }
}

void selfTest()
