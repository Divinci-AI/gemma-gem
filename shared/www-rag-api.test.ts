import { describe, it, expect } from 'vitest'
import { DIVINCI_API_BASE } from '@/shared/divinci-account'
import {
  buildPageStatusUrl,
  parsePageStatusResponse,
  buildPageContextUrl,
  buildPageContextBody,
  parsePageContextResponse,
  pageStatusToPill,
} from '@/shared/www-rag-api'

describe('buildPageStatusUrl', () => {
  it('targets www-rag/page-status with url + hash query params', () => {
    const url = new URL(buildPageStatusUrl('https://example.com/docs', 'abc123'))
    expect(url.origin + url.pathname).toBe(`${DIVINCI_API_BASE}/api/v1/www-rag/page-status`)
    expect(url.searchParams.get('url')).toBe('https://example.com/docs')
    expect(url.searchParams.get('hash')).toBe('abc123')
  })

  it('omits hash when not provided', () => {
    const url = new URL(buildPageStatusUrl('https://example.com/docs'))
    expect(url.searchParams.has('hash')).toBe(false)
    expect(url.searchParams.get('url')).toBe('https://example.com/docs')
  })

  it('encodes urls with reserved characters', () => {
    const url = new URL(buildPageStatusUrl('https://example.com/a b&c'))
    // URLSearchParams encodes the value; decode round-trips it.
    expect(url.searchParams.get('url')).toBe('https://example.com/a b&c')
  })
})

describe('parsePageStatusResponse', () => {
  it('parses a full well-formed response', () => {
    const r = parsePageStatusResponse(
      JSON.stringify({
        url: 'https://example.com/x',
        indexed: true,
        crawled: true,
        version: 3,
        contentHash: 'deadbeef',
        fresh: false,
        lastCrawledAt: '2026-06-19T00:00:00Z',
      }),
    )
    expect(r).toEqual({
      url: 'https://example.com/x',
      indexed: true,
      crawled: true,
      version: 3,
      contentHash: 'deadbeef',
      fresh: false,
      lastCrawledAt: '2026-06-19T00:00:00Z',
    })
  })

  it('defaults booleans to false and drops wrong-typed fields', () => {
    const r = parsePageStatusResponse(JSON.stringify({ url: 'u', version: 'nope' }))
    expect(r).toEqual({
      url: 'u',
      indexed: false,
      crawled: false,
      version: undefined,
      contentHash: undefined,
      fresh: undefined,
      lastCrawledAt: undefined,
    })
  })

  it('returns null on non-JSON', () => {
    expect(parsePageStatusResponse('<html>502</html>')).toBeNull()
    expect(parsePageStatusResponse('')).toBeNull()
  })

  it('returns null on a non-object JSON body', () => {
    expect(parsePageStatusResponse('42')).toBeNull()
    expect(parsePageStatusResponse('null')).toBeNull()
  })
})

describe('buildPageContextUrl / buildPageContextBody', () => {
  it('builds the page-context URL', () => {
    expect(buildPageContextUrl()).toBe(`${DIVINCI_API_BASE}/api/v1/www-rag/page-context`)
  })

  it('carries url + query, omitting topK when absent', () => {
    const body = JSON.parse(buildPageContextBody({ url: 'u', query: 'q' }))
    expect(body).toEqual({ url: 'u', query: 'q' })
  })

  it('includes topK when provided', () => {
    const body = JSON.parse(buildPageContextBody({ url: 'u', query: 'q', topK: 5 }))
    expect(body).toEqual({ url: 'u', query: 'q', topK: 5 })
  })
})

describe('parsePageContextResponse', () => {
  it('parses + normalizes chunks, dropping ones without string text', () => {
    const r = parsePageContextResponse(
      JSON.stringify({
        url: 'https://example.com/x',
        chunks: [
          { text: 'hello', score: 0.9, source: 'src', fileId: 'f1' },
          { text: '', score: 1 }, // dropped (empty text)
          { score: 1 }, // dropped (no text)
          'garbage', // dropped (not an object)
          { text: 'world' },
        ],
      }),
    )
    expect(r).toEqual({
      url: 'https://example.com/x',
      chunks: [
        { text: 'hello', score: 0.9, source: 'src', fileId: 'f1' },
        { text: 'world', score: undefined, source: undefined, fileId: undefined },
      ],
    })
  })

  it('returns empty chunks when chunks is missing/garbage', () => {
    expect(parsePageContextResponse(JSON.stringify({ url: 'u' }))).toEqual({ url: 'u', chunks: [] })
    expect(parsePageContextResponse(JSON.stringify({ url: 'u', chunks: 'no' }))).toEqual({
      url: 'u',
      chunks: [],
    })
  })

  it('returns null on non-JSON / non-object', () => {
    expect(parsePageContextResponse('oops')).toBeNull()
    expect(parsePageContextResponse('[]')).not.toBeNull() // array IS an object — chunks empty
    expect(parsePageContextResponse('7')).toBeNull()
  })
})

describe('pageStatusToPill', () => {
  const base = { url: 'u', indexed: true, crawled: true }
  it('indexed + crawled + fresh => indexed', () => {
    expect(pageStatusToPill({ ...base, fresh: true })).toBe('indexed')
  })
  it('fresh undefined treated as fresh (not downgraded)', () => {
    expect(pageStatusToPill({ ...base })).toBe('indexed')
  })
  it('fresh === false => stale', () => {
    expect(pageStatusToPill({ ...base, fresh: false })).toBe('stale')
  })
  it('not indexed => not-indexed', () => {
    expect(pageStatusToPill({ url: 'u', indexed: false, crawled: false })).toBe('not-indexed')
  })
  it('indexed but not crawled => not-indexed', () => {
    expect(pageStatusToPill({ url: 'u', indexed: true, crawled: false })).toBe('not-indexed')
  })
})
