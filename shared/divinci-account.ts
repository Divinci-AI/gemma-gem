/**
 * Divinci account (Auth0 PKCE) configuration + pure request/response shaping.
 *
 * "Account mode": instead of the user pasting Cloudflare/Brave/Serper tokens,
 * they sign into their Divinci account (Auth0 PKCE) and the extension proxies
 * tool-calling through stage.divinci.app, which runs the Kimi web-search loop
 * with SERVER-held keys. This is the STAGING build — domain/audience/client_id
 * below all point at the divinci-staging tenant + api.stage.divinci.app.
 *
 * Everything here is pure (URL/body shaping, token parsing). The chrome.identity
 * orchestration that uses it lives in background/divinci-auth.ts (service worker).
 */

/** Auth0 staging SPA application dedicated to this extension (PKCE, no secret). */
export const DIVINCI_AUTH = {
  domain: 'divinci-staging.us.auth0.com',
  clientId: '6sk4DHy694PMCpToUkIYODnkvffyzfGY',
  /** Public-API audience the access token must be minted for. */
  audience: 'chat.stage.divinci.app:8080',
  /** offline_access → refresh token so we can silently renew. */
  scope: 'openid profile email offline_access',
} as const

/** Staging public API base. The extension is a staging/testing build. */
export const DIVINCI_API_BASE = 'https://api.stage.divinci.app'

/** chrome.storage.local key for the OAuth token bundle (SW-owned; never sent to offscreen). */
export const STORAGE_KEY_DIVINCI_AUTH = 'divinci_oauth_tokens'

/** Renew this many ms before the access token's real expiry (clock skew + latency buffer). */
export const TOKEN_EXPIRY_SKEW_MS = 60_000

export interface DivinciAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  /** Cached from the id_token for display in the popup. */
  email?: string
  /** Display name from the id_token's `name` claim, for the popup avatar/menu. */
  name?: string
  /** Avatar URL from the id_token's `picture` claim, for the popup avatar. */
  picture?: string
}

// ---- /authorize ----

/**
 * Build the Auth0 /authorize URL for an Authorization-Code + PKCE round trip.
 * `redirectUri` MUST equal chrome.identity.getRedirectURL() and be registered
 * verbatim as an Allowed Callback URL on the Auth0 app.
 */
export function buildAuthorizeUrl(opts: {
  redirectUri: string
  codeChallenge: string
  state: string
}): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: DIVINCI_AUTH.clientId,
    redirect_uri: opts.redirectUri,
    scope: DIVINCI_AUTH.scope,
    audience: DIVINCI_AUTH.audience,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
    // Force account selection so a stale SSO session doesn't silently bind
    // the extension to the wrong account on first interactive sign-in.
    prompt: 'login',
  })
  return `https://${DIVINCI_AUTH.domain}/authorize?${p.toString()}`
}

/** The token endpoint. */
export function tokenEndpoint(): string {
  return `https://${DIVINCI_AUTH.domain}/oauth/token`
}

/** Body for exchanging an authorization code (PKCE) for tokens. */
export function buildCodeExchangeBody(opts: {
  code: string
  codeVerifier: string
  redirectUri: string
}): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: DIVINCI_AUTH.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  }).toString()
}

/** Body for refreshing an access token with a refresh token. */
export function buildRefreshBody(refreshToken: string): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: DIVINCI_AUTH.clientId,
    refresh_token: refreshToken,
  }).toString()
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  token_type?: string
}

/**
 * Parse a /oauth/token response into our token bundle. `nowMs` is injected so
 * the expiry math is deterministic in tests. `prevRefreshToken` is carried
 * forward when a refresh response omits a new one (no rotation).
 */
export function parseTokenResponse(
  raw: RawTokenResponse,
  nowMs: number,
  prevRefreshToken?: string,
): DivinciAuthTokens {
  if (!raw.access_token) throw new Error('Token response missing access_token')
  const expiresInMs = (raw.expires_in ?? 3600) * 1000
  const profile = raw.id_token ? decodeJwtProfile(raw.id_token) : {}
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? prevRefreshToken,
    expiresAt: nowMs + expiresInMs,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  }
}

/** True when the access token is expired (or within the skew window). */
export function isAccessTokenExpired(tokens: DivinciAuthTokens, nowMs: number): boolean {
  return nowMs >= tokens.expiresAt - TOKEN_EXPIRY_SKEW_MS
}

/**
 * Best-effort decode of the display-relevant claims from a JWT id_token. The
 * token is NOT verified here — we only read claims for UI display. Defensive:
 * any malformed input yields an empty object.
 */
export function decodeJwtProfile(idToken: string): {
  email?: string
  name?: string
  picture?: string
} {
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return {}
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as {
      email?: string
      name?: string
      picture?: string
    }
    return {
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      picture: typeof claims.picture === 'string' ? claims.picture : undefined,
    }
  } catch {
    return {}
  }
}

/** Best-effort extract of the `email` (or `name`/`sub`) claim from a JWT id_token. */
export function decodeJwtEmail(idToken: string): string | undefined {
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return undefined
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { email?: string; name?: string; sub?: string }
    return claims.email ?? claims.name ?? claims.sub
  } catch {
    return undefined
  }
}

// ---- chat completions ----

/** OAuth workspace-scoped chat completions URL on the staging public API. */
export function buildChatCompletionsUrl(workspaceId: string): string {
  return `${DIVINCI_API_BASE}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/completions`
}

export interface AccountChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Request body for the workspace chat-completions endpoint.
 *
 * `transcriptId` reuses a server-side transcript across turns of one
 * conversation. This is REQUIRED for multi-turn context: the endpoint only
 * adds `messages[last]` to the transcript and draws prior context from the
 * transcript's existing messages — so without a stable transcriptId, every
 * turn is context-less (and orphans a fresh transcript).
 */
export function buildChatCompletionsBody(opts: {
  messages: AccountChatMessage[]
  releaseId?: string
  transcriptId?: string
}): string {
  const body: Record<string, unknown> = { messages: opts.messages }
  if (opts.releaseId) body.releaseId = opts.releaseId
  if (opts.transcriptId) body.transcriptId = opts.transcriptId
  return JSON.stringify(body)
}

/**
 * Extract the assistant text from an OpenAI-compatible completion response.
 * Throws a descriptive error if the shape is unexpected (so the caller surfaces
 * a useful message rather than "undefined").
 */
export function parseChatCompletion(raw: unknown): string {
  return parseChatCompletionResult(raw).text
}

/**
 * Parse the completion response into { text, transcriptId }. The staging
 * endpoint returns transcriptId at the top level; callers persist it to reuse
 * the transcript on the next turn (see buildChatCompletionsBody).
 */
export function parseChatCompletionResult(raw: unknown): { text: string; transcriptId?: string } {
  const obj = raw as {
    choices?: Array<{ message?: { content?: string } }>
    transcriptId?: string
    error?: { message?: string; code?: string }
  }
  if (obj?.error) {
    throw new Error(obj.error.message || obj.error.code || 'chat completion error')
  }
  const content = obj?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('chat completion response had no assistant content')
  }
  return { text: content, transcriptId: typeof obj.transcriptId === 'string' ? obj.transcriptId : undefined }
}
