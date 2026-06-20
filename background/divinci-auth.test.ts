import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { STORAGE_KEY_DIVINCI_AUTH, tokenEndpoint } from '@/shared/divinci-account'

// In-memory chrome.storage.local + a URL-branching fetch mock, so we can drive
// accountChat's token-refresh + 401-retry orchestration without a browser.

let store: Record<string, unknown> = {}
const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj) }),
      remove: vi.fn(async (key: string) => { delete store[key] }),
    },
  },
}
;(globalThis as unknown as { chrome: unknown }).chrome = chromeMock

function mkRes(status: number, bodyObj: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(bodyObj) } as Response
}

// Default: token endpoint issues AT2; chat endpoint answers. Tests override.
const fetchMock = vi.fn()
;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

import { accountChat, mirrorConversation } from '@/background/divinci-auth'

const SETTINGS_KEY = 'divinci_local_settings'

const COMPLETION = { choices: [{ message: { content: 'the answer' } }], transcriptId: 'T1' }

function validTokens() {
  return { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 }
}

beforeEach(() => {
  store = {}
  fetchMock.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('accountChat', () => {
  it('returns "not signed in" without fetching when no tokens are stored', async () => {
    const r = await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'q1' }], workspaceId: 'ws' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a Bearer token and returns the assistant text on 200', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    fetchMock.mockResolvedValue(mkRes(200, COMPLETION))
    const r = await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'unique-a' }], workspaceId: 'ws' })
    expect(r).toMatchObject({ ok: true, text: 'the answer' })
    const [, opts] = fetchMock.mock.calls[0]
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' })
  })

  it('reuses the transcriptId on the next turn of the same conversation', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    fetchMock.mockResolvedValue(mkRes(200, COMPLETION))
    const msg = { role: 'user' as const, content: 'unique-b' }
    await accountChat({ type: 'internal:account-chat', messages: [msg], workspaceId: 'ws' })
    await accountChat({ type: 'internal:account-chat', messages: [msg, { role: 'assistant', content: 'a' }, { role: 'user', content: 'follow up' }], workspaceId: 'ws' })
    // First call: no transcriptId. Second call: carries T1 from the first response.
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).transcriptId).toBeUndefined()
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).transcriptId).toBe('T1')
  })

  it('refreshes an expired access token before calling chat', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 }
    fetchMock.mockImplementation(async (url: string) =>
      url === tokenEndpoint()
        ? mkRes(200, { access_token: 'AT2', expires_in: 3600 })
        : mkRes(200, COMPLETION),
    )
    const r = await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'unique-c' }], workspaceId: 'ws' })
    expect(r.ok).toBe(true)
    const tokenCall = fetchMock.mock.calls.find((c) => c[0] === tokenEndpoint())
    const chatCall = fetchMock.mock.calls.find((c) => c[0] !== tokenEndpoint())
    expect(tokenCall).toBeDefined()
    expect((chatCall![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT2' })
  })

  it('refreshes and retries once on a 401, then succeeds', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    let chatCalls = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === tokenEndpoint()) return mkRes(200, { access_token: 'AT2', expires_in: 3600 })
      chatCalls += 1
      return chatCalls === 1 ? mkRes(401, { error: 'expired' }) : mkRes(200, COMPLETION)
    })
    const r = await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'unique-d' }], workspaceId: 'ws' })
    expect(r).toMatchObject({ ok: true, text: 'the answer' })
    expect(chatCalls).toBe(2) // initial 401 + retry
    expect(fetchMock.mock.calls.some((c) => c[0] === tokenEndpoint())).toBe(true)
  })

  it('preserves the profile (name/picture/email) across a refresh that omits id_token', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = {
      accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0,
      email: 'a@b.co', name: 'Ada L', picture: 'https://x/p.png',
    }
    fetchMock.mockImplementation(async (url: string) =>
      url === tokenEndpoint()
        ? mkRes(200, { access_token: 'AT2', expires_in: 3600 }) // no id_token in refresh
        : mkRes(200, COMPLETION),
    )
    await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'unique-f' }], workspaceId: 'ws' })
    const stored = store[STORAGE_KEY_DIVINCI_AUTH] as { name?: string; picture?: string; email?: string; accessToken: string }
    expect(stored.accessToken).toBe('AT2') // refreshed
    expect(stored).toMatchObject({ email: 'a@b.co', name: 'Ada L', picture: 'https://x/p.png' }) // profile kept
  })

  it('surfaces a non-401 server error without retrying', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    fetchMock.mockResolvedValue(mkRes(500, { error: { message: 'boom' } }))
    const r = await accountChat({ type: 'internal:account-chat', messages: [{ role: 'user', content: 'unique-e' }], workspaceId: 'ws' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/server 500/)
  })
})

describe('mirrorConversation', () => {
  const mirrorReq = (over: Record<string, unknown> = {}) => ({
    type: 'internal:account-mirror' as const,
    title: 'Sky lights',
    items: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ],
    ...over,
  })

  it('skips (no-workspace) when no workspace is configured, without fetching', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    const r = await mirrorConversation(mirrorReq())
    expect(r).toMatchObject({ ok: false, skipped: 'no-workspace' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips (not-signed-in) when a workspace is set but no token', async () => {
    store[SETTINGS_KEY] = { divinciWorkspaceId: 'ws1' }
    const r = await mirrorConversation(mirrorReq())
    expect(r).toMatchObject({ ok: false, skipped: 'not-signed-in' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a transcript then batch-ingests when not yet mirrored', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    store[SETTINGS_KEY] = { divinciWorkspaceId: 'ws1' }
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/message/batch')
        ? mkRes(200, { status: 'ok', inserted: 2 })
        : mkRes(201, { _id: 'srv1' }),
    )
    const r = await mirrorConversation(mirrorReq())
    expect(r).toMatchObject({ ok: true, serverTranscriptId: 'srv1' })
    const created = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/transcript/'))
    const ingested = fetchMock.mock.calls.find((c) => String(c[0]).includes('/message/batch'))
    expect(created).toBeDefined()
    expect(ingested).toBeDefined()
    // ingest targets the created transcript id
    expect(String(ingested![0])).toContain('/transcript/srv1/message/batch')
  })

  it('reuses an existing serverTranscriptId (no create, only ingest)', async () => {
    store[STORAGE_KEY_DIVINCI_AUTH] = validTokens()
    store[SETTINGS_KEY] = { divinciWorkspaceId: 'ws1' }
    fetchMock.mockResolvedValue(mkRes(200, { status: 'ok', inserted: 2 }))
    const r = await mirrorConversation(mirrorReq({ serverTranscriptId: 'srvX' }))
    expect(r).toMatchObject({ ok: true, serverTranscriptId: 'srvX' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/transcript/srvX/message/batch')
  })
})
