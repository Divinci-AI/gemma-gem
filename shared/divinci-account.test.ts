import { describe, it, expect } from 'vitest'
import {
  DIVINCI_AUTH,
  buildAuthorizeUrl,
  buildCodeExchangeBody,
  buildRefreshBody,
  parseTokenResponse,
  isAccessTokenExpired,
  decodeJwtEmail,
  buildChatCompletionsUrl,
  buildChatCompletionsBody,
  parseChatCompletion,
  TOKEN_EXPIRY_SKEW_MS,
} from '@/shared/divinci-account'

const REDIRECT = 'https://laeebjagghfeepomjhbfohefghonemeo.chromiumapp.org/'

describe('buildAuthorizeUrl', () => {
  it('targets the staging tenant with PKCE S256 + audience + state', () => {
    const url = new URL(buildAuthorizeUrl({ redirectUri: REDIRECT, codeChallenge: 'CH', state: 'ST' }))
    expect(url.origin + url.pathname).toBe(`https://${DIVINCI_AUTH.domain}/authorize`)
    const p = url.searchParams
    expect(p.get('response_type')).toBe('code')
    expect(p.get('client_id')).toBe(DIVINCI_AUTH.clientId)
    expect(p.get('redirect_uri')).toBe(REDIRECT)
    expect(p.get('audience')).toBe(DIVINCI_AUTH.audience)
    expect(p.get('code_challenge')).toBe('CH')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('state')).toBe('ST')
    expect(p.get('scope')).toContain('offline_access')
  })
})

describe('token request bodies', () => {
  it('code exchange carries grant_type + code_verifier + redirect_uri', () => {
    const body = new URLSearchParams(
      buildCodeExchangeBody({ code: 'C', codeVerifier: 'V', redirectUri: REDIRECT }),
    )
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('C')
    expect(body.get('code_verifier')).toBe('V')
    expect(body.get('redirect_uri')).toBe(REDIRECT)
    expect(body.get('client_id')).toBe(DIVINCI_AUTH.clientId)
  })

  it('refresh body carries grant_type=refresh_token', () => {
    const body = new URLSearchParams(buildRefreshBody('RT'))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
  })
})

describe('parseTokenResponse', () => {
  it('computes expiresAt from now + expires_in and decodes email from id_token', () => {
    // id_token with payload {"email":"a@b.co"} (base64url, unsigned — we only read claims).
    const payload = Buffer.from(JSON.stringify({ email: 'a@b.co' })).toString('base64url')
    const idToken = `h.${payload}.s`
    const t = parseTokenResponse(
      { access_token: 'AT', refresh_token: 'RT', id_token: idToken, expires_in: 3600 },
      1_000,
    )
    expect(t.accessToken).toBe('AT')
    expect(t.refreshToken).toBe('RT')
    expect(t.expiresAt).toBe(1_000 + 3600_000)
    expect(t.email).toBe('a@b.co')
  })

  it('carries the prior refresh token forward when the response omits one', () => {
    const t = parseTokenResponse({ access_token: 'AT2', expires_in: 300 }, 0, 'PREV_RT')
    expect(t.refreshToken).toBe('PREV_RT')
  })

  it('throws when access_token is missing', () => {
    expect(() => parseTokenResponse({}, 0)).toThrow(/access_token/)
  })
})

describe('isAccessTokenExpired', () => {
  const tokens = { accessToken: 'x', expiresAt: 100_000 }
  it('is false well before expiry', () => {
    expect(isAccessTokenExpired(tokens, 100_000 - TOKEN_EXPIRY_SKEW_MS - 1)).toBe(false)
  })
  it('is true once within the skew window (renew early)', () => {
    expect(isAccessTokenExpired(tokens, 100_000 - TOKEN_EXPIRY_SKEW_MS)).toBe(true)
  })
})

describe('decodeJwtEmail', () => {
  it('returns undefined for a malformed token rather than throwing', () => {
    expect(decodeJwtEmail('not-a-jwt')).toBeUndefined()
  })
})

describe('chat completions shaping', () => {
  it('builds the workspace-scoped staging URL', () => {
    expect(buildChatCompletionsUrl('ws123')).toBe(
      'https://api.stage.divinci.app/api/v1/workspaces/ws123/chat/completions',
    )
  })
  it('omits releaseId from the body when not provided', () => {
    expect(JSON.parse(buildChatCompletionsBody({ messages: [{ role: 'user', content: 'hi' }] }))).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    })
  })
  it('includes releaseId when provided', () => {
    const b = JSON.parse(buildChatCompletionsBody({ messages: [], releaseId: 'rel1' }))
    expect(b.releaseId).toBe('rel1')
  })
})

describe('parseChatCompletion', () => {
  it('extracts the assistant content', () => {
    expect(
      parseChatCompletion({ choices: [{ message: { content: 'the answer' } }] }),
    ).toBe('the answer')
  })
  it('surfaces a server error object as a thrown error', () => {
    expect(() => parseChatCompletion({ error: { message: 'nope' } })).toThrow(/nope/)
  })
  it('throws when there is no content', () => {
    expect(() => parseChatCompletion({ choices: [] })).toThrow(/no assistant content/)
  })
})
