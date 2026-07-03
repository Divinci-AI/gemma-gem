/**
 * Per-model brand logos for message avatars + the header chip. Inlined as data
 * URIs (no network fetch, not subject to host-page CSP) — offline-first.
 *
 * Liquid AI mark: the geometric droplet symbol extracted from liquid.ai's
 * wordmark SVG (paths isolated, recolored white, centered in a square viewBox).
 */
import { GEMMA_LOGO_DATA_URI } from './gemma-logo'
import type { ModelId } from './models'

export const LIQUID_LOGO_DATA_URI =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%22-128%20-52%201000%201000%22%3E%3Cpath%20d%3D%22M386.801%20319.037L386.474%20319.22L503.32%20515.258C518.989%20538.504%20528.132%20566.18%20528.132%20595.93C528.132%20624.104%20519.97%20650.452%20505.782%20672.918L743.865%20598.585L371.425%200L281.732%20144.536L386.801%20319.037Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M186.582%20895.985L373.628%20744.663C373.473%20744.663%20373.301%20744.663%20373.146%20744.663C287.552%20744.663%20218.178%20678.078%20218.178%20595.946C218.178%20566.279%20227.27%20538.669%20242.87%20515.457L353.396%20329.673L261.535%20177.106L0%20598.601L186.272%20895.985H186.582Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M452.697%20723.591C452.697%20723.591%20452.68%20723.591%20452.662%20723.607L239.977%20895.985H555.596L715.557%20643.301L452.697%20723.607V723.591Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E'

// Neutral "on-device spark" mark for the kernel-complete small models
// (Llama 3.2 / Qwen2.5 / SmolLM2) — a four-point sparkle, so they're visually
// distinct from the Gemma and Liquid brand marks without vendoring each
// upstream logo.
export const SPARK_LOGO_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M12%202l2.4%207.1L21.5%2012l-7.1%202.4L12%2021.5l-2.4-7.1L2.5%2012l7.1-2.4z%22%2F%3E%3C%2Fsvg%3E"

/** The brand logo data URI for a given model id (falls back to the Gemma mark). */
export function logoForModel(modelId: ModelId): string {
  if (modelId === 'lfm2.5-230m') return LIQUID_LOGO_DATA_URI
  if (modelId === 'llama-3.2-1b' || modelId === 'qwen2.5-0.5b' || modelId === 'smollm2-360m')
    return SPARK_LOGO_DATA_URI
  return GEMMA_LOGO_DATA_URI
}

/** Alt text for the logo image. */
export function logoAltForModel(modelId: ModelId): string {
  if (modelId === 'lfm2.5-230m') return 'LFM2.5'
  if (modelId === 'llama-3.2-1b') return 'Llama 3.2'
  if (modelId === 'qwen2.5-0.5b') return 'Qwen2.5'
  if (modelId === 'smollm2-360m') return 'SmolLM2'
  return 'Gemma'
}
