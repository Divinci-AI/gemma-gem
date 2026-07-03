const OFFSCREEN_URL = 'offscreen.html'

let creating: Promise<void> | null = null

/**
 * True only when a runtime message came from THIS extension's offscreen
 * document. `internal:event` routing (offscreen → SW → caller port) must gate
 * on this: without it, any same-extension context that can call
 * chrome.runtime.sendMessage — including the content script injected on every
 * page — could forge an `internal:event` and push arbitrary tokens/events into
 * a connected web app, sidebar, or open-page consumer.
 */
export function isFromOffscreen(sender: chrome.runtime.MessageSender | undefined): boolean {
  return sender?.url === chrome.runtime.getURL(OFFSCREEN_URL)
}

/**
 * True when a runtime message came from one of THIS extension's own pages
 * (popup / panel / offscreen) — i.e. a chrome-extension:// context under our
 * own id — and NOT from a content script. Content scripts share our extension
 * id but report the host page's http(s) URL, so the URL-prefix check excludes
 * them. Gates settings persistence so a compromised content script can't
 * overwrite stored API keys.
 */
export function isFromExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  return (
    sender?.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''))
  )
}

async function offscreenExists(): Promise<boolean> {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })
  return ctx.length > 0
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await offscreenExists()) return

  if (creating) {
    await creating
    return
  }

  // Robust create: chrome.offscreen.createDocument transiently fails during MV3
  // service-worker lifecycle races (e.g. "No SW" when the SW is torn down
  // mid-create, or "Only a single offscreen document may be created" if an
  // orphaned one lingers after an extension reload). Without retry, ONE such
  // failure wedges the extension — Load does nothing because there's no
  // offscreen to run the model. Retry a few times, re-checking existence
  // (another context may have created it) and closing an orphan before retry.
  creating = (async () => {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await offscreenExists()) return
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          // WORKERS = WebGPU inference; USER_MEDIA = mic for wake-word (Phase B0).
          reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.USER_MEDIA],
          justification: 'Run on-device model inference (WebGPU) and wake-word detection (mic)',
        })
        return
      } catch (e) {
        lastErr = e
        const msg = String((e as Error)?.message ?? e)
        // If one already exists (race / orphan), we're done.
        if (await offscreenExists()) return
        if (/single offscreen document/i.test(msg)) {
          try { await chrome.offscreen.closeDocument() } catch { /* ignore */ }
        }
        // Back off briefly so a mid-teardown SW can settle before the next try.
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
      }
    }
    if (await offscreenExists()) return
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })()

  try {
    await creating
  } finally {
    creating = null
  }
}
