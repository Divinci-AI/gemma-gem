/**
 * Popup UI logic.
 *
 * The popup is same-origin with the rest of the extension, so it talks
 * directly to the offscreen via chrome.runtime.sendMessage rather than
 * going through the externally_connectable port. We poll status every
 * second while open (cheap; offscreen is local) and dispatch
 * load/unload requests on button click.
 */

import type {
  InternalRequest,
  InternalStatusResponse,
} from '@/shared/messages'
import { MODELS, type ModelId } from '@/shared/models'

const POLL_INTERVAL_MS = 1000

const els = {
  statusModel: document.getElementById('status-model')!,
  statusQueue: document.getElementById('status-queue')!,
  statusProgress: document.getElementById('status-progress')!,
  progressFile: document.getElementById('progress-file')!,
  progressPct: document.getElementById('progress-pct')!,
  progressFill: document.getElementById('progress-fill') as HTMLElement,
  unloadBtn: document.getElementById('unload-btn') as HTMLButtonElement,
  version: document.getElementById('version')!,
  cards: document.querySelectorAll<HTMLElement>('.model-card'),
  loadButtons: document.querySelectorAll<HTMLButtonElement>('button[data-action="load"]'),
}

// One-shot send to the offscreen. The background service worker isn't
// involved — the offscreen registers a chrome.runtime.onMessage listener
// at the runtime level, so direct sendMessage finds it.
function sendInternal<T = unknown>(msg: InternalRequest): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: T | undefined) => {
        // Touch lastError to suppress the "unchecked runtime.lastError" warning.
        const _err = chrome.runtime.lastError
        void _err
        resolve(resp ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function render(status: InternalStatusResponse | null): void {
  if (!status) {
    els.statusModel.textContent = 'extension idle'
    els.statusQueue.textContent = '0'
    els.statusProgress.hidden = true
    els.unloadBtn.hidden = true
    setActiveCard(null)
    return
  }

  // Loaded model name (from the MODELS registry)
  if (status.currentModelId) {
    const config = MODELS[status.currentModelId]
    els.statusModel.textContent = config?.label ?? status.currentModelId
  } else {
    els.statusModel.textContent = status.isLoaded ? 'loaded' : 'not loaded'
  }
  els.statusQueue.textContent = String(status.queueDepth)

  // Progress bar (visible only while a load is in flight)
  if (status.loadProgress) {
    els.statusProgress.hidden = false
    const file = status.loadProgress.currentFile
      ? status.loadProgress.currentFile.split('/').pop()
      : 'downloading'
    els.progressFile.textContent = file ?? 'downloading'
    const loaded = status.loadProgress.bytesLoaded
    const total = status.loadProgress.bytesTotal
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null
    els.progressPct.textContent =
      pct != null ? `${pct}%  (${formatBytes(loaded)} / ${formatBytes(total)})` : formatBytes(loaded)
    els.progressFill.style.width = pct != null ? `${pct}%` : '0%'
  } else {
    els.statusProgress.hidden = true
  }

  // Unload button only shows when something is actually loaded
  els.unloadBtn.hidden = !status.isLoaded
  setActiveCard(status.currentModelId)
}

function setActiveCard(modelId: ModelId | null): void {
  els.cards.forEach((card) => {
    const id = card.dataset.modelId as ModelId | undefined
    card.classList.toggle('is-active', id != null && id === modelId)
    const btn = card.querySelector<HTMLButtonElement>('button[data-action="load"]')
    if (!btn) return
    if (id === modelId) {
      btn.textContent = 'Loaded'
      btn.disabled = true
    } else {
      btn.textContent = 'Load'
      btn.disabled = false
    }
  })
}

async function poll(): Promise<void> {
  const status = await sendInternal<InternalStatusResponse>({ type: 'internal:status' })
  render(status)
}

els.loadButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modelId as ModelId | undefined
    if (!id) return
    btn.disabled = true
    btn.textContent = 'Loading…'
    void sendInternal({
      type: 'internal:load',
      requestId: `popup-load-${Date.now()}`,
      modelId: id,
      caller: 'popup',
    }).then(() => {
      // Status poll will re-render correctly within the next second.
      void poll()
    })
  })
})

els.unloadBtn.addEventListener('click', () => {
  els.unloadBtn.disabled = true
  void sendInternal({ type: 'internal:unload' }).then(() => {
    setTimeout(() => {
      els.unloadBtn.disabled = false
      void poll()
    }, 200)
  })
})

// Render version from manifest
const manifest = chrome.runtime.getManifest()
els.version.textContent = `v${manifest.version}`

// Initial paint + steady poll while popup is open
void poll()
setInterval(poll, POLL_INTERVAL_MS)
