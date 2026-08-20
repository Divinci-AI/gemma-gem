/**
 * Model registry. Pinned to a specific HuggingFace revision SHA so users
 * get the exact bytes we tested against — bump `version` when rotating
 * to invalidate the user-side cache.
 *
 * Size corresponds to the text-only path (decoder + embed_tokens, no
 * vision/audio encoder). The shape supports N models. To add one, extend the ModelId union, add an entry to
 * MODELS, add a card to entrypoints/popup/index.html, and surface it
 * in chat.divinci.app's AVAILABLE_MODELS picker.
 */

export type ModelId =
  | 'gemma-4-e2b'
  | 'gemma-4-e2b-qat'
  | 'lfm2.5-230m'
  | 'llama-3.2-1b'
  | 'qwen2.5-0.5b'
  | 'smollm2-360m'

export interface ModelConfig {
  id: ModelId
  hfModelId: string
  /** Pinned HuggingFace commit SHA. */
  revision: string
  label: string
  /** Short display name for inline UI copy ("Ask X anything", "Message X…"). */
  shortLabel: string
  downloadSize: string
  /**
   * Quantization dtype. q4f16 is smaller than q4 (2.9 GB vs 3.4 GB) and
   * the offscreen-document runtime survives it (the in-page Web Worker
   * runtime hit OrtRun buffer errors with q4f16; that's a different
   * runtime entirely — see project_local_llm_worker_ortrun_buffer_bug.md).
   */
  dtype: 'q4' | 'q4f16' | 'q8' | 'fp16'
  contextLimit: number
  /**
   * Optional chat-template override. Some models ship a Jinja chat_template that
   * transformers.js 4.2.0's bundled jinja can't parse (e.g. LFM2.5 uses the
   * `{% generation %}` block → "Unknown statement type generation" → chat throws
   * → no response). Provide an inference-equivalent template here to bypass it.
   */
  chatTemplate?: string
  /**
   * When true, the model is shown but NOT loadable — "Coming soon". Use for
   * models blocked on an upstream fix. LFM2.5's `lfm2` arch has incomplete
   * transformers.js WebGPU kernels → generation hangs the runtime (no abort, no
   * watchdog) on real prompts, so it must not be loadable until upstream kernels
   * land. UI disables Load; auto-warm + default-selection skip it.
   */
  comingSoon?: boolean
  /** Cache-busting version. Bump on revision change. */
  version: number
}

/** First model that is actually loadable (skips `comingSoon`). */
export function firstAvailableModelId(): ModelId {
  const first = (Object.values(MODELS).find((m) => !m.comingSoon) ?? MODELS[DEFAULT_MODEL_ID]).id
  return first
}

// Minimal ChatML template for LFM2.5 (im_start/im_end + bos), equivalent to its
// shipped template for inference but WITHOUT the `{% generation %}` block that
// tjs 4.2.0's jinja rejects. Verified end-to-end: generates coherently.
const LFM2_CHATML_TEMPLATE =
  "{{- bos_token -}}" +
  "{%- for message in messages -%}" +
  "{{- '<|im_start|>' + message.role + '\n' + message.content + '<|im_end|>\n' -}}" +
  "{%- endfor -%}" +
  "{%- if add_generation_prompt -%}{{- '<|im_start|>assistant\n' -}}{%- endif -%}";

export const MODELS: Record<ModelId, ModelConfig> = {
  'gemma-4-e2b': {
    id: 'gemma-4-e2b',
    hfModelId: 'onnx-community/gemma-4-E2B-it-ONNX',
    revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    label: 'Gemma 4 E2B',
    shortLabel: 'Gemma 4',
    downloadSize: '~2.9 GB',
    dtype: 'q4f16',
    contextLimit: 32_768,
    version: 1,
  },
  // QAT (quantization-aware trained) Gemma 4 E2B: near-bf16 quality at 4-bit.
  // Kept as a SEPARATE entry (not a swap of the one above) so existing users'
  // 2.9 GB cache stays valid — the QAT repo only ships q4 (no f16 activations),
  // which is ~300 MB larger. Community conversion of google's official
  // gemma-4-E2B-it-qat weights to the transformers.js split layout.
  'gemma-4-e2b-qat': {
    id: 'gemma-4-e2b-qat',
    hfModelId: 'nico-martin/gemma-4-E2B-it-qat-q4-ONNX',
    revision: 'f83a0fb4825956b3d87687a30b7716e8692f1f70',
    label: 'Gemma 4 E2B QAT',
    shortLabel: 'Gemma 4 QAT',
    downloadSize: '~3.2 GB',
    dtype: 'q4',
    contextLimit: 32_768,
    version: 1,
  },
  // LiquidAI LFM2.5 230M — the "Lite" tier: ~211 MB download (vs 2.9 GB),
  // loads in seconds, runs on hardware the E2B gate excludes. lfm2 arch is
  // supported by our bundled @huggingface/transformers 4.2.0. Use for
  // instant-start chat and utility inference; E2B remains the quality tier.
  // NOTE: LFM Open License 1.0 (revenue-conditioned) — reviewed before ship.
  'lfm2.5-230m': {
    id: 'lfm2.5-230m',
    hfModelId: 'LiquidAI/LFM2.5-230M-ONNX',
    revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d',
    label: 'LFM2.5 230M (Lite)',
    shortLabel: 'LFM2.5',
    downloadSize: '~211 MB',
    dtype: 'q4',
    contextLimit: 32_768,
    chatTemplate: LFM2_CHATML_TEMPLATE,
    // Blocked on upstream lfm2 WebGPU kernels — generation hangs the runtime on
    // real prompts. Shown as "Coming soon", not loadable, until upstream lands.
    comingSoon: true,
    version: 1,
  },
  // Kernel-complete small models (llama / qwen2 architectures) — these have
  // COMPLETE transformers.js WebGPU kernels, so they stream cleanly in the
  // page-context inference iframe on any real prompt. Validated end-to-end
  // against a dock-style (system page-context + user) prompt: Qwen 40t/2.8s,
  // SmolLM 27t/0.8s — the exact prompt shape that hangs lfm2's incomplete
  // kernels. No chat-template override needed (their shipped templates parse
  // fine in tjs 4.2.0 jinja).
  'llama-3.2-1b': {
    id: 'llama-3.2-1b',
    hfModelId: 'onnx-community/Llama-3.2-1B-Instruct',
    revision: '14007543b6dc92de88daf96a9aa85d2f95ace6ef',
    label: 'Llama 3.2 1B',
    shortLabel: 'Llama 3.2',
    downloadSize: '~0.9 GB',
    dtype: 'q4',
    contextLimit: 131_072,
    version: 1,
  },
  'qwen2.5-0.5b': {
    id: 'qwen2.5-0.5b',
    hfModelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    revision: 'cc5cc01a65cc3ff17bdb73a7de33d879f62599b0',
    label: 'Qwen2.5 0.5B',
    shortLabel: 'Qwen2.5',
    downloadSize: '~0.5 GB',
    dtype: 'q4',
    contextLimit: 32_768,
    version: 1,
  },
  'smollm2-360m': {
    id: 'smollm2-360m',
    hfModelId: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    revision: 'a10cc1512eabd3dde888204e902eca88bddb4951',
    label: 'SmolLM2 360M',
    shortLabel: 'SmolLM2',
    downloadSize: '~0.3 GB',
    dtype: 'q4',
    contextLimit: 8_192,
    version: 1,
  },
}

export const DEFAULT_MODEL_ID: ModelId = 'gemma-4-e2b'
export const STORAGE_KEY_MODEL = 'divinci_local_model_id'
// Cross-surface load mirror: the SW writes { modelId, at } here the moment ANY
// surface (popup, dock, popout, web app, auto-warm) starts a model load, and
// clears it on load-done/error. Lets every surface reflect an in-progress load
// WITHOUT round-tripping to the offscreen — which, mid-load, is too busy to
// answer a status poll. Read as a fallback/overlay on top of status.loadingModelId.
export const STORAGE_KEY_LOADING = 'divinci_local_loading'
export interface LoadingMirror { modelId: ModelId; at: number }
export const STORAGE_KEY_SETTINGS = 'divinci_local_settings'
// Whether the in-page overlay sidebar is open. Shared so the SW can flip it
// (the "Overlay" panel-mode toggle from the dock/pop-out re-opens the overlay
// on the active tab via the existing cross-tab storage sync).
export const STORAGE_KEY_OPEN = 'divinci_sidebar_open'
// The user's last-chosen panel surface — drives the hamburger toggle-row
// highlight. 'overlay' = in-page sidebar, 'dock' = chrome.sidePanel,
// 'popout' = standalone window.
export const STORAGE_KEY_PANEL_MODE = 'divinci_panel_mode'
export type PanelSurface = 'overlay' | 'dock' | 'popout'
// Auto-warm crash-loop guard. The SW auto-warms the remembered model on every
// startup (incl. the ~30s eviction cycle); if a WebGPU/ONNX load hard-crashes
// the renderer or SW, that turns into a reload→warm→crash→reload loop (the
// browser's "extension has crashed" balloon, repeating). This persists the
// outcome of the LAST auto-warm so a crash (recorded as 'pending' that never
// transitioned to 'ok'/'failed') disables auto-warm until the user manually
// clicks Load — breaking the loop. Values: 'pending' | 'ok' | 'failed' | 'disabled'.
export const STORAGE_KEY_WARM_STATE = 'divinci_local_warm_state'
export type WarmState = 'pending' | 'ok' | 'failed' | 'disabled'
// Timestamp (ms) recorded alongside a 'pending' warm state. Lets the startup
// guard distinguish a genuine crash (pending that's been stale for longer than
// any plausible load) from a load that's merely still in flight after a normal
// ~30s SW eviction — a multi-step VRAM load can outlive the worker that kicked
// it off, and we must NOT misread that as a crash and disable auto-warm.
export const STORAGE_KEY_WARM_PENDING_AT = 'divinci_local_warm_pending_at'
// In-page sidebar handle: persisted drag position (viewport fraction) + a
// "completely hidden" flag (set by double-clicking the handle, restored from
// the popup's Appearance toggle).
export const STORAGE_KEY_HANDLE_TOP = 'divinci_sidebar_handle_top'
export const STORAGE_KEY_HANDLE_HIDDEN = 'divinci_sidebar_handle_hidden'
// Per-tab active conversation: a map { [tabId]: conversationId } so each browser
// tab keeps its own thread (page-coherent). Shared by the content script (read/
// write) and the SW (prunes a tab's entry on tab close). Global "follow-me" mode
// ignores this and uses STORAGE_KEY_ACTIVE_CONV (a single shared pointer).
export const STORAGE_KEY_TAB_ACTIVE = 'divinci_tab_active'
// "Global chat mode" toggle: false (default) = per-tab active conversation;
// true = one conversation follows the user across every tab.
export const STORAGE_KEY_GLOBAL_CHAT_MODE = 'divinci_global_chat_mode'

/**
 * User-configurable inference defaults. Set via the popup, applied by
 * the offscreen handleChat layer ONLY when the web-app request didn't
 * pass an explicit value (per-call params always override these).
 */
export interface UserSettings {
  /** 0 = greedy / deterministic. >0 enables sampling. */
  temperature: number
  /** Hard cap on tokens per generation. */
  maxNewTokens: number
  /**
   * Cloudflare Account ID for Workers AI API. Required for Kimi K2.7-Code
   * tool-call routing (the model that handles tool-calling rounds when
   * Gemma 4 detects tool intent).
   */
  cfAccountId?: string
  /**
   * Cloudflare API Token with Workers AI permission. Required for Kimi
   * K2.7-Code tool-call routing.
   */
  cfApiToken?: string
  /**
   * Brave Search API key. Used for web search tool execution when Kimi
   * K2.7-Code calls the `web_search` tool.
   */
  braveApiKey?: string
  /**
   * Serper.dev API key. Alternative to Brave for web search tool execution.
   * Either braveApiKey or serperApiKey must be set for web search to work.
   */
  serperApiKey?: string
  /**
   * Account mode: when true, tool-calling is proxied through the user's
   * signed-in Divinci account (stage.divinci.app) using SERVER-held keys,
   * instead of the local Cloudflare/Brave/Serper path above. The OAuth tokens
   * live separately in chrome.storage (STORAGE_KEY_DIVINCI_AUTH), SW-owned —
   * they are NOT part of UserSettings and never reach the offscreen doc.
   */
  useDivinciAccount?: boolean
  /** Workspace (whitelabel) id the account-mode chat targets. */
  divinciWorkspaceId?: string
  /**
   * Workspace API key (release:read/write) for the Tools panel — lets the
   * extension manage Skills + MCP servers via the /api/v1 surface (which is
   * API-key, not OAuth). Stored in chrome.storage; sent as X-API-Key by the SW
   * proxy. Separate from the OAuth account tokens.
   */
  divinciApiKey?: string
  /**
   * Optional release id to pin. The release's toolRouting.enabled gates
   * whether the server runs the Kimi web-search loop for this request.
   */
  divinciReleaseId?: string
  /**
   * UI color theme. 'system' (default) follows the OS via prefers-color-scheme;
   * 'light'/'dark' force it. Applied in the popup (and surfaced to the sidebar).
   */
  theme?: 'system' | 'light' | 'dark'
  /**
   * WWW RAG grounding: when true (default), the SW retrieves Divinci page
   * context for the current site to ground local chat. When false, the
   * page-context query never leaves the device — the www-rag bridge returns
   * empty chunks WITHOUT calling the server. Default/undefined = enabled.
   */
  wwwRagGrounding?: boolean
  /**
   * Allow Divinci to use the user's account chats to improve services. When
   * false the extension SIGNALS the preference to the server via an
   * `X-Divinci-Data-Use: none` header on account-mode chat + page-context
   * fetches. Server-side enforcement is a separate TODO — the extension only
   * carries the signal. Default/undefined = allowed.
   */
  allowChatDataUse?: boolean
  /**
   * Page reading: when true (default), the extension extracts the CURRENT
   * page's visible text on-device and includes it as context so the local
   * model can answer about what's on the page — the extension's core feature.
   * Extraction is skipped on sensitive pages (url-policy) regardless. With
   * local Gemma inference the page text never leaves the browser. Default/
   * undefined = enabled.
   */
  readPageContent?: boolean
}

/** Canonical Divinci legal pages, linked from the in-page chat disclaimer. */
export const PRIVACY_POLICY_URL = 'https://divinci.ai/privacy-policy/'
export const TERMS_URL = 'https://divinci.ai/terms-of-service/'

/**
 * Default temperature is 0.7 (not 0/greedy) per Google's Gemma usage
 * recommendations — greedy decoding gives "lifeless" responses for
 * conversational chat. Power users who want determinism can set
 * temperature: 0 in the popup. Web-app per-call params always override.
 */
export const DEFAULT_SETTINGS: UserSettings = {
  temperature: 0.7,
  maxNewTokens: 512,
  wwwRagGrounding: true,
  allowChatDataUse: true,
  readPageContent: true,
}

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
// Bare `import.meta.env.DEV` so Vite can replace it with a literal and esbuild
// can drop the dead branch — see the note in shared/divinci-account.ts.
const isDevBuild = import.meta.env.DEV === true

export const ALLOWED_WEB_APP_ORIGINS = isDevBuild
  ? [
      // Dev builds are a SUPERSET: a developer testing locally may point at any
      // environment, including production. The narrowing that matters is on the
      // published package, below.
      'https://chat.divinci.app',
      'https://chat.stage.divinci.app',
      'https://chat.dev.divinci.app',
      'http://localhost:8080',
    ]
  : // A production build serves the production web app ONLY. Every extra origin
    // in a published package is attack surface and Chrome Web Store review
    // surface; internal staging testing uses the dev build loaded unpacked.
    // MUST stay in lockstep with WEB_APP_ORIGINS in wxt.config.ts — the manifest
    // grants the port, this list is the runtime re-check, and an origin present
    // in only one of them either never connects or connects unchecked.
    ['https://chat.divinci.app']
