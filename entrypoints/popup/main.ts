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
import { MODELS, STORAGE_KEY_MODEL, STORAGE_KEY_SETTINGS, STORAGE_KEY_HANDLE_HIDDEN, type ModelId } from '@/shared/models'

const POLL_INTERVAL_MS = 1000

const els = {
  statusModel: document.getElementById('status-model')!,
  statusQueue: document.getElementById('status-queue')!,
  statusDisk: document.getElementById('status-disk')!,
  clearCacheBtn: document.getElementById('clear-cache-btn') as HTMLButtonElement,
  statusWake: document.getElementById('status-wake')!,
  wakeToggleBtn: document.getElementById('wake-toggle-btn') as HTMLButtonElement,
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
  themeSelect: document.getElementById('setting-theme') as HTMLSelectElement,
  showHandleToggle: document.getElementById('setting-show-handle') as HTMLInputElement,
  readPageContentToggle: document.getElementById('setting-read-page-content') as HTMLInputElement,
  wwwRagGroundingToggle: document.getElementById('setting-www-rag-grounding') as HTMLInputElement,
  allowChatDataUseToggle: document.getElementById('setting-allow-chat-data-use') as HTMLInputElement,
  tempInput: document.getElementById('setting-temperature') as HTMLInputElement,
  maxTokensInput: document.getElementById('setting-max-tokens') as HTMLInputElement,
  cfAccountIdInput: document.getElementById('setting-cf-account-id') as HTMLInputElement,
  cfApiTokenInput: document.getElementById('setting-cf-api-token') as HTMLInputElement,
  braveApiKeyInput: document.getElementById('setting-brave-api-key') as HTMLInputElement,
  serperApiKeyInput: document.getElementById('setting-serper-api-key') as HTMLInputElement,
  divinciApiKeyInput: document.getElementById('setting-divinci-api-key') as HTMLInputElement,
  useAccountToggle: document.getElementById('setting-use-divinci-account') as HTMLInputElement,
  useAccountRow: document.querySelector<HTMLElement>('.setting-row-checkbox')!,
  workspaceIdInput: document.getElementById('setting-divinci-workspace-id') as HTMLInputElement,
  releaseIdInput: document.getElementById('setting-divinci-release-id') as HTMLInputElement,
  // Header account widget
  headerSigninBtn: document.getElementById('header-signin-btn') as HTMLButtonElement,
  headerAvatarBtn: document.getElementById('header-avatar-btn') as HTMLButtonElement,
  headerAvatar: document.getElementById('header-avatar') as HTMLImageElement,
  headerAvatarFallback: document.getElementById('header-avatar-fallback')!,
  headerAccountMenu: document.getElementById('header-account-menu')!,
  headerMenuAvatar: document.getElementById('header-menu-avatar') as HTMLImageElement,
  headerMenuAvatarFallback: document.getElementById('header-menu-avatar-fallback')!,
  headerName: document.getElementById('header-name')!,
  headerEmail: document.getElementById('header-email')!,
  headerSignoutBtn: document.getElementById('header-signout-btn') as HTMLButtonElement,
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

// ---- Tool API credentials (immediate commit, no debounce) ---------------
function sendToolApiCredentials(): void {
  void sendInternal({
    type: 'internal:set-settings',
    cfAccountId: els.cfAccountIdInput.value || undefined,
    cfApiToken: els.cfApiTokenInput.value || undefined,
    braveApiKey: els.braveApiKeyInput.value || undefined,
    serperApiKey: els.serperApiKeyInput.value || undefined,
    divinciApiKey: els.divinciApiKeyInput.value || undefined,
  })
}

async function loadToolApiCredentials(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
  const settings = stored[STORAGE_KEY_SETTINGS] as
    | { cfAccountId?: string; cfApiToken?: string; braveApiKey?: string; serperApiKey?: string; divinciApiKey?: string }
    | undefined
  els.cfAccountIdInput.value = settings?.cfAccountId ?? ''
  els.cfApiTokenInput.value = settings?.cfApiToken ?? ''
  els.braveApiKeyInput.value = settings?.braveApiKey ?? ''
  els.serperApiKeyInput.value = settings?.serperApiKey ?? ''
  els.divinciApiKeyInput.value = settings?.divinciApiKey ?? ''
  updateUseAccountRowVisibility()
}

for (const input of [els.cfAccountIdInput, els.cfApiTokenInput, els.braveApiKeyInput, els.serperApiKeyInput, els.divinciApiKeyInput]) {
  input.addEventListener('input', () => {
    void sendToolApiCredentials()
    updateUseAccountRowVisibility()
  })
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

// ---- Privacy settings (immediate commit on change) ---------------------
// Two booleans default to ON (DEFAULT_SETTINGS): undefined (never saved) is
// treated as enabled, so a fresh user sees both checked.
function sendPrivacySettings(): void {
  void sendInternal({
    type: 'internal:set-settings',
    readPageContent: els.readPageContentToggle.checked,
    wwwRagGrounding: els.wwwRagGroundingToggle.checked,
    allowChatDataUse: els.allowChatDataUseToggle.checked,
  })
}

async function loadPrivacySettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
  const s = stored[STORAGE_KEY_SETTINGS] as
    | { readPageContent?: boolean; wwwRagGrounding?: boolean; allowChatDataUse?: boolean }
    | undefined
  // Default ON: only an explicit false unchecks.
  els.readPageContentToggle.checked = s?.readPageContent !== false
  els.wwwRagGroundingToggle.checked = s?.wwwRagGrounding !== false
  els.allowChatDataUseToggle.checked = s?.allowChatDataUse !== false
}

els.readPageContentToggle.addEventListener('change', () => { sendPrivacySettings() })
els.wwwRagGroundingToggle.addEventListener('change', () => { sendPrivacySettings() })
els.allowChatDataUseToggle.addEventListener('change', () => { sendPrivacySettings() })

// Last known auth status — used by the conditional-checkbox logic so it can
// recompute on tool-credential input events without re-querying the SW.
let lastAuthSignedIn = false

/** First letter for the avatar fallback circle, from name then email. */
function avatarInitial(resp: InternalDivinciAuthStatusResponse | null): string {
  const src = resp?.name?.trim() || resp?.email?.trim() || ''
  return src ? src.charAt(0) : '?'
}

/**
 * Render an avatar pair (img + fallback circle). When `picture` is present we
 * show the img; otherwise we hide it and show a circle with the first letter.
 * An img load error also falls back to the circle (set once per render).
 */
function renderAvatar(
  img: HTMLImageElement,
  fallback: HTMLElement,
  picture: string | undefined,
  initial: string,
): void {
  fallback.textContent = initial
  if (picture) {
    img.src = picture
    img.hidden = false
    fallback.hidden = true
    img.onerror = () => {
      img.hidden = true
      fallback.hidden = false
    }
  } else {
    img.removeAttribute('src')
    img.hidden = true
    fallback.hidden = false
  }
}

/** Render the prominent header account widget (sign-in button OR avatar+menu). */
function renderHeaderAccount(resp: InternalDivinciAuthStatusResponse | null): void {
  const signedIn = Boolean(resp?.signedIn)
  if (!signedIn) {
    els.headerSigninBtn.hidden = false
    els.headerAvatarBtn.hidden = true
    els.headerAccountMenu.hidden = true
    els.headerAvatarBtn.setAttribute('aria-expanded', 'false')
    return
  }
  els.headerSigninBtn.hidden = true
  els.headerAvatarBtn.hidden = false
  const initial = avatarInitial(resp)
  renderAvatar(els.headerAvatar, els.headerAvatarFallback, resp?.picture, initial)
  renderAvatar(els.headerMenuAvatar, els.headerMenuAvatarFallback, resp?.picture, initial)
  els.headerName.textContent = resp?.name ?? 'Divinci account'
  els.headerEmail.textContent = resp?.email ?? ''
}

// Auth state now drives ONLY the header account widget + the conditional
// account-mode checkbox. The header owns all sign up / sign in / sign out UI;
// the old body sign-in button + status line were removed.
function renderAuthStatus(resp: InternalDivinciAuthStatusResponse | null): void {
  lastAuthSignedIn = Boolean(resp?.signedIn)
  renderHeaderAccount(resp)
  updateUseAccountRowVisibility()
}

async function refreshAuthStatus(): Promise<void> {
  const resp = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: 'internal:divinci-auth-status',
  })
  renderAuthStatus(resp)
}

// ---- Conditional "Use my Divinci account" checkbox (Item 3) -------------
// The choice only matters when signed in AND at least one manual tool
// credential is present (account-vs-manual). Otherwise hide the row: signed
// out (no account path), or signed in with no manual creds (account is the
// only path — treated as active regardless).
function hasManualCreds(): boolean {
  return Boolean(
    els.cfApiTokenInput.value.trim() ||
      els.braveApiKeyInput.value.trim() ||
      els.serperApiKeyInput.value.trim(),
  )
}

function updateUseAccountRowVisibility(): void {
  els.useAccountRow.hidden = !(lastAuthSignedIn && hasManualCreds())
}

// Toggle the header account menu open/closed.
els.headerAvatarBtn.addEventListener('click', () => {
  const open = els.headerAccountMenu.hidden
  els.headerAccountMenu.hidden = !open
  els.headerAvatarBtn.setAttribute('aria-expanded', String(open))
})

// Close the menu on any outside click.
document.addEventListener('click', (e) => {
  if (els.headerAccountMenu.hidden) return
  const target = e.target as Node
  if (els.headerAvatarBtn.contains(target) || els.headerAccountMenu.contains(target)) return
  els.headerAccountMenu.hidden = true
  els.headerAvatarBtn.setAttribute('aria-expanded', 'false')
})

// The signed-out header button is the sole entry point for creating an
// account — it opens the Auth0 signup screen (screen_hint=signup).
els.headerSigninBtn.addEventListener('click', async () => {
  els.headerSigninBtn.disabled = true
  els.headerSigninBtn.textContent = 'Opening Divinci…'
  const resp = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: 'internal:divinci-signin',
    signup: true,
  })
  els.headerSigninBtn.disabled = false
  els.headerSigninBtn.textContent = 'Sign up'
  renderAuthStatus(resp)
})

els.headerSignoutBtn.addEventListener('click', async () => {
  els.headerSignoutBtn.disabled = true
  const resp = await sendInternal<InternalDivinciAuthStatusResponse>({
    type: 'internal:divinci-signout',
  })
  els.headerSignoutBtn.disabled = false
  els.headerAccountMenu.hidden = true
  els.headerAvatarBtn.setAttribute('aria-expanded', 'false')
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

// ---- Wake word (Phase B0: hands-free "Hey Jarvis") ---------------------
// Mic permission is granted HERE (popup has UI + a user gesture); the offscreen
// doc that runs the always-on loop can't prompt. Detection happens fully
// on-device. State persists so the toggle reflects reality across popup opens.
const STORAGE_KEY_WAKE = 'divinci-wake-enabled'

function renderWake(on: boolean): void {
  els.statusWake.textContent = on ? 'On' : 'Off'
  els.wakeToggleBtn.textContent = on ? 'Disable' : 'Enable'
}

async function loadWake(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_WAKE)
  renderWake(stored[STORAGE_KEY_WAKE] === true)
}

els.wakeToggleBtn.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY_WAKE)
  const currentlyOn = stored[STORAGE_KEY_WAKE] === true
  els.wakeToggleBtn.disabled = true
  try {
    if (!currentlyOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true })
        s.getTracks().forEach((t) => t.stop())
      } catch {
        els.errorText.textContent = 'Microphone permission is required for the wake word.'
        els.errorToast.hidden = false
        return
      }
      await chrome.storage.local.set({ [STORAGE_KEY_WAKE]: true })
      chrome.runtime.sendMessage({ type: 'internal:wake-enable' })
      renderWake(true)
    } else {
      await chrome.storage.local.set({ [STORAGE_KEY_WAKE]: false })
      chrome.runtime.sendMessage({ type: 'internal:wake-disable' })
      renderWake(false)
    }
  } finally {
    els.wakeToggleBtn.disabled = false
  }
})

// ---- Theme (system / light / dark) -------------------------------------
type ThemeMode = 'system' | 'light' | 'dark'

// 'system' = no [data-theme] attr → CSS prefers-color-scheme decides. Explicit
// light/dark set the attr and win over the media query.
function applyTheme(theme: ThemeMode): void {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

async function loadTheme(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS)
  const s = stored[STORAGE_KEY_SETTINGS] as { theme?: ThemeMode } | undefined
  const theme: ThemeMode = s?.theme ?? 'system'
  els.themeSelect.value = theme
  applyTheme(theme)
}

els.themeSelect.addEventListener('change', () => {
  const theme = els.themeSelect.value as ThemeMode
  applyTheme(theme)
  void sendInternal({ type: 'internal:set-settings', theme })
})

// In-page handle visibility (it can be hidden by double-clicking it on a page).
async function loadShowHandle(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_HANDLE_HIDDEN)
  els.showHandleToggle.checked = stored[STORAGE_KEY_HANDLE_HIDDEN] !== true
}
els.showHandleToggle.addEventListener('change', () => {
  // Checked = shown → hidden flag is the inverse. content.ts reacts live via
  // chrome.storage.onChanged.
  void chrome.storage.local.set({ [STORAGE_KEY_HANDLE_HIDDEN]: !els.showHandleToggle.checked })
})

// Initial paint + steady poll while popup is open
void poll()
void refreshStorageEstimate()
void loadToolApiCredentials()
void loadAccountSettings()
void loadPrivacySettings()
void loadTheme()
void loadShowHandle()
void loadWake()
void refreshAuthStatus()
setInterval(poll, POLL_INTERVAL_MS)
// Disk estimate updates less frequently — it only changes when files are
// actually downloaded/evicted, both of which are infrequent compared to
// model-state polls.
setInterval(refreshStorageEstimate, 5_000)
