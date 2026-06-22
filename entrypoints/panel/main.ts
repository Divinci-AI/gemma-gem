/**
 * Standalone panel page — the chat UI mounted as a browser side-panel dock
 * (and, in Phase 3, a pop-out window). Reuses the shared mountChatPanel in
 * 'panel' mode: always open, no launcher/drag, no host page. The SW port
 * transport (chrome.runtime.connect) works here exactly as in the content
 * script, so account/local chat behave identically to the overlay.
 */
import { mountChatPanel, SIDEBAR_CSS } from '@/ui/chat-panel'

// Extension page → no shadow root, so inject the panel CSS into the document.
const style = document.createElement('style')
style.textContent = SIDEBAR_CSS
document.head.appendChild(style)

// The pop-out window is opened with ?surface=popout (see panel-mode-bridge);
// the side-panel dock loads panel.html with no param. This drives the
// hamburger toggle-row highlight so each surface marks itself active.
const surface = new URLSearchParams(location.search).get('surface') === 'popout' ? 'popout' : 'dock'

mountChatPanel(document.body, { mode: 'panel', surface })
