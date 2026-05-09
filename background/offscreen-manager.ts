const OFFSCREEN_URL = 'offscreen.html'

let creating: Promise<void> | null = null

export async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })

  if (existingContexts.length > 0) return

  if (creating) {
    await creating
    return
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run Gemma 4 model inference via WebGPU',
  })

  try {
    await creating
  } catch (e) {
    // If creation fails, make sure we reset the creating flag
    // so subsequent calls can retry
    throw e
  } finally {
    creating = null
  }
}
