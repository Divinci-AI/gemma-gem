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
  buildCreateChatUrl,
  buildCreateChatBody,
  parseCreatedChat,
  buildChatIngestUrl,
  buildIngestBatchBody,
  buildShareApiUrl,
  parseShareToken,
  buildPublicShareLink,
} from '@/shared/divinci-account'
import { generateCodeVerifier, generateState, computeCodeChallenge } from '@/shared/pkce'
import { STORAGE_KEY_SETTINGS, type UserSettings } from '@/shared/models'
import type {
  Message,
  InternalDivinciAuthStatusResponse,
  InternalAccountChatRequest,
  InternalAccountChatResponse,
  InternalAccountMirrorRequest,
  InternalAccountMirrorResponse,
  InternalAccountShareRequest,
  InternalAccountShareResponse,
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

/** Lightweight check the bridges use to short-circuit to a "signed-out" reply. */
export async function isSignedIn(): Promise<boolean> {
  return (await getStoredTokens()) !== null
}

/**
 * Result of an OAuth-authed fetch performed inside the SW. The access token
 * stays SW-owned and never crosses a message boundary — only this shaped
 * result does. `signedOut` distinguishes "no/expired session" (re-sign-in)
 * from a transport/HTTP error.
 */
export type AuthedFetchResult =
  | { ok: true; status: number; text: string }
  | { ok: false; signedOut: true }
  | { ok: false; signedOut: false; status?: number; error: string }

/**
 * Perform an OAuth-authed fetch with the SW-held access token: valid-token
 * fetch → on 401, force-refresh once and retry → return the raw body text for
 * the caller to safe-parse. This is the exact token machinery accountChat uses
 * (getValidAccessToken + Bearer + refresh-on-401), factored out so the WWW RAG
 * bridge reuses it without duplicating the refresh logic or seeing the token.
 */
export async function authedFetch(
  url: string,
  init?: RequestInit,
): Promise<AuthedFetchResult> {
  try {
    let token = await getValidAccessToken()
    if (!token) return { ok: false, signedOut: true }

    const withAuth = (t: string): RequestInit => ({
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}` },
    })

    let res = await fetch(url, withAuth(token))

    // One refresh-and-retry on 401 (token rotated/expired between checks).
    if (res.status === 401) {
      await clearTokenExpiry()
      token = await getValidAccessToken()
      if (!token) return { ok: false, signedOut: true }
      res = await fetch(url, withAuth(token))
      // Still 401 after a fresh token => the session is genuinely dead.
      if (res.status === 401) return { ok: false, signedOut: true }
    }

    const text = await res.text()
    return { ok: true, status: res.status, text }
  } catch (err) {
    return { ok: false, signedOut: false, error: (err as Error).message ?? String(err) }
  }
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

/**
 * Read the user's "allow chat data use" preference from chrome.storage. Default
 * ON: an undefined/never-saved value means data-use is allowed (no opt-out
 * header). Only an explicit `false` flips it to opted-out.
 */
async function readAllowChatDataUse(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
    const s = stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings> | undefined
    return s?.allowChatDataUse !== false
  } catch {
    return true
  }
}

// ---- account AIChat mirror (save signed-in chats to Divinci) ---------------

/**
 * Mirror a local conversation's tail to the user's Divinci account as an
 * AIChat: create the chat on first mirror, then batch-ingest the messages
 * verbatim (no inference). AIChats are owner-scoped — no workspace needed —
 * so they appear in the web app's chat list and can be publicly shared.
 * Skips silently when not signed in.
 */
export async function mirrorConversation(
  req: InternalAccountMirrorRequest,
): Promise<InternalAccountMirrorResponse> {
  const RESP = 'internal:account-mirror-response' as const
  try {
    let chatId = req.serverChatId
    let transcriptId: string | undefined
    if (!chatId) {
      const created = await authedFetch(buildCreateChatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildCreateChatBody(req.title),
      })
      if (!created.ok) {
        return created.signedOut
          ? { type: RESP, ok: false, skipped: 'not-signed-in' }
          : { type: RESP, ok: false, error: created.error ?? 'create-chat failed' }
      }
      if ((created.status ?? 0) >= 400) {
        return { type: RESP, ok: false, error: `server ${created.status}: ${(created.text ?? '').substring(0, 160)}` }
      }
      try {
        const ids = parseCreatedChat(JSON.parse(created.text ?? ''))
        chatId = ids.chatId
        transcriptId = ids.transcriptId
      } catch (e) {
        return { type: RESP, ok: false, error: (e as Error).message }
      }
    }

    if (req.items.length > 0) {
      const ing = await authedFetch(buildChatIngestUrl(chatId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildIngestBatchBody(req.items),
      })
      if (!ing.ok) {
        return ing.signedOut
          ? { type: RESP, ok: false, skipped: 'not-signed-in' }
          : { type: RESP, ok: false, error: ing.error ?? 'ingest-batch failed' }
      }
      if ((ing.status ?? 0) >= 400) {
        return { type: RESP, ok: false, error: `server ${ing.status}: ${(ing.text ?? '').substring(0, 160)}` }
      }
    }

    return { type: RESP, ok: true, serverChatId: chatId, serverTranscriptId: transcriptId }
  } catch (err) {
    return { type: RESP, ok: false, error: (err as Error).message ?? String(err) }
  }
}

/**
 * Mint (or fetch the existing) public share link for an already-mirrored
 * AIChat. Returns the embed viewer URL the user can copy/share. Skips silently
 * when not signed in.
 */
export async function shareConversation(
  req: InternalAccountShareRequest,
): Promise<InternalAccountShareResponse> {
  const RESP = 'internal:account-share-response' as const
  try {
    const shared = await authedFetch(buildShareApiUrl(req.serverChatId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!shared.ok) {
      return shared.signedOut
        ? { type: RESP, ok: false, skipped: 'not-signed-in' }
        : { type: RESP, ok: false, error: shared.error ?? 'share failed' }
    }
    if ((shared.status ?? 0) >= 400) {
      return { type: RESP, ok: false, error: `server ${shared.status}: ${(shared.text ?? '').substring(0, 160)}` }
    }
    try {
      const token = parseShareToken(JSON.parse(shared.text ?? ''))
      return { type: RESP, ok: true, shareUrl: buildPublicShareLink(token) }
    } catch (e) {
      return { type: RESP, ok: false, error: (e as Error).message }
    }
  } catch (err) {
    return { type: RESP, ok: false, error: (err as Error).message ?? String(err) }
  }
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

    // Data-use signal only: when the user has opted out (allowChatDataUse ===
    // false), tell the server not to use this chat to improve services.
    // SERVER-SIDE ENFORCEMENT IS A SEPARATE TODO — the extension only signals
    // the preference; it does not (and cannot) enforce server behaviour.
    const allowChatDataUse = await readAllowChatDataUse()
    const headers = (t: string): Record<string, string> => {
      const h: Record<string, string> = {
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/json',
      }
      if (!allowChatDataUse) h['X-Divinci-Data-Use'] = 'none'
      return h
    }

    let res = await fetch(url, { method: 'POST', headers: headers(token), body })

    // One refresh-and-retry on 401 (token rotated/expired between checks).
    if (res.status === 401) {
      await clearTokenExpiry()
      token = await getValidAccessToken()
      if (token) {
        res = await fetch(url, { method: 'POST', headers: headers(token), body })
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
        case 'internal:account-mirror':
          void mirrorConversation(msg).then((r) => sendResponse(r))
          return true
        case 'internal:account-share':
          void shareConversation(msg).then((r) => sendResponse(r))
          return true
        default:
          return undefined
      }
    },
  )
}
