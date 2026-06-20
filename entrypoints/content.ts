/**
 * In-page sidebar content script.
 *
 * Injects a launcher button + a slide-in right-hand panel on every web
 * page so the user can chat with the locally-running Gemma 4 E2B model
 * from anywhere — not just chat.divinci.app.
 *
 * Wiring (mirrors the web-app path, but same-extension):
 *
 *   content script ──chrome.runtime.connect('divinci-sidebar')──► SW
 *        │                                          (internal-bridge)
 *        │                                                  │
 *        │ chrome.runtime.sendMessage({internal:status})    ▼
 *        └────────────────────────────────────────►  Offscreen doc
 *                                                     (WebGPU + model)
 *
 * The panel speaks the SAME DivinciExternal* protocol the web app uses
 * (divinci:load / divinci:chat / divinci:abort + streamed events). The
 * header readout (loaded? cached? loading%) comes from one-shot
 * internal:status queries, exactly like the popup.
 *
 * Everything model-derived (tokens) and page-derived (title/url) is
 * rendered via textContent — never innerHTML — so there's no injection
 * surface (per the project XSS guidelines: defend at the render boundary).
 */

import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { SIDEBAR_PORT_NAME } from '@/background/internal-bridge'
import {
  MODELS,
  DEFAULT_MODEL_ID,
  type ModelId,
} from '@/shared/models'
import { STORAGE_KEY_DIVINCI_AUTH } from '@/shared/divinci-account'
import type {
  DivinciExternalEvent,
  DivinciExternalRequest,
  InternalStatusResponse,
  InternalPageCheckResponse,
  InternalDivinciAuthStatusResponse,
} from '@/shared/messages'

const MODEL_ID: ModelId = DEFAULT_MODEL_ID
const STORAGE_KEY_OPEN = 'divinci_sidebar_open'
const STATUS_POLL_MS = 1500

type ChatRole = 'user' | 'assistant'
interface ChatMessage {
  role: ChatRole
  content: string
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Avoid running inside our own extension pages or obvious non-content
  // frames. The launcher only makes sense on real web pages.
  allFrames: false,

  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'divinci-local-sidebar',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      // Keep page hotkeys from firing while the user types in our textarea,
      // and keep page CSS from leaking in (createIsolatedElement applies an
      // `all:initial` reset on the host).
      isolateEvents: true,
      css: SIDEBAR_CSS,
      onMount: (container) => mountSidebar(container, ctx),
      onRemove: (mounted) => mounted?.dispose(),
    })

    ui.mount()
  },
})

/** Everything the onRemove cleanup needs to tear down. */
interface MountedSidebar {
  dispose: () => void
}

function mountSidebar(
  container: HTMLElement,
  ctx: { onInvalidated: (cb: () => void) => void },
): MountedSidebar {
  // ---- DOM scaffold -------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'dls-root'
  root.innerHTML = TEMPLATE
  container.appendChild(root)

  const el = {
    launcher: root.querySelector<HTMLButtonElement>('.dls-launcher')!,
    panel: root.querySelector<HTMLElement>('.dls-panel')!,
    close: root.querySelector<HTMLButtonElement>('.dls-close')!,
    statusDot: root.querySelector<HTMLElement>('.dls-status-dot')!,
    pagePill: root.querySelector<HTMLElement>('.dls-page-pill')!,
    modelChip: root.querySelector<HTMLButtonElement>('.dls-model-chip')!,
    accountChip: root.querySelector<HTMLButtonElement>('.dls-account-chip')!,
    accountAvatar: root.querySelector<HTMLImageElement>('.dls-account-avatar')!,
    accountFallback: root.querySelector<HTMLElement>('.dls-account-fallback')!,
    accountLabel: root.querySelector<HTMLElement>('.dls-account-label')!,
    loadCard: root.querySelector<HTMLElement>('.dls-load-card')!,
    loadBtn: root.querySelector<HTMLButtonElement>('.dls-load-btn')!,
    loadHint: root.querySelector<HTMLElement>('.dls-load-hint')!,
    progress: root.querySelector<HTMLElement>('.dls-progress')!,
    progressFill: root.querySelector<HTMLElement>('.dls-progress-fill')!,
    progressText: root.querySelector<HTMLElement>('.dls-progress-text')!,
    messages: root.querySelector<HTMLElement>('.dls-messages')!,
    empty: root.querySelector<HTMLElement>('.dls-empty')!,
    input: root.querySelector<HTMLTextAreaElement>('.dls-input')!,
    send: root.querySelector<HTMLButtonElement>('.dls-send')!,
  }
  el.loadHint.textContent = `${MODELS[MODEL_ID].label} · ${MODELS[MODEL_ID].downloadSize} · first load downloads`
  el.modelChip.textContent = MODELS[MODEL_ID].label

  // ---- State --------------------------------------------------------------
  const history: ChatMessage[] = []
  let port: chrome.runtime.Port | null = null
  let isLoaded = false
  let isLoading = false
  let activeRequestId: string | null = null
  let streamingBubble: HTMLElement | null = null
  let pollTimer: number | null = null
  let disposed = false
  let pageStatus: InternalPageCheckResponse['status'] | null = null
  let lastCheckedUrl = ''
  let navTimer: number | null = null

  function newRequestId(): string {
    return `sidebar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ---- Port lifecycle -----------------------------------------------------
  // Lazily connect on first open so we don't spin the offscreen up on every
  // page. The port survives until the SW evicts it or the tab closes; if it
  // drops we transparently reconnect on the next send.
  function ensurePort(): chrome.runtime.Port {
    if (port) return port
    const p = chrome.runtime.connect({ name: SIDEBAR_PORT_NAME })
    p.onMessage.addListener((msg: DivinciExternalEvent) => onPortEvent(msg))
    p.onDisconnect.addListener(() => {
      if (port === p) port = null
    })
    port = p
    return p
  }

  function send(req: DivinciExternalRequest): void {
    try {
      ensurePort().postMessage(req)
    } catch {
      // Port died between ensure and post — rebuild once and retry.
      port = null
      try {
        ensurePort().postMessage(req)
      } catch {
        showError('Extension background is unavailable. Try reloading the page.')
      }
    }
  }

  // ---- Status (one-shot, like the popup) ----------------------------------
  function queryStatus(): void {
    try {
      chrome.runtime.sendMessage(
        { type: 'internal:status' },
        (resp: InternalStatusResponse | undefined) => {
          void chrome.runtime.lastError // swallow "no receiver" during SW spin-up
          if (resp) applyStatus(resp)
        },
      )
    } catch {
      /* extension context gone; ctx.onInvalidated will tear us down */
    }
  }

  // ---- Divinci account chip (signed-in state) -----------------------------
  // The SW answers internal:divinci-auth-status; render a tiny avatar + email
  // when signed in, "Local only" when not. Values via textContent / img.src.
  function queryAccountStatus(): void {
    try {
      chrome.runtime.sendMessage(
        { type: 'internal:divinci-auth-status' },
        (resp: InternalDivinciAuthStatusResponse | undefined) => {
          void chrome.runtime.lastError
          if (resp) renderAccountChip(resp)
        },
      )
    } catch {
      /* extension context gone */
    }
  }

  function renderAccountChip(resp: InternalDivinciAuthStatusResponse): void {
    if (!resp.signedIn) {
      // Signed-out: compact "Local only" pill, no avatar.
      el.accountChip.dataset.state = 'signed-out'
      el.accountAvatar.hidden = true
      el.accountAvatar.removeAttribute('src')
      el.accountFallback.hidden = true
      el.accountLabel.hidden = false
      el.accountLabel.textContent = 'Local only'
      el.accountChip.title = 'Sign in via the Divinci Local popup'
      return
    }
    // Signed-in: show JUST the avatar circle (matches the popup dropdown),
    // email moves to the tooltip. Falls back to an initial circle when the
    // id_token carried no picture.
    el.accountChip.dataset.state = 'signed-in'
    el.accountChip.title = resp.email || 'Signed in'
    el.accountLabel.hidden = true
    const initial = (resp.name?.trim() || resp.email?.trim() || '?').charAt(0).toUpperCase()
    if (resp.picture) {
      el.accountAvatar.src = resp.picture
      el.accountAvatar.hidden = false
      el.accountFallback.hidden = true
      el.accountAvatar.onerror = () => {
        // Picture failed to load → fall back to the initial circle.
        el.accountAvatar.hidden = true
        el.accountFallback.textContent = initial
        el.accountFallback.hidden = false
      }
    } else {
      el.accountAvatar.hidden = true
      el.accountAvatar.removeAttribute('src')
      el.accountFallback.textContent = initial
      el.accountFallback.hidden = false
    }
  }

  // Clicking the model chip or account avatar opens the extension popup
  // (best-effort: chrome.action.openPopup is Chrome 127+ and may be a no-op
  // from a content-script-triggered SW call — harmless if it doesn't open).
  function requestOpenPopup(): void {
    try {
      chrome.runtime.sendMessage({ type: 'internal:open-popup' }, () => {
        void chrome.runtime.lastError
      })
    } catch {
      /* extension context gone */
    }
  }
  el.modelChip.addEventListener('click', requestOpenPopup)
  el.accountChip.addEventListener('click', requestOpenPopup)

  // ---- Page indexing status ------------------------------------------------
  function checkPageStatus(): void {
    const url = location.href
    // Skip if we already checked this URL (avoid redundant calls on popstate
    // that didn't actually change the URL).
    if (url === lastCheckedUrl) return
    lastCheckedUrl = url

    el.pagePill.hidden = true
    try {
      chrome.runtime.sendMessage(
        { type: 'internal:check-page', url },
        (resp: InternalPageCheckResponse | undefined) => {
          void chrome.runtime.lastError
          if (resp) applyPageStatus(resp)
        },
      )
    } catch {
      /* extension context gone */
    }
  }

  function applyPageStatus(resp: InternalPageCheckResponse): void {
    pageStatus = resp.status
    renderPageStatus()
  }

  function renderPageStatus(): void {
    if (!pageStatus || pageStatus === 'not-configured') {
      el.pagePill.hidden = true
      return
    }
    el.pagePill.hidden = false
    switch (pageStatus) {
      case 'indexed':
        el.pagePill.textContent = 'Indexed'
        el.pagePill.dataset.state = 'indexed'
        break
      case 'triggered':
        el.pagePill.textContent = 'Indexing…'
        el.pagePill.dataset.state = 'triggered'
        break
      case 'checking':
        el.pagePill.textContent = 'Checking…'
        el.pagePill.dataset.state = 'checking'
        break
      case 'error':
        el.pagePill.textContent = 'Error'
        el.pagePill.dataset.state = 'error'
        break
    }
  }

  function setupNavigationDetection(): void {
    // Check on initial page load
    checkPageStatus()

    // SPA navigation: popstate (back/forward)
    window.addEventListener('popstate', onNavChange)

    // SPA navigation: pushState / replaceState
    const { pushState: origPushState, replaceState: origReplaceState } = window.history
    window.history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
      origPushState.call(window.history, data, unused, url)
      onNavChange()
    }
    window.history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
      origReplaceState.call(window.history, data, unused, url)
      onNavChange()
    }
  }

  /** Debounced handler to avoid rapid-fire checks during SPA transitions. */
  function onNavChange(): void {
    if (navTimer != null) window.clearTimeout(navTimer)
    navTimer = window.setTimeout(() => {
      navTimer = null
      checkPageStatus()
    }, 300)
  }

  function applyStatus(status: InternalStatusResponse): void {
    isLoading = status.loadingModelId != null
    isLoaded = status.isLoaded && status.currentModelId === MODEL_ID

    if (isLoading && status.loadProgress) {
      const { bytesLoaded, bytesTotal } = status.loadProgress
      renderProgress(bytesLoaded, bytesTotal)
    }
    renderModelState()
  }

  // ---- Port event handling ------------------------------------------------
  function onPortEvent(ev: DivinciExternalEvent): void {
    switch (ev.type) {
      case 'divinci:pong':
        return
      case 'divinci:load-progress':
        isLoading = true
        renderProgress(ev.bytesLoaded, ev.bytesTotal)
        renderModelState()
        return
      case 'divinci:load-done':
        isLoading = false
        isLoaded = true
        renderModelState()
        return
      case 'divinci:queued':
        if (streamingBubble) streamingBubble.textContent = `Queued (#${ev.position})…`
        return
      case 'divinci:chat-token':
        if (ev.requestId !== activeRequestId || !streamingBubble) return
        if (streamingBubble.dataset.placeholder) {
          streamingBubble.textContent = ''
          delete streamingBubble.dataset.placeholder
        }
        streamingBubble.textContent = (streamingBubble.textContent ?? '') + ev.delta
        scrollToBottom()
        return
      case 'divinci:chat-done':
        if (ev.requestId !== activeRequestId) return
        if (streamingBubble) {
          if (streamingBubble.dataset.placeholder) {
            // No tokens streamed (e.g. empty generation) — fall back to fullText.
            streamingBubble.textContent = ev.fullText || '(no response)'
            delete streamingBubble.dataset.placeholder
          }
          history.push({ role: 'assistant', content: streamingBubble.textContent ?? '' })
        }
        finishGeneration()
        return
      case 'divinci:aborted':
        if (ev.requestId !== activeRequestId) return
        if (streamingBubble && streamingBubble.dataset.placeholder) {
          streamingBubble.textContent = '(stopped)'
        } else if (streamingBubble) {
          history.push({ role: 'assistant', content: streamingBubble.textContent ?? '' })
        }
        finishGeneration()
        return
      case 'divinci:error':
        if (ev.requestId && ev.requestId !== activeRequestId) {
          showError(ev.message)
          return
        }
        if (streamingBubble) {
          streamingBubble.classList.add('dls-bubble-error')
          streamingBubble.textContent = `Error: ${ev.message}`
          delete streamingBubble.dataset.placeholder
        } else {
          showError(ev.message)
        }
        if (ev.fatal) isLoaded = false
        finishGeneration()
        renderModelState()
        return
    }
  }

  // ---- Actions ------------------------------------------------------------
  function loadModel(): void {
    isLoading = true
    renderModelState()
    send({ type: 'divinci:load', requestId: newRequestId(), modelId: MODEL_ID })
  }

  function sendChat(): void {
    const text = el.input.value.trim()
    if (!text || activeRequestId) return
    if (!isLoaded) {
      // First message before load — kick the load and let the user retry once
      // it's ready (clearer than silently queueing a chat that'll error).
      loadModel()
      return
    }

    el.input.value = ''
    autosize()
    el.empty.hidden = true

    history.push({ role: 'user', content: text })
    appendBubble('user', text)

    streamingBubble = appendBubble('assistant', '…')
    streamingBubble.dataset.placeholder = '1'

    activeRequestId = newRequestId()
    renderSendButton()

    send({
      type: 'divinci:chat',
      requestId: activeRequestId,
      modelId: MODEL_ID,
      messages: buildPromptMessages(),
    })
    scrollToBottom()
  }

  function stopChat(): void {
    if (!activeRequestId) return
    send({ type: 'divinci:abort', requestId: activeRequestId })
  }

  function finishGeneration(): void {
    activeRequestId = null
    streamingBubble = null
    renderSendButton()
    scrollToBottom()
  }

  /**
   * Build the message array sent to the model: a small system prompt that
   * makes the assistant aware of the page the user is on (local inference,
   * so no privacy cost), followed by the running conversation.
   */
  function buildPromptMessages(): Array<{ role: 'system' | ChatRole; content: string }> {
    const sys =
      'You are Divinci, a concise, helpful AI assistant running locally in the ' +
      `user's browser via WebGPU. The user is currently viewing the page ` +
      `"${document.title}" (${location.href}). Use that as context only when relevant.`
    return [{ role: 'system', content: sys }, ...history]
  }

  // ---- Rendering ----------------------------------------------------------
  function appendBubble(role: ChatRole, text: string): HTMLElement {
    const bubble = document.createElement('div')
    bubble.className = `dls-bubble dls-bubble-${role}`
    bubble.textContent = text
    el.messages.appendChild(bubble)
    scrollToBottom()
    return bubble
  }

  function renderProgress(loaded: number, total: number | null): void {
    el.progress.hidden = false
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null
    el.progressFill.style.width = pct != null ? `${pct}%` : '15%'
    el.progressText.textContent =
      pct != null
        ? `Downloading model — ${pct}% (${fmtBytes(loaded)} / ${fmtBytes(total)})`
        : `Downloading model — ${fmtBytes(loaded)}`
  }

  function renderModelState(): void {
    if (isLoaded) {
      // Green status dot on the logo = a model is loaded + ready (replaces the
      // former "Ready" text pill).
      el.statusDot.dataset.state = 'ready'
      el.statusDot.title = 'Model loaded — ready'
      el.loadCard.hidden = true
      el.progress.hidden = true
      el.input.disabled = false
      el.input.placeholder = 'Message Gemma 4…'
    } else if (isLoading) {
      el.statusDot.dataset.state = 'loading'
      el.statusDot.title = 'Loading model…'
      el.loadCard.hidden = false
      el.loadBtn.disabled = true
      el.loadBtn.textContent = 'Loading…'
      el.input.disabled = true
      el.input.placeholder = 'Model loading…'
    } else {
      el.statusDot.dataset.state = 'idle'
      el.statusDot.title = 'No model loaded'
      el.loadCard.hidden = false
      el.progress.hidden = true
      el.loadBtn.disabled = false
      el.loadBtn.textContent = `Load ${MODELS[MODEL_ID].label}`
      el.input.disabled = true
      el.input.placeholder = 'Load the model to start chatting'
    }
    renderSendButton()
  }

  function renderSendButton(): void {
    if (activeRequestId) {
      el.send.textContent = 'Stop'
      el.send.dataset.mode = 'stop'
      el.send.disabled = false
    } else {
      el.send.textContent = 'Send'
      el.send.dataset.mode = 'send'
      el.send.disabled = !isLoaded
    }
  }

  function showError(message: string): void {
    const bubble = appendBubble('assistant', `⚠ ${message}`)
    bubble.classList.add('dls-bubble-error')
  }

  function scrollToBottom(): void {
    el.messages.scrollTop = el.messages.scrollHeight
  }

  function autosize(): void {
    el.input.style.height = 'auto'
    el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`
  }

  // ---- Open/close ---------------------------------------------------------
  function setOpen(open: boolean, persist = true): void {
    root.classList.toggle('dls-open', open)
    el.launcher.setAttribute('aria-expanded', String(open))
    if (open) {
      ensurePort()
      send({ type: 'divinci:ping' }) // exercise the fresh connection
      queryStatus()
      queryAccountStatus()
      startPolling()
      setTimeout(() => el.input.focus(), 60)
    } else {
      stopPolling()
    }
    if (persist) void chrome.storage.local.set({ [STORAGE_KEY_OPEN]: open })
  }

  function startPolling(): void {
    if (pollTimer != null) return
    pollTimer = window.setInterval(queryStatus, STATUS_POLL_MS)
  }
  function stopPolling(): void {
    if (pollTimer != null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // ---- Wire events --------------------------------------------------------
  el.launcher.addEventListener('click', () => setOpen(!root.classList.contains('dls-open')))
  el.close.addEventListener('click', () => setOpen(false))
  el.loadBtn.addEventListener('click', loadModel)
  el.send.addEventListener('click', () => (activeRequestId ? stopChat() : sendChat()))
  el.input.addEventListener('input', autosize)
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  })

  // Sync open-state across tabs/popup when toggled elsewhere.
  const storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local') return
    // Live-update the account chip when the SW writes/clears the token bundle.
    if (STORAGE_KEY_DIVINCI_AUTH in changes) queryAccountStatus()
    if (!(STORAGE_KEY_OPEN in changes)) return
    const open = changes[STORAGE_KEY_OPEN].newValue === true
    if (open !== root.classList.contains('dls-open')) setOpen(open, false)
  }
  chrome.storage.onChanged.addListener(storageListener)

  // ---- Navigation detection ------------------------------------------------
  setupNavigationDetection()

  // ---- Initial paint ------------------------------------------------------
  renderModelState()
  void chrome.storage.local.get(STORAGE_KEY_OPEN).then((stored) => {
    if (disposed) return
    if (stored[STORAGE_KEY_OPEN] === true) setOpen(true, false)
  })

  return {
    dispose: () => {
      disposed = true
      stopPolling()
      if (navTimer != null) window.clearTimeout(navTimer)
      try {
        chrome.storage.onChanged.removeListener(storageListener)
      } catch {
        /* context already gone */
      }
      try {
        port?.disconnect()
      } catch {
        /* already closed */
      }
      port = null
    },
  }
}

// ---- helpers ----------------------------------------------------------------

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ---- markup + styles --------------------------------------------------------

const TEMPLATE = /* html */ `
  <button class="dls-launcher" aria-label="Open Divinci local chat" aria-expanded="false" title="Chat with Gemma 4 (local)">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z"/>
    </svg>
  </button>

  <aside class="dls-panel" role="dialog" aria-label="Divinci local chat">
    <header class="dls-header">
      <div class="dls-title">
        <span class="dls-logo" title="Model status">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z"/>
          </svg>
          <span class="dls-status-dot" data-state="idle"></span>
        </span>
        <span class="dls-title-text">Divinci Local</span>
        <span class="dls-page-pill" data-state="unknown" hidden></span>
        <button class="dls-model-chip" type="button" title="Open Divinci Local settings"></button>
        <button class="dls-account-chip" data-state="signed-out" type="button" title="Divinci account">
          <img class="dls-account-avatar" alt="" width="20" height="20" hidden />
          <span class="dls-account-fallback" hidden></span>
          <span class="dls-account-label">Local only</span>
        </button>
      </div>
      <button class="dls-close" aria-label="Close">×</button>
    </header>

    <div class="dls-load-card">
      <button class="dls-load-btn">Load model</button>
      <p class="dls-load-hint"></p>
      <div class="dls-progress" hidden>
        <div class="dls-progress-track"><div class="dls-progress-fill"></div></div>
        <p class="dls-progress-text"></p>
      </div>
    </div>

    <div class="dls-messages">
      <p class="dls-empty">Ask Gemma 4 anything — it runs entirely on your GPU, on any page.</p>
    </div>

    <footer class="dls-footer">
      <textarea class="dls-input" rows="1" placeholder="Load the model to start chatting" disabled></textarea>
      <button class="dls-send" data-mode="send" disabled>Send</button>
    </footer>
  </aside>
`

const SIDEBAR_CSS = /* css */ `
  .dls-root {
    --dls-bg: #0f1117;
    --dls-bg-2: #161924;
    --dls-border: #1f2230;
    --dls-text: #e8e8ec;
    --dls-muted: #8b91a7;
    --dls-accent: #5865f2;
    --dls-accent-hover: #6b77f5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: var(--dls-text);
  }
  .dls-root * { box-sizing: border-box; }

  /* Light mode follows the OS (system). The popup has an explicit theme
     picker; the in-page sidebar tracks prefers-color-scheme for now. */
  @media (prefers-color-scheme: light) {
    .dls-root {
      --dls-bg: #f7f8fa;
      --dls-bg-2: #ffffff;
      --dls-border: #e3e6ed;
      --dls-text: #1a1d27;
      --dls-muted: #5c6373;
    }
  }

  .dls-launcher {
    position: fixed;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2147483646;
    width: 40px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--dls-accent);
    color: #fff;
    border: none;
    border-radius: 10px 0 0 10px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    transition: background 0.15s ease, right 0.25s ease;
  }
  .dls-launcher:hover { background: var(--dls-accent-hover); }
  .dls-root.dls-open .dls-launcher { right: 380px; }

  .dls-panel {
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    width: 380px;
    max-width: 92vw;
    z-index: 2147483645;
    display: flex;
    flex-direction: column;
    background: var(--dls-bg);
    border-left: 1px solid var(--dls-border);
    box-shadow: -8px 0 32px rgba(0,0,0,0.4);
    transform: translateX(100%);
    transition: transform 0.25s ease;
  }
  .dls-root.dls-open .dls-panel { transform: translateX(0); }

  .dls-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--dls-border);
  }
  /* Single-row header: logo (with status dot) + title + page/model/account
     chips, all on one line. flex:1 + min-width:0 lets the account label
     ellipsize instead of overflowing the 380px panel. */
  .dls-title { display: flex; align-items: center; gap: 8px; font-weight: 600; flex: 1; min-width: 0; }
  .dls-title-text { white-space: nowrap; flex-shrink: 0; }
  /* Robot logo with a small status indicator dot (replaces the "Ready" text). */
  .dls-logo { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; }
  .dls-logo > svg { color: var(--dls-accent); display: block; }
  .dls-status-dot {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4a4f60;                       /* idle: dim grey */
    border: 1.5px solid var(--dls-bg);         /* ring so it reads against the logo */
    box-sizing: content-box;
  }
  .dls-status-dot[data-state="ready"] {
    background: #3fcf8e;                        /* loaded + ready: green */
    box-shadow: 0 0 5px rgba(63, 207, 142, 0.7);
  }
  .dls-status-dot[data-state="loading"] {
    background: #f2c66b;                        /* loading: amber, pulsing */
    animation: dls-dot-pulse 1s ease-in-out infinite;
  }
  @keyframes dls-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .dls-page-pill {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--dls-border);
    color: var(--dls-muted);
    margin-left: -4px;
  }
  .dls-page-pill[hidden] { display: none; }
  .dls-page-pill[data-state="indexed"] { color: #7ee2a8; border-color: #2c4636; }
  .dls-page-pill[data-state="triggered"] { color: #f2c66b; border-color: #4a3f24; }
  .dls-page-pill[data-state="checking"] { color: #8b91a7; border-color: #3a3e50; }
  .dls-page-pill[data-state="error"] { color: #ff9b9b; border-color: #4a3a3a; }
  .dls-close {
    background: transparent;
    border: none;
    color: var(--dls-muted);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .dls-close:hover { color: var(--dls-text); }

  /* Model + account chips now live inline in .dls-header (the standalone
     .dls-chips subheader row was removed). */
  .dls-model-chip {
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--dls-border);
    background: var(--dls-bg-2);
    color: var(--dls-muted);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
  }
  .dls-model-chip:hover { border-color: var(--dls-accent); color: var(--dls-text); }
  .dls-account-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--dls-border);
    background: transparent;
    color: var(--dls-muted);
    cursor: pointer;
    flex-shrink: 0;
  }
  .dls-account-chip:hover { border-color: var(--dls-accent); }
  /* Signed-in collapses to a bare avatar circle (matches the popup dropdown):
     no pill border/padding, just the 20px image or initial circle. */
  .dls-account-chip[data-state="signed-in"] {
    padding: 0;
    border: none;
    border-radius: 50%;
  }
  .dls-account-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    display: block;
  }
  .dls-account-avatar[hidden] { display: none; }
  .dls-account-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--dls-accent);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .dls-account-fallback[hidden] { display: none; }
  .dls-account-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 130px;
  }

  .dls-load-card {
    padding: 14px;
    border-bottom: 1px solid var(--dls-border);
  }
  .dls-load-btn {
    width: 100%;
    padding: 9px 12px;
    background: var(--dls-accent);
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .dls-load-btn:hover:not(:disabled) { background: var(--dls-accent-hover); }
  .dls-load-btn:disabled { opacity: 0.6; cursor: default; }
  .dls-load-hint { margin: 8px 0 0; font-size: 12px; color: var(--dls-muted); }

  .dls-progress { margin-top: 10px; }
  .dls-progress-track {
    height: 6px;
    background: var(--dls-bg-2);
    border-radius: 4px;
    overflow: hidden;
  }
  .dls-progress-fill {
    height: 100%;
    width: 0%;
    background: var(--dls-accent);
    transition: width 0.2s ease;
  }
  .dls-progress-text { margin: 6px 0 0; font-size: 11px; color: var(--dls-muted); }

  .dls-messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dls-empty { color: var(--dls-muted); font-size: 13px; text-align: center; margin: auto 0; }

  .dls-bubble {
    max-width: 88%;
    padding: 9px 12px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dls-bubble-user {
    align-self: flex-end;
    background: var(--dls-accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .dls-bubble-assistant {
    align-self: flex-start;
    background: var(--dls-bg-2);
    color: var(--dls-text);
    border: 1px solid var(--dls-border);
    border-bottom-left-radius: 4px;
  }
  .dls-bubble-error { color: #ff9b9b; border-color: #4a3a3a; }

  .dls-footer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 10px 12px;
    border-top: 1px solid var(--dls-border);
  }
  .dls-input {
    flex: 1;
    resize: none;
    background: var(--dls-bg-2);
    color: var(--dls-text);
    border: 1px solid var(--dls-border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.4;
    max-height: 140px;
  }
  .dls-input:focus { outline: none; border-color: var(--dls-accent); }
  .dls-input:disabled { opacity: 0.6; }
  .dls-send {
    padding: 8px 14px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    background: var(--dls-accent);
    color: #fff;
  }
  .dls-send:hover:not(:disabled) { background: var(--dls-accent-hover); }
  .dls-send:disabled { opacity: 0.5; cursor: default; }
  .dls-send[data-mode="stop"] { background: #c0453f; }
`
