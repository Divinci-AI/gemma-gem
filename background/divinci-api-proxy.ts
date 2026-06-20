/**
 * SW proxy for the Divinci /api/v1 surface using the workspace API key.
 *
 * The Tools panel (Skills + MCP servers) lives on the API-key surface, which the
 * OAuth account token can't reach. The user pastes a workspace API key
 * (release:read/write) in the popup; this proxy attaches it as X-API-Key. The
 * key is SW-side only (never handed to the content script).
 */
import { DIVINCI_API_BASE } from '@/shared/divinci-account'
import { STORAGE_KEY_SETTINGS, type UserSettings } from '@/shared/models'
import type {
  Message,
  InternalDivinciApiRequest,
  InternalDivinciApiResponse,
} from '@/shared/messages'

async function getApiKey(): Promise<string | undefined> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
    const s = stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings> | undefined
    return s?.divinciApiKey || undefined
  } catch {
    return undefined
  }
}

async function proxy(req: InternalDivinciApiRequest): Promise<InternalDivinciApiResponse> {
  const RESP = 'internal:divinci-api-response' as const
  const key = await getApiKey()
  if (!key) return { type: RESP, ok: false, noKey: true }
  try {
    const hasBody = req.body !== undefined
    const res = await fetch(`${DIVINCI_API_BASE}${req.path}`, {
      method: req.method,
      headers: {
        'X-API-Key': key,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    })
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { type: RESP, ok: res.ok, status: res.status, data }
  } catch (err) {
    return { type: RESP, ok: false, error: (err as Error).message ?? String(err) }
  }
}

export function setupDivinciApiProxy(): void {
  chrome.runtime.onMessage.addListener(
    (msg: Message, _sender, sendResponse: (r?: unknown) => void) => {
      if ((msg as InternalDivinciApiRequest)?.type !== 'internal:divinci-api') return undefined
      void proxy(msg as InternalDivinciApiRequest).then((r) => sendResponse(r))
      return true
    },
  )
}
