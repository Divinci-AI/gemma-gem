/**
 * WWW RAG public-API request/response shaping (pure).
 *
 * WWW RAG is one global, system-owned Divinci corpus queryable by URL for
 * page-specific context (see agent-handoff-page-indexing.md). The extension
 * acts as the signed-in Divinci user (OAuth Bearer); there are NO manual API
 * keys or whitelabel ids — the server resolves `target=WWW_RAG` itself.
 *
 * This module is the divinci-account.ts sibling for the `www-rag` endpoints:
 * it builds URLs/bodies and SAFELY parses responses. It performs no fetch and
 * holds no token — the authenticated fetch (Bearer + refresh-on-401) lives in
 * the service worker (background/www-rag-bridge.ts), so the token never leaves
 * the SW. Keep everything here pure so it stays trivially unit-testable.
 *
 * Per project convention, responses are parsed with text()+JSON.parse in a
 * try/catch (never bare .json()) — the public API can return HTML error pages,
 * empty bodies, or 502 proxy text.
 */

import { DIVINCI_API_BASE } from './divinci-account'
import type { SiteThemeConfig } from './release-config'

// ---- page-status (GET) ----

/**
 * Build the page-status URL.
 *   GET {base}/api/v1/www-rag/page-status?url=<sanitized>&hash=<clientHash>
 * The caller passes the already-sanitized origin+pathname (sanitizeUrlForIndex)
 * and the client content fingerprint (contentHash). `hash` is omitted when the
 * caller couldn't compute one (advisory — the server falls back to lastCrawledAt).
 */
export function buildPageStatusUrl(sanitizedUrl: string, hash?: string): string {
  const p = new URLSearchParams({ url: sanitizedUrl })
  if (hash) p.set('hash', hash)
  return `${DIVINCI_API_BASE}/api/v1/www-rag/page-status?${p.toString()}`
}

/**
 * Server contract for page-status (P1). All fields optional/defensive — the
 * server isn't deployed yet and shapes may settle; the safe parser tolerates
 * partial/garbage bodies.
 */
export interface PageStatusResponse {
  url: string
  /** A page doc exists in WWW RAG for this URL. */
  indexed: boolean
  /** The page has actually been crawled (content present), not just queued. */
  crawled: boolean
  /** Monotonic version of the crawled content, when known. */
  version?: number
  /** Server-side content fingerprint (over scraped markdown). */
  contentHash?: string
  /**
   * True when the server's stored content matches the client `hash` (or, when
   * hash parity slips, when lastCrawledAt is recent enough). False => stale.
   */
  fresh?: boolean
  /** ISO timestamp of the last crawl, when known. */
  lastCrawledAt?: string
}

/**
 * Safely parse a page-status response body. Returns null on any malformed /
 * non-object body so the caller can map it to an `error` pill rather than throw.
 */
export function parsePageStatusResponse(text: string): PageStatusResponse | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  return {
    url: typeof o.url === 'string' ? o.url : '',
    indexed: o.indexed === true,
    crawled: o.crawled === true,
    version: typeof o.version === 'number' ? o.version : undefined,
    contentHash: typeof o.contentHash === 'string' ? o.contentHash : undefined,
    fresh: typeof o.fresh === 'boolean' ? o.fresh : undefined,
    lastCrawledAt: typeof o.lastCrawledAt === 'string' ? o.lastCrawledAt : undefined,
  }
}

// ---- page-context (POST) ----

/** Build the page-context URL: POST {base}/api/v1/www-rag/page-context */
export function buildPageContextUrl(): string {
  return `${DIVINCI_API_BASE}/api/v1/www-rag/page-context`
}

/** Body for page-context: URL-scoped retrieval against WWW RAG. */
export function buildPageContextBody(opts: {
  url: string
  query: string
  topK?: number
}): string {
  const body: Record<string, unknown> = { url: opts.url, query: opts.query }
  if (typeof opts.topK === 'number') body.topK = opts.topK
  return JSON.stringify(body)
}

/** A single retrieved chunk scoped to the queried URL. */
export interface PageContextChunk {
  text: string
  score?: number
  source?: string
  fileId?: string
}

export interface PageContextResponse {
  url: string
  chunks: PageContextChunk[]
}

/**
 * Safely parse a page-context response. Returns null on a malformed body;
 * returns an empty `chunks` array when the body is well-formed but carried no
 * (or garbage) chunks. Each chunk is normalized — non-string `text` chunks are
 * dropped so the caller can trust `chunk.text`.
 */
export function parsePageContextResponse(text: string): PageContextResponse | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const rawChunks = Array.isArray(o.chunks) ? o.chunks : []
  const chunks: PageContextChunk[] = []
  for (const c of rawChunks) {
    if (typeof c !== 'object' || c === null) continue
    const cc = c as Record<string, unknown>
    if (typeof cc.text !== 'string' || cc.text.length === 0) continue
    chunks.push({
      text: cc.text,
      score: typeof cc.score === 'number' ? cc.score : undefined,
      source: typeof cc.source === 'string' ? cc.source : undefined,
      fileId: typeof cc.fileId === 'string' ? cc.fileId : undefined,
    })
  }
  return { url: typeof o.url === 'string' ? o.url : '', chunks }
}

// ---- site-theme (GET) ----

/**
 * Build the per-host theme URL.
 *   GET {base}/api/v1/www-rag/theme?host=<bareHost>
 * Returns the host's crawler-derived brand theme so the panel can blend into the
 * site it landed on (the same SiteThemeConfig surface release templates feed).
 */
export function buildSiteThemeUrl(host: string): string {
  const p = new URLSearchParams({ host })
  return `${DIVINCI_API_BASE}/api/v1/www-rag/theme?${p.toString()}`
}

/** Parsed site-theme: a panel-ready SiteThemeConfig (or null when unthemed). */
export interface SiteThemeResponse {
  host: string
  theme: SiteThemeConfig | null
  /** The page the palette was rendered from (provenance/debug). */
  sourceUrl?: string
}

/** #rgb / #rrggbb / #rrggbbaa only — blocks url()/expression()/javascript: when
 *  interpolated into a style value. (The server already validated, but the
 *  extension re-validates everything that reaches a DOM style.) */
function safeHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t) ? t : undefined
}

/**
 * Safely parse a site-theme response, mapping the server's full ThemeConfig down
 * to the panel's minimal SiteThemeConfig. The panel themes its accent only, so we
 * extract a single brand color — the derived `primary` (from the site's CTA),
 * falling back to `buttonBg` then `accent`. Returns `theme: null` when the host
 * is untracked/unthemed or no usable brand color survives validation.
 */
export function parseSiteThemeResponse(text: string): SiteThemeResponse | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const host = typeof o.host === 'string' ? o.host : ''
  const sourceUrl = typeof o.sourceUrl === 'string' ? o.sourceUrl : undefined

  const serverTheme = o.theme
  if (!serverTheme || typeof serverTheme !== 'object') {
    return { host, theme: null, sourceUrl }
  }
  const colors = (serverTheme as { colors?: unknown }).colors
  const c = (colors && typeof colors === 'object' ? colors : {}) as Record<string, unknown>
  const accent = safeHex(c.primary) ?? safeHex(c.buttonBg) ?? safeHex(c.accent)
  if (!accent) return { host, theme: null, sourceUrl }

  return { host, theme: { preset: 'custom', accent }, sourceUrl }
}

// ---- pill-status mapping ----

/**
 * The pill states rendered in the sidebar header (content.ts). Mirrors
 * InternalPageCheckResponse['status']. `triggered`/`indexing` is intentionally
 * absent — P2 reads only; the contribute/submit path (P3) owns "indexing…".
 */
export type WwwRagPillStatus =
  | 'signed-out'
  | 'checking'
  | 'indexed'
  | 'stale'
  | 'not-indexed'
  | 'blacklisted'
  | 'not-configured'
  | 'error'

/**
 * Map a parsed page-status response to a pill status.
 *   - not indexed / not crawled            -> 'not-indexed'
 *   - indexed + crawled + fresh!==false    -> 'indexed'
 *   - indexed + crawled + fresh===false    -> 'stale'  (content changed)
 * `fresh === undefined` (server couldn't decide) is treated as fresh so a
 * usable index isn't downgraded purely because hash parity slipped.
 */
export function pageStatusToPill(status: PageStatusResponse): WwwRagPillStatus {
  if (!status.indexed || !status.crawled) return 'not-indexed'
  return status.fresh === false ? 'stale' : 'indexed'
}
