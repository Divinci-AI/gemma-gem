/**
 * Background service-worker entrypoint.
 *
 * Three responsibilities:
 *   1. Spin up the offscreen document on startup so the model is ready
 *      before the first web-app connection arrives.
 *   2. Bridge external port messages to/from the offscreen doc.
 *   3. If the user previously opted into a model via the popup, auto-warm
 *      it on SW startup so subsequent extension wake-ups (browser restart,
 *      extension reload, ~30s SW eviction cycle) put the model back in
 *      VRAM without the user having to re-click "Load".
 *
 * Auto-warm only fires when STORAGE_KEY_MODEL is set — i.e. the user has
 * previously consented to a download via the popup. We never silently
 * download 3 GB on install.
 */

import { ensureOffscreenDocument } from '@/background/offscreen-manager'
import { setupExternalBridge } from '@/background/external-bridge'
import { log } from '@/shared/logger'
import { STORAGE_KEY_MODEL, type ModelId } from '@/shared/models'
import type { InternalLoadRequest, Message } from '@/shared/messages'

async function autoWarmIfRemembered(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_MODEL)
    const modelId = stored[STORAGE_KEY_MODEL] as ModelId | undefined
    if (!modelId) {
      log.info('No remembered model — skipping auto-warm')
      return
    }
    log.info(`Auto-warming remembered model: ${modelId}`)
    const req: InternalLoadRequest = {
      type: 'internal:load',
      requestId: `autowarm-${Date.now()}`,
      modelId,
      caller: 'autowarm',
    }
    chrome.runtime.sendMessage(req as Message).catch((e) => {
      log.warn('Auto-warm sendMessage failed (cache hit will make it fast on next manual load):', e)
    })
  } catch (e) {
    log.warn('Auto-warm read from chrome.storage failed:', e)
  }
}

export default defineBackground(() => {
  log.info('Divinci local-inference SW started')
  setupExternalBridge()

  ensureOffscreenDocument()
    .then(() => log.info('Offscreen document ready'))
    .then(() => autoWarmIfRemembered())
    .catch((e) => log.error('Failed to create offscreen document:', e))
})
