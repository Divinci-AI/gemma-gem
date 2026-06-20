/**
 * Popup UI logic.
 *
 * The popup is same-origin with the rest of the extension, so it talks
 * directly to the offscreen via chrome.runtime.sendMessage rather than
 * going through the externally_connectable port. We poll status every
 * second while open (cheap; offscreen is local) and dispatch
 * load/unload requests on button click. Button state is rendered
 * deterministically from the status response on each poll — never
 * mutated optimistically — which avoids the "Loading… → Load →
 * Loading…" snap-back flicker.
 */

import type {
  InternalRequest,
  InternalStatusResponse,
  InternalDivinciAuthStatusResponse,
} from '@/shared/messages'
import { MODELS, STORAGE_KEY_MODEL, STORAGE_KEY_SETTINGS, STORAGE_KEY_API_KEY, STORAGE_KEY_WHITELABEL_ID, type ModelId } from '@/shared/models'

const POLL_INTERVAL_MS = 1000

const els = {
  statusModel: document.getElementById('status-model')!,
  statusQueue: document.getElementById('status-queue')!,
  statusDisk: document.getElementById('status-disk')!,
  clearCacheBtn: document.getElementById('clear-cache-btn') as HTMLButtonElement,
  statusProgress: document.getElementById('status-progress')!,
  progressFile: document.getElementById('progress-file')!,
  progressPct: document.getElementById('progress-pct')!,
  progressFill: document.getElementById('progress-fill') as HTMLElement,
  unloadBtn: document.getElementById('unload-btn') as HTMLButtonElement,
  errorToast: document.getElementById('error-toast') as HTMLElement,
  errorText: document.getElementById('error-text')!,
  errorDismiss: document.getElementById('error-dismiss') as HTMLButtonElement,
  version: document.getElementById('version')!,
  cards: document.querySelectorAll<HTMLElement>('.model-card'),
  loadButtons: document.querySelectorAll<HTMLButtonElement>('button[data-action="load"]'),
  cacheBadges: document.querySelectorAll<HTMLElement>('[data-cache-badge]'),
  cacheDetails: document.querySelectorAll<HTMLElement>('[data-cache-detail]'),
  tempInput: document.getElementById('setting-temperature') as HTMLInputElement,
  maxTokensInput: document.getElementById('setting-max-tokens') as HTMLInputElement,
  apiKeyInput: document.getElementById('setting-api-key') as HTMLInputElement,
  wlIdInput: document.getElementById('setting-wl-id') as HTMLInputElement,
  cfAccountIdInput: document.getElementById('setting-cf-account-id') as HTMLInputElement,
  cfApiTokenInput: document.getElementById('setting-cf-api-token') as HTMLInputElement,
  braveApiKeyInput: document.getElementById('setting-brave-api-key') as HTMLInputElement,
  serperApiKeyInput: document.getElementById('setting-serper-api-key') as HTMLInputElement,
  useAccountToggle: document.getElementById('setting-use-divinci-account') as HTMLInputElement,
  signinBtn: document.getElementById('divinci-signin-btn') as HTMLButtonElement,
  authStatus: document.getElementById('divinci-auth-status')!,
  workspaceIdInput: document.getElementById('setting-divinci-workspace-id') as HTMLInputElement,
  releaseIdInput: document.getElementById('setting-divinci-release-id') as HTMLInputElement,
}

// Track which inputs the user has touched so we don't fight their typing
// when the next status poll comes in. Cleared on commit (blur).
const dirtyInputs = new Set<HTMLInputElement>()

/** Local override that hides the toast for an error the user dismissed. */
let dismissedError: string | null = null

// One-shot send to the offscreen. The background service worker isn't
// involved — the offscreen registers a chrome.runtime.onMessage listener
// at the runtime level, so direct sendMessage finds it.
function sendInternal<T = unknown>(msg: InternalRequest): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: T | undefined) => {
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
    renderCards(null, null)
    renderError(null)
    return
  }

  // "Loaded model" line shows the loaded model OR the loading model OR a
  // not-loaded placeholder, in priority order.
  if (status.loadingModelId) {
    const cfg = MODELS[status.loadingModelId]
    els.statusModel.textContent = `Loading ${cfg?.label ?? status.loadingModelId}…`
  } else if (status.currentModelId) {
    const cfg = MODELS[status.currentModelId]
    els.statusModel.textContent = cfg?.label ?? status.currentModelId
  } else {
    els.statusModel.textContent = 'not loaded'
  }
  els.statusQueue.textContent = String(status.queueDepth)

  // Progress bar mirrors the offscreen's latestProgress snapshot.
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

  els.unloadBtn.hidden = !status.isLoaded
  renderCards(status.currentModelId, status.loadingModelId)
  renderCacheState(status.cacheBreakdown)
  renderError(status.lastError)
  renderSettings(status.settings)
}

function renderCacheState(
  breakdown: Record<ModelId, { isCached: boolean; bytes: number }>
): void {
  els.cacheBadges.forEach((el) => {
    const id = el.dataset.cacheBadge as ModelId | undefined
    if (!id) return
    el.hidden = !breakdown[id]?.isCached
  })
  els.cacheDetails.forEach((el) => {
    const id = el.dataset.cacheDetail as ModelId | undefined
    if (!id) return
    const entry = breakdown[id]
    if (entry?.isCached) {
      el.classList.add('is-cached')
      el.textContent = `cached (${formatBytes(entry.bytes)}, fast load)`
    } else {
      el.classList.remove('is-cached')
      el.textContent = 'not cached — first load downloads'
    }
  })
}

function renderSettings(settings: { temperature: number; maxNewTokens: number }): void {
  // Don't overwrite an input the user is currently editing.
  if (!dirtyInputs.has(els.tempInput)) {
    els.tempInput.value = String(settings.temperature)
  }
  if (!dirtyInputs.has(els.maxTokensInput)) {
    els.maxTokensInput.value = String(settings.maxNewTokens)
  }
}

function renderCards(loadedId: ModelId | null, loadingId: ModelId | null): void {
  els.cards.forEach((card) => {
    const id = card.dataset.modelId as ModelId | undefined
    if (!id) return
    const isLoaded = id === loadedId
    const isLoading = id === loadingId
    card.classList.toggle('is-active', isLoaded)
    card.classList.toggle('is-loading', isLoading)
    const btn = card.querySelector<HTMLButtonElement>('button[data-action="load"]')
    if (!btn) return
    if (isLoading) {
      btn.textContent = 'Loading…'
      btn.disabled = true
    } else if (isLoaded) {
      btn.textContent = 'Loaded'
      btn.disabled = true
    } else {
      btn.textContent = 'Load'
      // Disable while ANY load is in flight — don't let the user trigger
      // a concurrent load that ChatHost will reject.
      btn.disabled = loadingId !== null
    }
  })
}

function renderError(err: string | null): void {
  // Hide if no error or if the user dismissed this exact message.
  if (!err || err === dismissedError) {
    els.errorToast.hidden = true
    return
  }
  els.errorText.textContent = err
  els.errorToast.hidden = false
}

async function poll(): Promise<void> {
  const status = await sendInternal<InternalStatusResponse>({ type: 'internal:status' })
  render(status)
}

els.loadButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modelId as ModelId | undefined
    if (!id) return
    // Clear any prior dismissed-error gate so a new failure on this load
    // gets surfaced. Also wipe the local toast immediately for snappy UX —
    // the next poll will re-render based on actual status.
    dismissedError = null
    // Persist the user's choice so the SW auto-warms on next startup.
    void chrome.storage.local.set({ [STORAGE_KEY_MODEL]: id })
    void sendInternal({
      type: 'internal:load',
      requestId: `popup-load-${Date.now()}`,
      modelId: id,
      caller: 'popup',
    }).then(() => {
      void poll()
    })
    // Also poll immediately so the loadingModelId from the status response
    // updates the card state without waiting a full second.
    setTimeout(() => void poll(), 50)
  })
})

els.unloadBtn.addEventListener('click', () => {
  els.unloadBtn.disabled = true
  // Drop the remembered model so the SW doesn't auto-warm it back on its
  // next wake-up (which would silently undo the unload from the user's POV).
  void chrome.storage.local.remove(STORAGE_KEY_MODEL)
  void sendInternal({ type: 'internal:unload' }).then(() => {
    setTimeout(() => {
      els.unloadBtn.disabled = false
      void poll()
    }, 200)
  })
})

els.errorDismiss.addEventListener('click', () => {
  dismissedError = els.errorText.textContent
  els.errorToast.hidden = true
})

// Settings: mark an input dirty while typing, commit on blur, Enter, OR
// after a 500ms typing pause. The pause-commit catches the case where
// the user types a value and closes the popup without ever blurring —
// without it, the change was silently lost. The dirty flag still stops
// the next poll from yanking the value mid-type.
const debounceTimers = new WeakMap<HTMLInputElement, number>()
function commitSettings(input: HTMLInputElement): void {
  dirtyInputs.delete(input)
  const existing = debounceTimers.get(input)
  if (existing != null) {
    window.clearTimeout(existing)
    debounceTimers.delete(input)
  }
  const temperature = Number.parseFloat(els.tempInput.value)
  const maxNewTokens = Number.parseInt(els.maxTokensInput.value, 10)
  void sendInternal({
    type: 'internal:set-settings',
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxNewTokens: Number.isFinite(maxNewTokens) ? maxNewTokens : undefined,
  })
}

function scheduleDebouncedCommit(input: HTMLInputElement): void {
  const existing = debounceTimers.get(input)
  if (existing != null) window.clearTimeout(existing)
  const id = window.setTimeout(() => {
    debounceTimers.delete(input)
    commitSettings(input)
  }, 500)
  debounceTimers.set(input, id)
}

for (const input of [els.tempInput, els.maxTokensInput]) {
  input.addEventListener('input', () => {
    dirtyInputs.add(input)
    scheduleDebouncedCommit(input)
  })
  input.addEventListener('blur', () => commitSettings(input))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      input.blur() // triggers blur → commit
    }
  })
}

// ---- RAG config (no debounce — commit on each change) --------------------
async function saveRagConfig(): Promise<void> {
  void chrome.storage.local.set({
    [STORAGE_KEY_API_KEY]: els.apiKeyInput.value,
    [STORAGE_KEY_WHITELABEL_ID]: els.wlIdInput.value,
  })
}

// Load stored RAG config and populate inputs. Commit changes immediately on
// input (no debounce — typing a key is fast enough for storage I/O).
async function loadRagConfig(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_API_KEY, STORAGE_KEY_WHITELABEL_ID]) as Record<string, string | undefined>
  els.apiKeyInput.value = stored[STORAGE_KEY_API_KEY] ?? ''
  els.wlIdInput.value = stored[STORAGE_KEY_WHITELABEL_ID] ?? ''
}
els.apiKeyInput.addEventListener('input', () => { void saveRagConfig() })
els.wlIdInput.addEventListener('input', () => { void saveRagConfig() })

// ---- Tool API credentials (immediate commit, no debounce) ---------------
function sendToolApiCredentials(): void {
  void sendInternal({
    type: 'internal:set-settings',
    cfAccountId: els.cfAccountIdInput.value || undefined,
    cfApiToken: els.cfApiTokenInput.value || undefined,
    braveApiKey: els.braveApiKeyInput.value || undefined,
    serperApiKey: els.serperApiKeyInput.value || undefined,
  })
}

async function loadToolApiCredentials(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
  const settings = stored[STORAGE_KEY_SETTINGS] as
    | { cfAccountId?: string; cfApiToken?: string; braveApiKey?: string; serperApiKey?: string }
    | undefined
  els.cfAccountIdInput.value = settings?.cfAccountId ?? ''
  els.cfApiTokenInput.value = settings?.cfApiToken ?? ''
  els.braveApiKeyInput.value = settings?.braveApiKey ?? ''
  els.serperApiKeyInput.value = settings?.serperApiKey ?? ''
}

for (const input of [els.cfAccountIdInput, els.cfApiTokenInput, els.braveApiKeyInput, els.serperApiKeyInput]) {
  input.addEventListener('input', () => { void sendToolApiCredentials() })
}

// ---- Divinci account (OAuth) -------------------------------------------
function sendAccountSettings(): void {
  void sendInternal({
    type: 'internal:set-settings',
    useDivinciAccount: els.useAccountToggle.checked,
    divinciWorkspaceId: els.workspaceIdInput.value.trim() || undefined,
    divinciReleaseId: els.releaseIdInput.value.trim() || undefined,
  })
}

async function loadAccountSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
  const s = stored[STORAGE_KEY_SETTINGS] as
    | { useDivinciAccount?: boolean; divinciWorkspaceId?: string; divinciReleaseId?: string }
    | undefined
  els.useAccountToggle.checked = Boolean(s?.useDivinciAccount)
  els.workspaceIdInput.value = s?.divinciWorkspaceId ?? ''
  els.releaseIdInput.value = s?.divinciReleaseId ?? ''
}

function renderAuthStatus(resp: InternalDivinciAuthStatusResponse | null): void {
  const signedIn = Boolean(resp?.signedIn)
  els.signinBtn.textContent = signedIn ? 'Sign out' : 'Sign in with Divinci'
  if (resp?.error) {
    els.authStatus.textContent = `Sign-in failed: ${resp.error}`
  } else if (signedIn) {
    els.authStatus.textContent = resp?.email ? `Signed in as ${resp.email}.` : 'Signed in.'
  } else {
    els.authStatus.textContent = 'Not signed in.'
  }
}

async function refreshAuthStatus(): Promise<void> {
  const resp = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: 'internal:divinci-auth-status',
  })
  renderAuthStatus(resp)
}

els.signinBtn.addEventListener('click', async () => {
  const status = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: 'internal:divinci-auth-status',
  })
  const signedIn = Boolean(status?.signedIn)
  els.signinBtn.disabled = true
  els.authStatus.textContent = signedIn ? 'Signing out…' : 'Opening Divinci sign-in…'
  const resp = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: signedIn ? 'internal:divinci-signout' : 'internal:divinci-signin',
  })
  els.signinBtn.disabled = false
  renderAuthStatus(resp)
})

els.useAccountToggle.addEventListener('change', () => { sendAccountSettings() })
els.workspaceIdInput.addEventListener('input', () => { sendAccountSettings() })
els.releaseIdInput.addEventListener('input', () => { sendAccountSettings() })

// Render version from manifest
const manifest = chrome.runtime.getManifest()
els.version.textContent = `v${manifest.version}`

// Storage estimate. Scoped to the extension origin — counts the model
// files cached by transformers.js plus our few-KB chrome.storage entries.
// navigator.storage.estimate() is broadly supported in Chromium-based
// browsers; fall back gracefully if not.
async function refreshStorageEstimate(): Promise<void> {
  try {
    if (typeof navigator.storage?.estimate !== 'function') {
      els.statusDisk.textContent = 'unavailable'
      els.clearCacheBtn.hidden = true
      return
    }
    const est = await navigator.storage.estimate()
    if (est.usage == null) {
      els.statusDisk.textContent = 'unknown'
      els.clearCacheBtn.hidden = true
      return
    }
    els.statusDisk.textContent = formatBytes(est.usage)
    // Show the Clear button only when there's something appreciable to
    // clear (skip noise from <1 MB of chrome.storage entries).
    els.clearCacheBtn.hidden = est.usage < 1024 * 1024
  } catch {
    els.statusDisk.textContent = 'unknown'
    els.clearCacheBtn.hidden = true
  }
}

els.clearCacheBtn.addEventListener('click', async () => {
  // Confirm — this is destructive (forces a re-download).
  const ok = window.confirm(
    'Clear the cached model files?\n\nFuture loads will re-download them from Hugging Face.'
  )
  if (!ok) return
  els.clearCacheBtn.disabled = true
  els.clearCacheBtn.textContent = 'Clearing…'
  void sendInternal({ type: 'internal:clear-cache' })
  // Cache deletion runs in the offscreen; estimate updates over the
  // next second or two as the entries are removed.
  setTimeout(() => {
    els.clearCacheBtn.disabled = false
    els.clearCacheBtn.textContent = 'Clear'
    void refreshStorageEstimate()
  }, 1500)
})

// Initial paint + steady poll while popup is open
void poll()
void refreshStorageEstimate()
void loadRagConfig()
void loadToolApiCredentials()
void loadAccountSettings()
void refreshAuthStatus()
setInterval(poll, POLL_INTERVAL_MS)
// Disk estimate updates less frequently — it only changes when files are
// actually downloaded/evicted, both of which are infrequent compared to
// model-state polls.
setInterval(refreshStorageEstimate, 5_000)
