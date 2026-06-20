/**
 * WWW RAG bridge tests.
 *
 * Locks down the service-worker side of the WWW RAG integration — the two
 * OAuth-authed handlers that shape page-status / page-context results without
 * leaking the access token across the message boundary:
 *
 *   - internal:check-page    → handlePageCheck   → pill status
 *   - internal:page-context  → handlePageContext → URL-scoped chunks
 *
 * The handlers aren't individually exported, so (like the other bridge tests)
 * we drive them through the registered chrome.runtime.onMessage listener and
 * capture the async sendResponse. We mock @/background/divinci-auth
 * (authedFetch + isSignedIn), @/shared/logger, chrome.runtime.onMessage, and
 * chrome.storage.local (the privacy-settings read). sanitizeUrlForIndex and
 * the www-rag-api parsers are the REAL modules — pure + already-tested.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Mock divinci-auth BEFORE importing the bridge ----
const { authedFetchMock, isSignedInMock } = vi.hoisted(() => ({
  authedFetchMock: vi.fn(),
  isSignedInMock: vi.fn(),
}))
vi.mock('@/background/divinci-auth', () => ({
  authedFetch: authedFetchMock,
  isSignedIn: isSignedInMock,
}))

vi.mock('@/shared/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ---- chrome.runtime.onMessage + chrome.storage.local fakes ----
type Listener<T = unknown> = (...args: T[]) => unknown
interface ListenerHook<T = unknown> {
  addListener: (fn: Listener<T>) => void
  removeListener: (fn: Listener<T>) => void
  getListeners: () => Array<Listener<T>>
}
function makeHook<T = unknown>(): ListenerHook<T> {
  const listeners: Array<Listener<T>> = []
  return {
    addListener: (fn) => {
      listeners.push(fn)
    },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    getListeners: () => listeners.slice(),
  }
}

const onMessageHook = makeHook<unknown>()
// Stored settings the SW reads via chrome.storage.local.get; tests mutate it.
let storedSettings: Record<string, unknown> = {}
const storageGetMock = vi.fn(async () => storedSettings)

;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { onMessage: onMessageHook },
  storage: { local: { get: storageGetMock } },
}

// ---- Now import the system under test ----
import { setupWwwRagBridge } from './www-rag-bridge'
import { STORAGE_KEY_SETTINGS } from '@/shared/models'
import type {
  InternalPageCheckRequest,
  InternalPageCheckResponse,
  InternalPageContextRequest,
  InternalPageContextResponse,
  Message,
} from '@/shared/messages'

const GOOD_URL = 'https://example.com/docs/page?q=1#frag'
const SANITIZED = 'https://example.com/docs/page'

/**
 * Dispatch a message through the registered onMessage listener(s) and resolve
 * with the captured async sendResponse value. Returns null if no listener
 * called sendResponse (shouldn't happen for our two message types).
 */
function dispatch<T>(msg: Message): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false
    const sendResponse = (r?: unknown): void => {
      if (settled) return
      settled = true
      resolve((r ?? null) as T | null)
    }
    let handled = false
    for (const fn of onMessageHook.getListeners()) {
      const ret = fn(msg, {}, sendResponse)
      if (ret === true) handled = true
    }
    // If nothing claimed the async channel, resolve null on the next tick.
    if (!handled) queueMicrotask(() => resolve(null))
  })
}

function checkPage(url: string, hash?: string): Promise<InternalPageCheckResponse | null> {
  const req: InternalPageCheckRequest = { type: 'internal:check-page', url, hash }
  return dispatch<InternalPageCheckResponse>(req)
}

function pageContext(url: string, query = 'q'): Promise<InternalPageContextResponse | null> {
  const req: InternalPageContextRequest = { type: 'internal:page-context', url, query }
  return dispatch<InternalPageContextResponse>(req)
}

beforeEach(() => {
  onMessageHook.getListeners().forEach((fn) =>
    onMessageHook.removeListener(fn as Listener<unknown>),
  )
  authedFetchMock.mockReset()
  isSignedInMock.mockReset()
  storageGetMock.mockClear()
  storedSettings = {}
  setupWwwRagBridge()
})

describe('www-rag-bridge: handlePageCheck', () => {
  it('rejects an invalid (non-http) url as blacklisted, never hitting auth', async () => {
    const resp = await checkPage('not-a-url')
    expect(resp).toMatchObject({
      type: 'internal:page-status',
      status: 'blacklisted',
      reason: 'invalid-url',
    })
    expect(isSignedInMock).not.toHaveBeenCalled()
    expect(authedFetchMock).not.toHaveBeenCalled()
  })

  it('returns signed-out when not signed in, WITHOUT calling authedFetch', async () => {
    isSignedInMock.mockResolvedValue(false)
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'signed-out', url: SANITIZED })
    expect(authedFetchMock).not.toHaveBeenCalled()
  })

  it('returns signed-out when authedFetch reports signedOut', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: false, signedOut: true })
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'signed-out', url: SANITIZED })
  })

  it('maps a 503 to not-configured (WWW RAG not provisioned server-side)', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: true, status: 503, text: 'unavailable' })
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'not-configured', url: SANITIZED })
  })

  it('maps a non-2xx (e.g. 429) to error', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: true, status: 429, text: 'rate limited' })
    const resp = await checkPage(GOOD_URL)
    expect(resp?.status).toBe('error')
    expect(resp?.error).toContain('429')
  })

  it('maps a 500 to error', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: true, status: 500, text: 'boom' })
    const resp = await checkPage(GOOD_URL)
    expect(resp?.status).toBe('error')
    expect(resp?.error).toContain('500')
  })

  it('maps an unparseable 200 body to error', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: true, status: 200, text: '<html>nope</html>' })
    const resp = await checkPage(GOOD_URL)
    expect(resp?.status).toBe('error')
    expect(resp?.error).toContain('unparseable')
  })

  it('maps indexed+crawled+fresh to the indexed pill', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, indexed: true, crawled: true, fresh: true, version: 3 }),
    })
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'indexed', url: SANITIZED, fresh: true, version: 3 })
  })

  it('maps indexed+crawled+fresh:false to the stale pill', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, indexed: true, crawled: true, fresh: false }),
    })
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'stale', url: SANITIZED, fresh: false })
  })

  it('maps not-indexed body to the not-indexed pill', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, indexed: false, crawled: false }),
    })
    const resp = await checkPage(GOOD_URL)
    expect(resp).toMatchObject({ status: 'not-indexed', url: SANITIZED })
  })

  it('forwards the client hash into the page-status fetch url', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ indexed: true, crawled: true }),
    })
    await checkPage(GOOD_URL, 'abc123')
    const calledUrl = authedFetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('hash=abc123')
    // The query/fragment must have been stripped to origin+pathname.
    expect(calledUrl).toContain(encodeURIComponent(SANITIZED))
  })
})

describe('www-rag-bridge: handlePageContext', () => {
  it('returns ok with chunks on a well-formed 200', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({
        url: SANITIZED,
        chunks: [{ text: 'alpha', score: 0.9 }, { text: 'beta' }],
      }),
    })
    const resp = await pageContext(GOOD_URL)
    expect(resp?.ok).toBe(true)
    expect(resp?.url).toBe(SANITIZED)
    expect(resp?.chunks.map((c) => c.text)).toEqual(['alpha', 'beta'])
  })

  it('returns empty (ok:false) when not signed in', async () => {
    isSignedInMock.mockResolvedValue(false)
    const resp = await pageContext(GOOD_URL)
    expect(resp).toMatchObject({ ok: false, chunks: [] })
    expect(authedFetchMock).not.toHaveBeenCalled()
  })

  it('returns empty for an invalid url, never hitting auth', async () => {
    const resp = await pageContext('not-a-url')
    expect(resp).toMatchObject({ ok: false, chunks: [], error: 'invalid-url' })
    expect(isSignedInMock).not.toHaveBeenCalled()
    expect(authedFetchMock).not.toHaveBeenCalled()
  })

  it('returns empty on a non-2xx response', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: true, status: 500, text: 'boom' })
    const resp = await pageContext(GOOD_URL)
    expect(resp?.ok).toBe(false)
    expect(resp?.chunks).toEqual([])
  })

  it('returns empty when authedFetch reports signedOut', async () => {
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({ ok: false, signedOut: true })
    const resp = await pageContext(GOOD_URL)
    expect(resp).toMatchObject({ ok: false, chunks: [], error: 'not signed in' })
  })

  // ---- Privacy: grounding gate (client-enforced, authoritative in the SW) ----
  it('returns empty WITHOUT calling the server when wwwRagGrounding is false', async () => {
    storedSettings = { [STORAGE_KEY_SETTINGS]: { wwwRagGrounding: false } }
    isSignedInMock.mockResolvedValue(true)
    const resp = await pageContext(GOOD_URL)
    expect(resp).toMatchObject({ ok: true, url: SANITIZED, chunks: [] })
    // The query never left the device.
    expect(authedFetchMock).not.toHaveBeenCalled()
    expect(isSignedInMock).not.toHaveBeenCalled()
  })

  it('queries the server when wwwRagGrounding is undefined (default ON)', async () => {
    storedSettings = { [STORAGE_KEY_SETTINGS]: {} }
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, chunks: [{ text: 'x' }] }),
    })
    const resp = await pageContext(GOOD_URL)
    expect(resp?.ok).toBe(true)
    expect(authedFetchMock).toHaveBeenCalledOnce()
  })

  // ---- Privacy: data-use signal header (signal-only; server honors later) ----
  it('adds X-Divinci-Data-Use: none when allowChatDataUse is false', async () => {
    storedSettings = { [STORAGE_KEY_SETTINGS]: { allowChatDataUse: false } }
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, chunks: [] }),
    })
    await pageContext(GOOD_URL)
    const init = authedFetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Divinci-Data-Use']).toBe('none')
  })

  it('omits the data-use header when allowChatDataUse is not opted out', async () => {
    storedSettings = { [STORAGE_KEY_SETTINGS]: {} }
    isSignedInMock.mockResolvedValue(true)
    authedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ url: SANITIZED, chunks: [] }),
    })
    await pageContext(GOOD_URL)
    const init = authedFetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Divinci-Data-Use']).toBeUndefined()
  })
})
