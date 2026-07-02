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

  it('returns null for unknown URLs (other models, unrelated origins)', () => {
    expect(
      modelIdForUrl('https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/file')
    ).toBeNull()
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
  })

  it('aggregates across multiple cache stores', async () => {
    const cachesApi = makeMockCachesApi({
      'transformers-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/file1', contentLength: 100 },
        ],
      },
      'other-cache': {
        entries: [
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/file2', contentLength: 200 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b']).toEqual({ isCached: true, bytes: 300 })
  })

  it('ignores entries that do not match any model (including other Gemma variants)', async () => {
    const cachesApi = makeMockCachesApi({
      'misc': {
        entries: [
          { url: 'https://example.com/random.json', contentLength: 9999 },
          { url: 'https://huggingface.co/some-unrelated-model/file', contentLength: 8888 },
          // E4B URLs are NOT bucketed — we only ship E2B today.
          { url: 'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/file', contentLength: 7777 },
          { url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/keep', contentLength: 100 },
        ],
      },
    })
    const result = await computeCacheBreakdown(cachesApi)
    expect(result['gemma-4-e2b'].bytes).toBe(100)
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

// ---- Multi-model registry (Lite tier + QAT, added 2026-07-02) --------------
import { MODELS } from '@/shared/models'

describe('multi-model registry', () => {
  it('emptyBreakdown covers every registered model (was hardcoded to one)', () => {
    const bd = emptyBreakdown()
    for (const id of Object.keys(MODELS)) {
      expect(bd[id as keyof typeof bd]).toEqual({ isCached: false, bytes: 0 })
    }
    expect(Object.keys(bd).sort()).toEqual(Object.keys(MODELS).sort())
  })

  it('every model pins a full-SHA revision and declares a download size', () => {
    for (const cfg of Object.values(MODELS)) {
      expect(cfg.revision).toMatch(/^[a-f0-9]{40}$/)
      expect(cfg.downloadSize).toMatch(/(MB|GB)/)
      expect(cfg.contextLimit).toBeGreaterThan(0)
    }
  })

  it('cache bucketing distinguishes the three model repos by URL', () => {
    expect(modelIdForUrl('https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/main/onnx/model_q4.onnx')).toBe('lfm2.5-230m')
    expect(modelIdForUrl('https://huggingface.co/nico-martin/gemma-4-E2B-it-qat-q4-ONNX/resolve/x/onnx/decoder_model_merged_q4.onnx')).toBe('gemma-4-e2b-qat')
    expect(modelIdForUrl('https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/x/y.onnx')).toBe('gemma-4-e2b')
  })
})
