import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeWebSearch } from './web-search'

describe('executeWebSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('Brave Search provider', () => {
    it('returns formatted results on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: 'Result One', url: 'https://example.com/1', description: 'First result' },
              { title: 'Result Two', url: 'https://example.com/2', description: 'Second result' },
            ],
          },
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await executeWebSearch(
        { query: 'test query', count: 2 },
        { braveApiKey: 'brave-key' },
      )

      expect(result).toContain('Search results for "test query"')
      expect(result).toContain('1. Result One')
      expect(result).toContain('URL: https://example.com/1')
      expect(result).toContain('First result')
      expect(result).toContain('2. Result Two')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toContain('api.search.brave.com')
      expect(callUrl).toContain('q=test+query')
      expect(callUrl).toContain('count=2')

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['X-Subscription-Token']).toBe('brave-key')
    })

    it('returns empty message when no results found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await executeWebSearch(
        { query: 'nothing' },
        { braveApiKey: 'key' },
      )
      expect(result).toBe('No results found for "nothing".')
    })

    it('throws on HTTP error from Brave', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      })
      vi.stubGlobal('fetch', mockFetch)

      await expect(
        executeWebSearch({ query: 'x' }, { braveApiKey: 'bad' }),
      ).rejects.toThrow('Brave Search API error 403')
    })
  })

  describe('Serper provider', () => {
    it('returns formatted results on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          organic: [
            { title: 'Serper Result', link: 'https://serper.example.com', snippet: 'Found via Serper' },
          ],
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await executeWebSearch(
        { query: 'serper query', count: 3 },
        { serperApiKey: 'serper-key' },
      )

      expect(result).toContain('Search results for "serper query"')
      expect(result).toContain('1. Serper Result')
      expect(result).toContain('URL: https://serper.example.com')
      expect(result).toContain('Found via Serper')

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.q).toBe('serper query')
      expect(callBody.num).toBe(3)

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['X-API-KEY']).toBe('serper-key')
    })

    it('throws on HTTP error from Serper', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      })
      vi.stubGlobal('fetch', mockFetch)

      await expect(
        executeWebSearch({ query: 'x' }, { serperApiKey: 'bad' }),
      ).rejects.toThrow('Serper API error 401')
    })
  })

  describe('provider selection', () => {
    it('prefers Brave when both keys are configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      })
      vi.stubGlobal('fetch', mockFetch)

      await executeWebSearch(
        { query: 'prefer brave' },
        { braveApiKey: 'brave-key', serperApiKey: 'serper-key' },
      )

      const callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toContain('api.search.brave.com')
    })

    it('returns error message when no API key configured', async () => {
      const result = await executeWebSearch(
        { query: 'no key' },
        {},
      )
      expect(result).toContain('Error')
      expect(result).toContain('No search API key configured')
    })
  })

  describe('count parameter', () => {
    it('defaults to 5 results when count is omitted', async () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        description: `Desc ${i}`,
      }))
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results } }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await executeWebSearch(
        { query: 'default count' },
        { braveApiKey: 'key' },
      )

      // Should only have 5 results when count not specified
      const match = result.match(/\d+\./g)
      expect(match).toHaveLength(5)
    })
  })
})
