/**
 * Tests for the pure Cache-API breakdown helper. Mocks a minimal
 * CacheStorage so we can exercise the URL-bucketing + size-reading
 * logic without a real browser caches API.
 */

import { describe, it, expect } from 'vitest'
import {
  computeCacheBreakdown,
  emptyBreakdown,
  modelIdForUrl,
} from './cache-breakdown'

interface MockCache {
  entries: Array<{ url: string; contentLength?: number; blobSize?: number }>
}

function makeMockCachesApi(stores: Record<string, MockCache>) {
  return {
    keys: async () => Object.keys(stores),
    open: async (name: string) => {
      const store = stores[name]
      return {
        keys: async () => store.entries.map((e) => ({ url: e.url } as Request)),
        match: async (req: Request) => {
          const e = store.entries.find((x) => x.url === req.url)
          if (!e) return undefined
          // Build a Response-shaped mock that exposes the right headers
          // and falls through to blob() for entries without content-length.
          return {
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'content-length' && e.contentLength != null
                  ? String(e.contentLength)
                  : null,
            },
            blob: async () => ({ size: e.blobSize ?? 0 }),
          } as unknown as Response
        },
      }
    },
  }
}

describe('modelIdForUrl', () => {
  it('matches E2B URLs', () => {
    expect(
      modelIdForUrl('https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder.onnx')
    ).toBe('gemma-4-e2b')
  })

  it('matches E4B URLs', () => {
    expect(
      modelIdForUrl('https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/onnx/embed.onnx_data')
    ).toBe('gemma-4-e4b')
  })

  it('returns null for unknown URLs', () => {
    expect(modelIdForUrl('https://huggingface.co/some-other-model/file.onnx')).toBeNull()
    expect(modelIdForUrl('https://example.com/random.txt')).toBeNull()
  })
})

describe('computeCacheBreakdown', () => {
  it('returns an empty breakdown when caches API is unavailable', async () => {
    expect(await computeCacheBreakdown(undefined)).toEqual(emptyBreakdown())
  })

  it('returns an empty breakdown when there are no caches', async () => {
    const cachesApi = makeMockCachesApi({})
    expect(await computeCacheBreakdown(cachesApi)).toEqual(emptyBreakdown())
  })

  it('sums Content-Length per model bucket', async () => {
    const cachesApi = makeMockCachesApi({
      'transformers-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder.onnx_data', contentLength: 1_500_000_000 },
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/embed.onnx_data', contentLength: 1_400_000_000 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b']).toEqual({ isCached: true, bytes: 2_900_000_000 })
    expect(result['gemma-4-e4b']).toEqual({ isCached: false, bytes: 0 })
  })

  it('handles mixed E2B + E4B entries across multiple cache stores', async () => {
    const cachesApi = makeMockCachesApi({
      'transformers-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/file1', contentLength: 100 },
          { url: 'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/file1', contentLength: 200 },
        ],
      },
      'other-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/file2', contentLength: 300 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b']).toEqual({ isCached: true, bytes: 100 })
    expect(result['gemma-4-e4b']).toEqual({ isCached: true, bytes: 500 })
  })

  it('ignores entries that do not match any model', async () => {
    const cachesApi = makeMockCachesApi({
      'misc': {
        entries: [
          { url: 'https://example.com/random.json', contentLength: 9999 },
          { url: 'https://huggingface.co/some-unrelated-model/file', contentLength: 8888 },
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/keep', contentLength: 100 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b'].bytes).toBe(100)
    expect(result['gemma-4-e4b'].bytes).toBe(0)
  })

  it('falls back to blob().size when Content-Length is missing', async () => {
    const cachesApi = makeMockCachesApi({
      'transformers-cache': {
        entries: [
          // No contentLength; blobSize stands in.
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/chunked', blobSize: 12345 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b']).toEqual({ isCached: true, bytes: 12345 })
  })

  it('does not mark a model as cached when Content-Length is 0 / missing', async () => {
    const cachesApi = makeMockCachesApi({
      'transformers-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/empty', contentLength: 0, blobSize: 0 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b']).toEqual({ isCached: false, bytes: 0 })
  })
})
