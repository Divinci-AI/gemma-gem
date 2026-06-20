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
import { setupInternalBridge } from '@/background/internal-bridge'
import { setupWwwRagBridge } from '@/background/www-rag-bridge'
import { setupDivinciAuthBridge } from '@/background/divinci-auth'
import { log } from '@/shared/logger'
import {
  STORAGE_KEY_MODEL,
  STORAGE_KEY_SETTINGS,
  DEFAULT_SETTINGS,
  type ModelId,
  type UserSettings,
} from '@/shared/models'
import type {
  InternalLoadRequest,
  InternalSetSettingsRequest,
  Message,
} from '@/shared/messages'

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

/**
 * Persist inference-default changes on the offscreen's behalf. Offscreen
 * documents only get chrome.runtime — not chrome.storage — so the popup's
 * internal:set-settings broadcast (which the offscreen applies in-memory)
 * is also caught here and written to chrome.storage. Partial updates merge
 * onto the stored value so one field doesn't clobber the other.
 */
function setupSettingsPersistence(): void {
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if ((msg as InternalSetSettingsRequest)?.type !== 'internal:set-settings') return
    const m = msg as InternalSetSettingsRequest
    void chrome.storage.local.get(STORAGE_KEY_SETTINGS).then((stored) => {
      const prev = (stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings>) ?? {}
      const next: UserSettings = {
        temperature: m.temperature ?? prev.temperature ?? DEFAULT_SETTINGS.temperature,
        maxNewTokens: m.maxNewTokens ?? prev.maxNewTokens ?? DEFAULT_SETTINGS.maxNewTokens,
        cfAccountId: m.cfAccountId ?? prev.cfAccountId,
        cfApiToken: m.cfApiToken ?? prev.cfApiToken,
        braveApiKey: m.braveApiKey ?? prev.braveApiKey,
        serperApiKey: m.serperApiKey ?? prev.serperApiKey,
        // ?? keeps a false from overwriting nothing; the popup always sends an
        // explicit boolean for the toggle, so a real `false` still persists.
        useDivinciAccount: m.useDivinciAccount ?? prev.useDivinciAccount,
        divinciWorkspaceId: m.divinciWorkspaceId ?? prev.divinciWorkspaceId,
        divinciReleaseId: m.divinciReleaseId ?? prev.divinciReleaseId,
        theme: m.theme ?? prev.theme,
      }
      void chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: next })
    })
  })
}

/**
 * Push saved inference defaults into the freshly-created offscreen doc.
 * The offscreen starts from DEFAULT_SETTINGS (it can't read chrome.storage
 * itself); this hydrates it to the user's last-saved values.
 */
async function hydrateOffscreenSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
    const saved = stored[STORAGE_KEY_SETTINGS] as Partial<UserSettings> | undefined
    if (!saved) return
    const req: InternalSetSettingsRequest = {
      type: 'internal:set-settings',
      temperature: saved.temperature,
      maxNewTokens: saved.maxNewTokens,
      cfAccountId: saved.cfAccountId,
      cfApiToken: saved.cfApiToken,
      braveApiKey: saved.braveApiKey,
      serperApiKey: saved.serperApiKey,
      useDivinciAccount: saved.useDivinciAccount,
      divinciWorkspaceId: saved.divinciWorkspaceId,
      divinciReleaseId: saved.divinciReleaseId,
      theme: saved.theme,
    }
    chrome.runtime.sendMessage(req as Message).catch((e) => {
      log.warn('Settings hydrate sendMessage failed:', e)
    })
  } catch (e) {
    log.warn('Settings hydrate read failed:', e)
  }
}

export default defineBackground(() => {
  log.info('Divinci local-inference SW started')
  setupExternalBridge()
  setupInternalBridge()
  setupWwwRagBridge()
  setupDivinciAuthBridge()
  setupSettingsPersistence()

  // Sidebar → "open the popup" (clicking the in-page model chip / avatar).
  // chrome.action.openPopup is Chrome 127+ and may reject when not tied to an
  // extension-context user gesture — best-effort, swallow failures.
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if ((msg as { type?: string })?.type !== 'internal:open-popup') return
    try {
      chrome.action.openPopup?.().catch((e) => log.debug('openPopup rejected:', e))
    } catch (e) {
      log.debug('openPopup threw:', e)
    }
  })

  ensureOffscreenDocument()
    .then(() => log.info('Offscreen document ready'))
    .then(() => hydrateOffscreenSettings())
    .then(() => autoWarmIfRemembered())
    .catch((e) => log.error('Failed to create offscreen document:', e))
})
