/**
 * Account-mode chat executor.
 *
 * Shaped exactly like runKimiLoop so it drops into finalizeChatResult's
 * `runKimi` slot. In account mode the SERVER (stage.divinci.app) decides and
 * executes tools with its own keys, so the local tool/credential args are
 * ignored — we just forward the conversation to the background SW (which owns
 * the OAuth token and does the authenticated fetch) and return its answer.
 */

import { log } from '@/shared/logger'
import type { ChatTool } from '@/shared/messages'
import type { KimiCredentials } from '@/offscreen/kimi-caller'
import type { WebSearchProvider } from '@/offscreen/web-search'
import type {
  Message,
  InternalAccountChatRequest,
  InternalAccountChatResponse,
} from '@/shared/messages'

export function makeAccountChatRunner(opts: { workspaceId: string; releaseId?: string }) {
  return async function runAccountChat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    _tools: ChatTool[],
    _credentials: KimiCredentials,
    _webSearchProvider: WebSearchProvider,
    _maxIterations?: number,
    _signal?: AbortSignal,
  ): Promise<{ response: string; iterations: number; durationMs: number }> {
    const start = Date.now()
    const req: InternalAccountChatRequest = {
      type: 'internal:account-chat',
      messages,
      workspaceId: opts.workspaceId,
      releaseId: opts.releaseId,
    }
    const resp = (await chrome.runtime.sendMessage(req as Message)) as
      | InternalAccountChatResponse
      | undefined
    if (!resp || !resp.ok || typeof resp.text !== 'string') {
      throw new Error(resp?.error ?? 'account-mode chat failed')
    }
    log.info('[account-chat] server proxy returned an answer')
    // iterations is server-side and opaque here; report 1 (one proxied turn).
    return { response: resp.text, iterations: 1, durationMs: Date.now() - start }
  }
}
