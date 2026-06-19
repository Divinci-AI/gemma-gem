/**
 * Web search execution layer.
 *
 * Supports two providers:
 *   - Brave Search API  (set braveApiKey in settings)
 *   - Serper.dev API    (set serperApiKey in settings)
 *
 * Brave is preferred when both are configured (it's open and has a free
 * tier). Falls back to Serper if Brave is not available.
 */

import { log } from '@/shared/logger'

export interface WebSearchParams {
  query: string
  count?: number
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchProvider {
  /** Brave Search API key, or undefined to use Serper. */
  braveApiKey?: string
  /** Serper.dev API key, used when Brave is not configured. */
  serperApiKey?: string
}

// ---- Brave Search API ----

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search'

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  const url = new URL(BRAVE_API_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave Search API error ${response.status}`)
  }

  const json: unknown = await response.json()
  const body = json as { web?: { results?: Array<{ title: string; url: string; description?: string }> } }

  const results = body?.web?.results ?? []
  return results.slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }))
}

// ---- Serper.dev API ----

const SERPER_API_URL = 'https://google.serper.dev/search'

async function searchSerper(
  query: string,
  count: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  const response = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: count }),
  })

  if (!response.ok) {
    throw new Error(`Serper API error ${response.status}`)
  }

  const json: unknown = await response.json()
  const body = json as { organic?: Array<{ title: string; link: string; snippet?: string }> }

  const results = body?.organic ?? []
  return results.slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }))
}

// ---- Public API ----

/**
 * Execute a web search using the configured provider.
 *
 * @returns A plain-text summary formatted for the model to consume.
 */
export async function executeWebSearch(
  params: WebSearchParams,
  provider: WebSearchProvider,
): Promise<string> {
  const count = params.count ?? 5
  const query = params.query

  let results: WebSearchResult[]

  if (provider.braveApiKey) {
    log.info(`[web-search] Brave: "${query}" (count=${count})`)
    results = await searchBrave(query, count, provider.braveApiKey)
  } else if (provider.serperApiKey) {
    log.info(`[web-search] Serper: "${query}" (count=${count})`)
    results = await searchSerper(query, count, provider.serperApiKey)
  } else {
    return 'Error: No search API key configured. Set Brave Search API key or Serper API key in extension settings.'
  }

  if (results.length === 0) {
    return `No results found for "${query}".`
  }

  // Format results as plain text for the model to consume.
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
  )
  return `Search results for "${query}":\n\n${lines.join('\n\n')}`
}
