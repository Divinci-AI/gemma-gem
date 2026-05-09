/**
 * Model registry. Pinned to specific HuggingFace revision SHAs so users
 * get the exact bytes we tested against — bump `version` when rotating
 * to invalidate the user-side cache.
 *
 * Sizes correspond to the text-only path (decoder + embed_tokens, no
 * vision/audio encoder). E4B is included for parity with the web app
 * but currently hidden from the picker until we have a stronger
 * GPU-memory capability gate; see CLAUDE.md / web-app spec for context.
 */

export type ModelId = 'gemma-4-e2b' | 'gemma-4-e4b'

export interface ModelConfig {
  id: ModelId
  hfModelId: string
  /** Pinned HuggingFace commit SHA. */
  revision: string
  label: string
  downloadSize: string
  /**
   * Quantization dtype. q4f16 is smaller than q4 (2.9 GB vs 3.4 GB for E2B)
   * and gemma-gem's reference impl validates it works for Gemma 4 — but our
   * web-app worker hit OrtRun buffer errors with q4f16 on Web Worker WebGPU.
   * The offscreen-document path here is a different runtime, expected to
   * survive q4f16. If it doesn't, fall back to "q4".
   */
  dtype: 'q4' | 'q4f16' | 'q8' | 'fp16'
  contextLimit: number
  /** Cache-busting version. Bump on revision change. */
  version: number
}

export const MODELS: Record<ModelId, ModelConfig> = {
  'gemma-4-e2b': {
    id: 'gemma-4-e2b',
    hfModelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    label: 'Gemma 4 E2B',
    downloadSize: '~2.9 GB',
    dtype: 'q4f16',
    contextLimit: 32_768,
    version: 1,
  },
  'gemma-4-e4b': {
    id: 'gemma-4-e4b',
    hfModelId: 'onnx-community/gemma-4-E4B-it-ONNX',
    revision: '843f250f23bc91754def1e0f0db390dacd1e6b05',
    label: 'Gemma 4 E4B',
    downloadSize: '~4.6 GB',
    dtype: 'q4f16',
    contextLimit: 32_768,
    version: 1,
  },
}

export const DEFAULT_MODEL_ID: ModelId = 'gemma-4-e2b'
export const STORAGE_KEY_MODEL = 'divinci_local_model_id'

/**
 * Web app origins allowed to talk to this extension via
 * externally_connectable. Mirrored in wxt.config.ts manifest, plus
 * runtime-checked in external-bridge.ts isAllowedOrigin (defense in
 * depth). The localhost entry is dev-only — see wxt.config.ts comment
 * for the security rationale (random :8080 services would otherwise
 * gain free GPU access).
 *
 * `import.meta.env.DEV` is set by Vite/WXT during `pnpm dev`/`pnpm build`
 * (development mode) and false during `pnpm build:prod`.
 */
const isDevBuild =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV === true

export const ALLOWED_WEB_APP_ORIGINS = [
  'https://chat.divinci.app',
  'https://chat.stage.divinci.app',
  'https://chat.dev.divinci.app',
  ...(isDevBuild ? ['http://localhost:8080'] : []),
]
