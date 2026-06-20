/**
 * WWW RAG bridge (service worker).
 *
 * Replaces the old manual X-API-Key page-check (background/divinci-api-bridge.ts
 * + shared/divinci-api.ts). WWW RAG is one global, system-owned Divinci corpus
 * (agent-handoff-page-indexing.md); the extension queries it as the signed-in
 * Divinci user over OAuth Bearer — no API keys, no whitelabel id.
 *
 * Two handlers, both OAuth-authed via the SW-owned token machinery
 * (authedFetch: valid token + Bearer + refresh-on-401). The token never leaves
 * the SW — only shaped results cross the message boundary:
 *
 *   - internal:check-page    → GET  page-status → pill status
 *   - internal:page-context  → POST page-context → URL-scoped chunks (grounding)
 *
 * Pure URL/body shaping + safe parsing lives in shared/www-rag-api.ts.
 */

import { log } from '@/shared/logger'
import { authedFetch, isSignedIn } from '@/background/divinci-auth'
import { sanitizeUrlForIndex } from '@/shared/url-policy'
import { STORAGE_KEY_SETTINGS, type UserSettings } from '@/shared/models'
import {
  buildPageStatusUrl,
  parsePageStatusResponse,
  buildPageContextUrl,
  buildPageContextBody,
  parsePageContextResponse,
  pageStatusToPill,
} from '@/shared/www-rag-api'
import type {
  InternalPageCheckRequest,
  InternalPageCheckResponse,
  InternalPageContextRequest,
  InternalPageContextResponse,
  Message,
} from '@/shared/messages'

export function setupWwwRagBridge(): void {
  chrome.runtime.onMessage.addListener(
    (msg: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
      switch (msg?.type) {
        case 'internal:check-page':
          void handlePageCheck(msg as InternalPageCheckRequest)
            .then((resp) => sendResponse(resp))
            .catch((err: unknown) => {
              log.error('[www-rag] page-check error:', err)
              sendResponse(pageError((msg as InternalPageCheckRequest).url, err))
            })
          return true // async sendResponse
        case 'internal:page-context':
          void handlePageContext(msg as InternalPageContextRequest)
            .then((resp) => sendResponse(resp))
            .catch((err: unknown) => {
              log.error('[www-rag] page-context error:', err)
              const r = msg as InternalPageContextRequest
              const resp: InternalPageContextResponse = {
                type: 'internal:page-context-response',
                ok: false,
                url: r.url,
                chunks: [],
                error: err instanceof Error ? err.message : String(err),
              }
              sendResponse(resp)
            })
          return true
        default:
          return undefined
      }
    },
  )
}

/**
 * Read the privacy-relevant user settings from chrome.storage (the SW can;
 * the offscreen can't). Both default to ENABLED — an undefined/never-saved
 * value means the feature is on.
 */
async function readPrivacySettings(): Promise<{
  wwwRagGrounding: boolean
  allowChatDataUse: boolean
}> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
    const s = stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings> | undefined
    return {
      // Default ON: only an explicit `false` disables.
      wwwRagGrounding: s?.wwwRagGrounding !== false,
      allowChatDataUse: s?.allowChatDataUse !== false,
    }
  } catch {
    return { wwwRagGrounding: true, allowChatDataUse: true }
  }
}

function pageError(url: string, err: unknown): InternalPageCheckResponse {
  return {
    type: 'internal:page-status',
    url,
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
  }
}

async function handlePageCheck(req: InternalPageCheckRequest): Promise<InternalPageCheckResponse> {
  // Server-defensive re-sanitize: the content script already gated via
  // urlIndexDecision, but never trust the message — strip query/fragment again.
  const sanitized = sanitizeUrlForIndex(req.url)
  if (!sanitized) {
    return { type: 'internal:page-status', url: req.url, status: 'blacklisted', reason: 'invalid-url' }
  }

  if (!(await isSignedIn())) {
    return { type: 'internal:page-status', url: sanitized, status: 'signed-out' }
  }

  const result = await authedFetch(buildPageStatusUrl(sanitized, req.hash))
  if (!result.ok) {
    if (result.signedOut) {
      return { type: 'internal:page-status', url: sanitized, status: 'signed-out' }
    }
    return { type: 'internal:page-status', url: sanitized, status: 'error', error: result.error }
  }

  // 503 → WWW RAG not provisioned server-side yet.
  if (result.status === 503) {
    return { type: 'internal:page-status', url: sanitized, status: 'not-configured' }
  }
  // 429 (rate-limited) and other non-2xx → soft error; pill shows "Error".
  if (result.status < 200 || result.status >= 300) {
    return {
      type: 'internal:page-status',
      url: sanitized,
      status: 'error',
      error: `server ${result.status}: ${result.text.substring(0, 160)}`,
    }
  }

  const parsed = parsePageStatusResponse(result.text)
  if (!parsed) {
    return {
      type: 'internal:page-status',
      url: sanitized,
      status: 'error',
      error: `unparseable page-status response (${result.status})`,
    }
  }

  return {
    type: 'internal:page-status',
    url: sanitized,
    status: pageStatusToPill(parsed),
    fresh: parsed.fresh,
    version: parsed.version,
  }
}

async function handlePageContext(
  req: InternalPageContextRequest,
): Promise<InternalPageContextResponse> {
  const empty = (error?: string): InternalPageContextResponse => ({
    type: 'internal:page-context-response',
    ok: false,
    url: req.url,
    chunks: [],
    error,
  })

  const sanitized = sanitizeUrlForIndex(req.url)
  if (!sanitized) return empty('invalid-url')

  const { wwwRagGrounding, allowChatDataUse } = await readPrivacySettings()
  // Grounding is client-enforced and authoritative here: when the user has
  // turned WWW RAG grounding off, the page-context query NEVER leaves the
  // device — return ok with no chunks so the chat proceeds ungrounded.
  if (!wwwRagGrounding) {
    return { type: 'internal:page-context-response', ok: true, url: sanitized, chunks: [] }
  }

  if (!(await isSignedIn())) return empty('not signed in')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Data-use signal only: when the user opts out, tell the server not to use
  // this request's content to improve services. SERVER-SIDE ENFORCEMENT IS A
  // SEPARATE TODO — the extension only carries the preference, it does not (and
  // cannot) enforce server behaviour.
  if (!allowChatDataUse) headers['X-Divinci-Data-Use'] = 'none'

  const result = await authedFetch(buildPageContextUrl(), {
    method: 'POST',
    headers,
    body: buildPageContextBody({ url: sanitized, query: req.query, topK: req.topK }),
  })
  if (!result.ok) return empty(result.signedOut ? 'not signed in' : result.error)
  if (result.status < 200 || result.status >= 300) {
    return empty(`server ${result.status}: ${result.text.substring(0, 160)}`)
  }

  const parsed = parsePageContextResponse(result.text)
  if (!parsed) return empty('unparseable page-context response')

  return {
    type: 'internal:page-context-response',
    ok: true,
    url: sanitized,
    chunks: parsed.chunks,
  }
}
