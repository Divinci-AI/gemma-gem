/**
 * Minimal API client for the Divinci RAG/vector backend.
 *
 * Two operations:
 *   1. checkPage(url)  —  GET /api/v1/html-pages/by-url?url=…  (public read-only)
 *   2. scrapePage(url) —  POST /:wlId/rag-vector/html-page/scrape (internal write)
 *
 * The public read endpoint is used first. If the page doesn't exist (404)
 * the caller can decide to trigger a scrape via the internal route.
 */

const DEFAULT_BASE_URL = 'https://api.divinci.app'

export interface PageCheckResult {
  exists: boolean
  /** Present when the page exists in the index. */
  metadata?: {
    url: string
    title?: string
    updatedAt: string
    [key: string]: unknown
  }
}

export interface ScrapeResult {
  /** Crawl/job id the backend returned, if any. */
  crawlId?: string
  success: boolean
}

export class DivinciAPI {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly whitelabelId: string

  constructor(opts: {
    apiKey: string
    whitelabelId: string
    baseURL?: string
  }) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.whitelabelId = opts.whitelabelId
  }

  private authHeaders(): Record<string, string> {
    return { 'X-API-Key': this.apiKey }
  }

  /**
   * Check whether a URL is already indexed in the Divinci RAG vector store.
   * Uses the public read-only v1 endpoint (rag:read permission).
   */
  async checkPage(url: string): Promise<PageCheckResult> {
    const encoded = encodeURIComponent(url)
    const res = await fetch(
      `${this.baseURL}/api/v1/html-pages/by-url?url=${encoded}`,
      { headers: this.authHeaders() },
    )
    if (res.status === 404) return { exists: false }
    if (!res.ok) {
      throw new Error(`checkPage failed (${res.status}): ${await res.text().catch(() => '')}`)
    }
    const data = (await res.json()) as Record<string, unknown>
    return {
      exists: true,
      metadata: data as unknown as PageCheckResult['metadata'],
    }
  }

  /**
   * Trigger a scrape of a URL into the Divinci RAG vector store.
   * Uses the internal lifecycle route (requires embed-api-key with scrape permission).
   * The backend runs the scrape asynchronously; this returns the crawl/job id.
   */
  async scrapePage(url: string): Promise<ScrapeResult> {
    const res = await fetch(
      `${this.baseURL}/${this.whitelabelId}/rag-vector/html-page/scrape`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      },
    )
    if (!res.ok) {
      throw new Error(`scrapePage failed (${res.status}): ${await res.text().catch(() => '')}`)
    }
    const data = (await res.json()) as { crawlId?: string; success?: boolean }
    return {
      crawlId: data.crawlId,
      success: data.success !== false,
    }
  }
}
