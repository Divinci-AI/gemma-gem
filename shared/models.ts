/**
 * Model registry. Pinned to a specific HuggingFace revision SHA so users
 * get the exact bytes we tested against — bump `version` when rotating
 * to invalidate the user-side cache.
 *
 * Size corresponds to the text-only path (decoder + embed_tokens, no
 * vision/audio encoder). The shape supports N models; we ship with E2B
 * only. To add a second, extend the ModelId union, add an entry to
 * MODELS, add a card to entrypoints/popup/index.html, and surface it
 * in chat.divinci.app's AVAILABLE_MODELS picker.
 */

export type ModelId = 'gemma-4-e2b'

export interface ModelConfig {
  id: ModelId
  hfModelId: string
  /** Pinned HuggingFace commit SHA. */
  revision: string
  label: string
  downloadSize: string
  /**
   * Quantization dtype. q4f16 is smaller than q4 (2.9 GB vs 3.4 GB) and
   * the offscreen-document runtime survives it (the in-page Web Worker
   * runtime hit OrtRun buffer errors with q4f16; that's a different
   * runtime entirely — see project_local_llm_worker_ortrun_buffer_bug.md).
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
}

export const DEFAULT_MODEL_ID: ModelId = 'gemma-4-e2b'
export const STORAGE_KEY_MODEL = 'divinci_local_model_id'
export const STORAGE_KEY_SETTINGS = 'divinci_local_settings'
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
}

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
const isDevBuild =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV === true

export const ALLOWED_WEB_APP_ORIGINS = [
  'https://chat.divinci.app',
  'https://chat.stage.divinci.app',
  'https://chat.dev.divinci.app',
  ...(isDevBuild ? ['http://localhost:8080'] : []),
]
