/**
 * Divinci API bridge — routes page-check requests from the sidebar content
 * script to the Divinci RAG/vector backend.
 *
 * The content script sends internal:check-page via chrome.runtime.sendMessage.
 * This handler reads the stored API key + whitelabel ID, calls checkPage then
 * optionally scrapePage, and responds with internal:page-status.
 *
 * Storage keys the popup UI writes:
 *   - divinci_api_key       → chrome.storage.local
 *   - divinci_whitelabel_id → chrome.storage.local
 */

import { log } from '@/shared/logger'
import { DivinciAPI } from '@/shared/divinci-api'
import { STORAGE_KEY_API_KEY, STORAGE_KEY_WHITELABEL_ID } from '@/shared/models'
import type { InternalPageCheckRequest, InternalPageCheckResponse, Message } from '@/shared/messages'

interface StoredConfig {
  apiKey?: string
  whitelabelId?: string
}

async function readConfig(): Promise<StoredConfig> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_API_KEY, STORAGE_KEY_WHITELABEL_ID])
  return {
    apiKey: (stored[STORAGE_KEY_API_KEY] as string | undefined) || undefined,
    whitelabelId: (stored[STORAGE_KEY_WHITELABEL_ID] as string | undefined) || undefined,
  }
}

export function setupDivinciAPIBridge(): void {
  chrome.runtime.onMessage.addListener(
    (msg: Message, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      // Only handle page-check requests
      if ((msg as InternalPageCheckRequest)?.type !== 'internal:check-page') return

      const req = msg as InternalPageCheckRequest
      log.info('Page-check request for:', req.url)

      // Signal that we'll respond asynchronously
      void handlePageCheck(req)
        .then((resp) => sendResponse(resp))
        .catch((err: unknown) => {
          log.error('Page-check error:', err)
          const errorResp: InternalPageCheckResponse = {
            type: 'internal:page-status',
            url: req.url,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          }
          sendResponse(errorResp)
        })

      return true // keepalive — we'll call sendResponse asynchronously
    },
  )
}

async function handlePageCheck(req: InternalPageCheckRequest): Promise<InternalPageCheckResponse> {
  const config = await readConfig()

  if (!config.apiKey || !config.whitelabelId) {
    log.info('Divinci API not configured — returning not-configured')
    return {
      type: 'internal:page-status',
      url: req.url,
      status: 'not-configured',
    }
  }

  const api = new DivinciAPI({
    apiKey: config.apiKey,
    whitelabelId: config.whitelabelId,
  })

  // Check if page is already indexed
  const check = await api.checkPage(req.url)
  if (check.exists) {
    log.info('Page already indexed:', req.url)
    return {
      type: 'internal:page-status',
      url: req.url,
      status: 'indexed',
    }
  }

  // Not indexed — trigger scrape
  log.info('Page not indexed, triggering scrape:', req.url)
  const scrape = await api.scrapePage(req.url)

  return {
    type: 'internal:page-status',
    url: req.url,
    status: 'triggered',
    crawlId: scrape.crawlId,
  }
}
