/**
 * Pure helper that scans Cache API stores and groups bytes by model id.
 * Extracted from the offscreen entrypoint so it's unit-testable with a
 * mocked `caches` API, without booting transformers.js + chrome.runtime.
 *
 * Each Cache entry's URL is pattern-matched against MODELS[id].hfModelId.
 * Size is read from the response's `Content-Length` header (metadata-only,
 * no disk read) with a fallback to `blob().size` for chunked responses.
 */

import { MODELS, type ModelId } from '@/shared/models'

export type CacheBreakdown = Record<ModelId, { isCached: boolean; bytes: number }>

export function emptyBreakdown(): CacheBreakdown {
  return {
    'gemma-4-e2b': { isCached: false, bytes: 0 },
    'gemma-4-e4b': { isCached: false, bytes: 0 },
  }
}

interface MinimalCacheStorage {
  keys: () => Promise<string[]>
  open: (name: string) => Promise<MinimalCache>
}

interface MinimalCache {
  keys: () => Promise<Request[]>
  match: (req: Request) => Promise<Response | undefined>
}

/**
 * Bucket model id by URL substring match against MODELS[id].hfModelId.
 * Returns null when no model matches.
 */
export function modelIdForUrl(url: string): ModelId | null {
  for (const [mid, cfg] of Object.entries(MODELS) as Array<
    [ModelId, (typeof MODELS)[ModelId]]
  >) {
    if (url.includes(cfg.hfModelId)) return mid
  }
  return null
}

export async function computeCacheBreakdown(
  cachesApi: MinimalCacheStorage | undefined
): Promise<CacheBreakdown> {
  const next = emptyBreakdown()
  if (!cachesApi) return next
  const cacheNames = await cachesApi.keys()
  for (const name of cacheNames) {
    const cache = await cachesApi.open(name)
    const requests = await cache.keys()
    for (const req of requests) {
      const id = modelIdForUrl(req.url)
      if (!id) continue
      const resp = await cache.match(req)
      if (!resp) continue
      const bytes = await readResponseSize(resp)
      if (bytes > 0) {
        next[id].isCached = true
        next[id].bytes += bytes
      }
    }
  }
  return next
}

/**
 * Read response size from the Content-Length header (no disk read), or
 * fall back to `blob().size` if the header is missing/invalid (some HF
 * responses use chunked transfer-encoding without a Content-Length).
 */
async function readResponseSize(resp: Response): Promise<number> {
  const cl = resp.headers.get('content-length')
  const parsed = cl ? Number.parseInt(cl, 10) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  try {
    const blob = await resp.blob()
    return blob.size
  } catch {
    return 0
  }
}
