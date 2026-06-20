/**
 * Divinci account auth bridge (service worker).
 *
 * Owns the Auth0 PKCE flow and the OAuth token bundle. The service worker is
 * the only context with chrome.identity + chrome.storage, so it:
 *   - runs interactive sign-in (popup → internal:divinci-signin)
 *   - persists tokens in chrome.storage.local (never broadcast to offscreen)
 *   - silently refreshes the access token on expiry / 401
 *   - performs the account-mode chat fetch on the offscreen's behalf
 *     (offscreen → internal:account-chat), so the token never leaves the SW.
 *
 * Pure URL/body/token shaping lives in shared/divinci-account.ts; PKCE crypto
 * in shared/pkce.ts.
 */

import { log } from '@/shared/logger'
import {
  DivinciAuthTokens,
  STORAGE_KEY_DIVINCI_AUTH,
  buildAuthorizeUrl,
  tokenEndpoint,
  buildCodeExchangeBody,
  buildRefreshBody,
  parseTokenResponse,
  isAccessTokenExpired,
  buildChatCompletionsUrl,
  buildChatCompletionsBody,
  parseChatCompletionResult,
} from '@/shared/divinci-account'
import { generateCodeVerifier, generateState, computeCodeChallenge } from '@/shared/pkce'
import type {
  Message,
  InternalDivinciAuthStatusResponse,
  InternalAccountChatRequest,
  InternalAccountChatResponse,
} from '@/shared/messages'

// ---- token storage ----

async function getStoredTokens(): Promise<DivinciAuthTokens | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_DIVINCI_AUTH)
  return (stored[STORAGE_KEY_DIVINCI_AUTH] as DivinciAuthTokens | undefined) ?? null
}

async function setStoredTokens(tokens: DivinciAuthTokens): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_DIVINCI_AUTH]: tokens })
}

async function clearStoredTokens(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_DIVINCI_AUTH)
}

// ---- token endpoint POST ----

async function postToken(body: string): Promise<DivinciAuthTokens> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  // Safe parse: token endpoint can return non-JSON on proxy/error.
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${text.substring(0, 200)}`)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.substring(0, 120)}`)
  }
  return parseTokenResponse(raw, Date.now())
}

// ---- interactive sign-in ----

export async function signIn(opts?: { signup?: boolean }): Promise<{
  signedIn: boolean
  email?: string
  name?: string
  picture?: string
  error?: string
}> {
  try {
    const redirectUri = chrome.identity.getRedirectURL()
    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const codeChallenge = await computeCodeChallenge(codeVerifier)
    const authUrl = buildAuthorizeUrl({ redirectUri, codeChallenge, state, signup: opts?.signup })

    const redirectResponse = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    })
    if (!redirectResponse) throw new Error('sign-in was cancelled')

    const url = new URL(redirectResponse)
    const returnedError = url.searchParams.get('error')
    if (returnedError) {
      throw new Error(`${returnedError}: ${url.searchParams.get('error_description') ?? ''}`)
    }
    if (url.searchParams.get('state') !== state) {
      throw new Error('state mismatch — possible CSRF, aborting')
    }
    const code = url.searchParams.get('code')
    if (!code) throw new Error('no authorization code in callback')

    const tokens = await postToken(buildCodeExchangeBody({ code, codeVerifier, redirectUri }))
    await setStoredTokens(tokens)
    log.info('[divinci-auth] signed in', { hasRefresh: Boolean(tokens.refreshToken) })
    return { signedIn: true, email: tokens.email, name: tokens.name, picture: tokens.picture }
  } catch (err) {
    log.error('[divinci-auth] sign-in failed:', err)
    return { signedIn: false, error: (err as Error).message ?? String(err) }
  }
}

export async function signOut(): Promise<void> {
  await clearStoredTokens()
  log.info('[divinci-auth] signed out')
}

export async function getAuthStatus(): Promise<{
  signedIn: boolean
  email?: string
  name?: string
  picture?: string
}> {
  const tokens = await getStoredTokens()
  if (!tokens) return { signedIn: false }
  return { signedIn: true, email: tokens.email, name: tokens.name, picture: tokens.picture }
}

// Single-flight refresh guard. The Auth0 app uses ROTATING refresh tokens, so
// two concurrent refreshes would race: the first rotates (invalidates) the
// token, the second then fails with an invalid-grant and burns the session.
// Sharing one in-flight promise makes concurrent callers await the same
// refresh. (check-then-assign is atomic — no await between them.)
let refreshInFlight: Promise<DivinciAuthTokens | null> | null = null

function refreshTokens(current: DivinciAuthTokens): Promise<DivinciAuthTokens | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      if (!current.refreshToken) return null
      const refreshed = await postToken(buildRefreshBody(current.refreshToken))
      // Carry the prior refresh token forward if the response omitted one
      // (defensive — rotation normally returns a fresh one).
      if (!refreshed.refreshToken) refreshed.refreshToken = current.refreshToken
      // Carry the profile forward: Auth0 refresh responses usually omit the
      // id_token, so parseTokenResponse leaves email/name/picture undefined.
      // Without this, the popup avatar/name would vanish ~1h in (on first
      // refresh). The profile is stable across the session, so preserve it.
      if (!refreshed.email) refreshed.email = current.email
      if (!refreshed.name) refreshed.name = current.name
      if (!refreshed.picture) refreshed.picture = current.picture
      await setStoredTokens(refreshed)
      return refreshed
    } catch (err) {
      log.error('[divinci-auth] token refresh failed:', err)
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Return a non-expired access token, refreshing via the refresh token when
 * needed. Returns null when not signed in or the refresh failed (caller should
 * prompt re-sign-in).
 */
async function getValidAccessToken(): Promise<string | null> {
  const tokens = await getStoredTokens()
  if (!tokens) return null
  if (!isAccessTokenExpired(tokens, Date.now())) return tokens.accessToken
  const refreshed = await refreshTokens(tokens)
  return refreshed?.accessToken ?? null
}

// ---- account-mode chat fetch (on the offscreen's behalf) ----

// Conversation → server transcriptId, so multi-turn context is preserved. The
// endpoint adds only messages[last] to the transcript and draws prior context
// from the transcript's own messages, so without a reused transcriptId every
// turn is context-less + orphans a transcript. In-memory: an SW eviction
// mid-conversation resets it (next turn starts a fresh transcript — harmless).
const transcriptByConversation = new Map<string, string>()

/** FNV-1a 32-bit hash → short base36. Cheap, stable, no crypto needed. */
function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Key a conversation by its (immutable) first user message + workspace. Best
 * available heuristic — the extension has no thread id from the web app. Two
 * conversations that open with the identical first message would share a
 * transcript; acceptable for a single user's own workspace.
 */
function conversationKey(workspaceId: string, messages: InternalAccountChatRequest['messages']): string {
  return `${workspaceId}::${hashString(messages[0]?.content ?? '')}`
}

export async function accountChat(req: InternalAccountChatRequest): Promise<InternalAccountChatResponse> {
  try {
    let token = await getValidAccessToken()
    if (!token) return { type: 'internal:account-chat-response', ok: false, error: 'not signed in' }

    const url = buildChatCompletionsUrl(req.workspaceId)
    const convKey = conversationKey(req.workspaceId, req.messages)
    const body = buildChatCompletionsBody({
      messages: req.messages,
      releaseId: req.releaseId,
      transcriptId: transcriptByConversation.get(convKey),
    })

    let res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })

    // One refresh-and-retry on 401 (token rotated/expired between checks).
    if (res.status === 401) {
      await clearTokenExpiry()
      token = await getValidAccessToken()
      if (token) {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
        })
      }
    }

    const text = await res.text()
    if (!res.ok) {
      return {
        type: 'internal:account-chat-response',
        ok: false,
        error: `server ${res.status}: ${text.substring(0, 200)}`,
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return {
        type: 'internal:account-chat-response',
        ok: false,
        error: `non-JSON response (${res.status}): ${text.substring(0, 120)}`,
      }
    }
    const result = parseChatCompletionResult(raw)
    // Remember the transcript so the next turn of this conversation reuses it.
    if (result.transcriptId) transcriptByConversation.set(convKey, result.transcriptId)
    return { type: 'internal:account-chat-response', ok: true, text: result.text }
  } catch (err) {
    return { type: 'internal:account-chat-response', ok: false, error: (err as Error).message ?? String(err) }
  }
}

/** Force the next getValidAccessToken() to refresh (used after a 401). */
async function clearTokenExpiry(): Promise<void> {
  const tokens = await getStoredTokens()
  if (tokens) await setStoredTokens({ ...tokens, expiresAt: 0 })
}

// ---- message bridge ----

export function setupDivinciAuthBridge(): void {
  chrome.runtime.onMessage.addListener(
    (msg: Message, _sender, sendResponse: (r?: unknown) => void) => {
      switch (msg?.type) {
        case 'internal:divinci-signin':
          void signIn({ signup: msg.signup }).then((r) => {
            const resp: InternalDivinciAuthStatusResponse = {
              type: 'internal:divinci-auth-status-response',
              signedIn: r.signedIn,
              email: r.email,
              name: r.name,
              picture: r.picture,
              error: r.error,
            }
            sendResponse(resp)
          })
          return true
        case 'internal:divinci-signout':
          void signOut().then(() => {
            const resp: InternalDivinciAuthStatusResponse = {
              type: 'internal:divinci-auth-status-response',
              signedIn: false,
            }
            sendResponse(resp)
          })
          return true
        case 'internal:divinci-auth-status':
          void getAuthStatus().then((s) => {
            const resp: InternalDivinciAuthStatusResponse = {
              type: 'internal:divinci-auth-status-response',
              signedIn: s.signedIn,
              email: s.email,
              name: s.name,
              picture: s.picture,
            }
            sendResponse(resp)
          })
          return true
        case 'internal:account-chat':
          void accountChat(msg).then((r) => sendResponse(r))
          return true
        default:
          return undefined
      }
    },
  )
}
