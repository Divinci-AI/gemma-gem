/**
 * Background service-worker entrypoint.
 *
 * Two responsibilities:
 *   1. Spin up the offscreen document on startup so the model is ready
 *      before the first web-app connection arrives.
 *   2. Bridge external port messages to/from the offscreen doc.
 */

import { ensureOffscreenDocument } from '@/background/offscreen-manager'
import { setupExternalBridge } from '@/background/external-bridge'
import { log } from '@/shared/logger'

export default defineBackground(() => {
  log.info('Divinci local-inference SW started')
  setupExternalBridge()

  ensureOffscreenDocument()
    .then(() => log.info('Offscreen document ready'))
    .catch((e) => log.error('Failed to create offscreen document:', e))
})
