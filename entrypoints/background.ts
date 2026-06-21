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
import { setupTabSessionBridge } from '@/background/tab-session-bridge'
import { setupDivinciApiProxy } from '@/background/divinci-api-proxy'
import { log } from '@/shared/logger'
import {
  STORAGE_KEY_MODEL,
  STORAGE_KEY_SETTINGS,
  STORAGE_KEY_WARM_STATE,
  STORAGE_KEY_WARM_PENDING_AT,
  DEFAULT_SETTINGS,
  type ModelId,
  type UserSettings,
  type WarmState,
} from '@/shared/models'
import { decideAutoWarm } from '@/background/auto-warm-decision'
import type {
  InternalLoadRequest,
  InternalSetSettingsRequest,
  Message,
} from '@/shared/messages'

async function autoWarmIfRemembered(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_MODEL,
      STORAGE_KEY_WARM_STATE,
      STORAGE_KEY_WARM_PENDING_AT,
    ])
    const modelId = stored[STORAGE_KEY_MODEL] as ModelId | undefined

    // Crash-loop guard (see STORAGE_KEY_WARM_STATE / decideAutoWarm). The SW
    // re-runs this on every startup, including the ~30s eviction cycle — so a
    // WebGPU/ONNX load that hard-crashes the renderer/SW would otherwise loop
    // forever, surfacing the browser's "extension has crashed" balloon over and
    // over. The timestamp lets us tell a real crash (stale 'pending') from a
    // load still in flight after a normal eviction (recent 'pending').
    const decision = decideAutoWarm({
      modelId,
      warmState: stored[STORAGE_KEY_WARM_STATE] as WarmState | undefined,
      pendingAt: stored[STORAGE_KEY_WARM_PENDING_AT] as number | undefined,
      now: Date.now(),
    })

    if (decision.action === 'skip') {
      log.info(`Auto-warm skipped: ${decision.reason}`)
      return
    }
    if (decision.action === 'disable') {
      log.warn(`Auto-warm disabled: ${decision.reason}. Open the popup and click Load to retry.`)
      await chrome.storage.local.set({ [STORAGE_KEY_WARM_STATE]: 'disabled' satisfies WarmState })
      return
    }

    // decision.action === 'warm'
    log.info(`Auto-warming remembered model: ${modelId}`)
    // Mark 'pending' + stamp the time BEFORE dispatching, so a crash mid-load is
    // visible to the next startup as a stale incomplete attempt.
    await chrome.storage.local.set({
      [STORAGE_KEY_WARM_STATE]: 'pending' satisfies WarmState,
      [STORAGE_KEY_WARM_PENDING_AT]: Date.now(),
    })
    const req: InternalLoadRequest = {
      type: 'internal:load',
      requestId: `autowarm-${Date.now()}`,
      modelId: modelId!,
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
 * Track the outcome of model loads so the auto-warm crash-loop guard can tell a
 * clean load from a crash. Any successful load (auto-warm OR a manual Load from
 * the web app / popup) records 'ok' and re-enables auto-warm; a graceful
 * auto-warm load error records 'failed' so we don't auto-retry a known-broken
 * load every eviction cycle (manual Load re-enables). A hard crash records
 * neither — it leaves the 'pending' set by autoWarmIfRemembered, which the next
 * startup treats as the crash signal.
 */
function setupWarmStateTracking(): void {
  chrome.runtime.onMessage.addListener((msg: Message) => {
    const m = msg as { type?: string; caller?: string; event?: { type?: string } }
    if (m?.type !== 'internal:event') return
    const evType = m.event?.type
    if (evType === 'divinci:load-done') {
      void chrome.storage.local.set({ [STORAGE_KEY_WARM_STATE]: 'ok' satisfies WarmState })
    } else if (evType === 'divinci:error' && m.caller === 'autowarm') {
      void chrome.storage.local.set({ [STORAGE_KEY_WARM_STATE]: 'failed' satisfies WarmState })
    }
  })
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
        // ?? keeps a real `false` from being lost; the popup always sends an
        // explicit boolean for these toggles, so an off-state still persists.
        wwwRagGrounding: m.wwwRagGrounding ?? prev.wwwRagGrounding,
        allowChatDataUse: m.allowChatDataUse ?? prev.allowChatDataUse,
        readPageContent: m.readPageContent ?? prev.readPageContent,
        divinciApiKey: m.divinciApiKey ?? prev.divinciApiKey,
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
      wwwRagGrounding: saved.wwwRagGrounding,
      allowChatDataUse: saved.allowChatDataUse,
      readPageContent: saved.readPageContent,
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

  // Global safety nets. Without these, a stray unhandled rejection or error in
  // ANY async SW handler escalates to a worker-fatal crash — the browser's
  // "extension has crashed. Click this balloon to reload" balloon. Log and
  // swallow so the worker stays alive and re-handles the next message. (A GPU-
  // process crash in the offscreen renderer is a separate context and can't be
  // caught here; the auto-warm guard below addresses that crash loop instead.)
  self.addEventListener('unhandledrejection', (event) => {
    log.error('SW unhandledrejection:', (event as PromiseRejectionEvent).reason)
    event.preventDefault()
  })
  self.addEventListener('error', (event) => {
    log.error('SW error:', (event as ErrorEvent).message || event)
  })

  setupExternalBridge()
  setupInternalBridge()
  setupWwwRagBridge()
  setupDivinciAuthBridge()
  setupTabSessionBridge()
  setupDivinciApiProxy()
  setupSettingsPersistence()
  setupWarmStateTracking()

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
