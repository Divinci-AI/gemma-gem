# Agent Handoff: Page-Indexing Status Integration

## Goal

Integrate the Divinci Local Inference extension with Divinci's RAG/crawl backend so that every page navigation (full-page load or SPA) checks whether the current URL is indexed in the vector store. If not, it triggers a scrape. The result is shown as a status pill in the sidebar panel.

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `shared/divinci-api.ts` | API client wrapping two endpoints: `checkPage(url)` (read-only existence check) and `scrapePage(url)` (triggers indexing). Handles `X-API-Key` auth header, error wrapping. |
| `background/divinci-api-bridge.ts` | `chrome.runtime.onMessage` handler for `internal:check-page`. Reads `divinci_api_key` / `divinci_whitelabel_id` from `chrome.storage.local`, calls `checkPage` → optionally `scrapePage` if 404, responds with `internal:page-status`. Uses `sendResponse` keepalive pattern for async MV3. |

### Modified Files

| File | Changes |
|------|---------|
| `shared/messages.ts` | Added `InternalPageCheckRequest` (`type: 'internal:check-page'`, `url: string`) and `InternalPageCheckResponse` (`type: 'internal:page-status'`, `status: 'not-configured' \| 'indexed' \| 'triggered' \| 'error' \| 'checking'`) |
| `shared/models.ts` | Added `STORAGE_KEY_API_KEY = 'divinci_api_key'` and `STORAGE_KEY_WHITELABEL_ID = 'divinci_whitelabel_id'` constants (shared between bridge and popup) |
| `entrypoints/background.ts` | Wired `setupDivinciAPIBridge()` alongside existing `setupExternalBridge` / `setupInternalBridge` |
| `wxt.config.ts` | Added `host_permissions` for `https://api.divinci.app`, `https://api.stage.divinci.app`, `https://api.dev.divinci.app`, and `http://localhost:9080` (dev-only) |
| `entrypoints/content.ts` | — **Navigation detection**: listens for `popstate`, intercepts `window.history.pushState`/`replaceState` with 300 ms debounce.<br/>— **Page check**: sends `internal:check-page` message to background SW on each detected URL change.<br/>— **Status pill**: new `.dls-page-pill` element in the sidebar header, with states: `indexed`, `triggered`, `checking`, `error` (hidden when `not-configured` or null). |
| `entrypoints/popup/index.html` | Added `<details>` "Indexing settings" with password field for API key and text field for whitelabel ID. |
| `entrypoints/popup/popup.css` | Added styles for `input[type='password']` and `input[type='text']` in setting rows (matching existing number input styles). |
| `entrypoints/popup/main.ts` | Added `loadRagConfig()` (reads from `chrome.storage.local` on popup open), `saveRagConfig()` (writes on every `input` event — no debounce needed for storage I/O), event listeners for both new inputs. |

---

## Architecture & Flow

```
User opens page / SPA navigates
        │
        ▼
Content script detects URL change
  (popstate / pushState interceptor)
        │
        ▼
chrome.runtime.sendMessage({ type: 'internal:check-page', url })
        │
        ▼
Background SW (divinci-api-bridge.ts)
  1. Reads API key + wlId from chrome.storage.local
  2. If missing → respond 'not-configured', stop
  3. GET /api/v1/html-pages/by-url?url=...
     ├── 200 → respond { status: 'indexed' }
     └── 404 → POST /:wlId/rag-vector/html-page/scrape { url }
                └── respond { status: 'triggered' }
        │
        ▼
Content script receives InternalPageCheckResponse
  → Updates .dls-page-pill text + data-state
```

---

## Key Design Decisions

1. **Silent passive check** — no badge, no toast, no user action required. Status is visible as a pill in the sidebar; the user sees it only when the sidebar is open.

2. **Two API endpoints** — the read endpoint (`/api/v1/html-pages/by-url`) is public (API key only). The write endpoint (`/:wlId/rag-vector/html-page/scrape`) is an internal lifecycle route requiring the whitelabel ID in the URL path. This separation means the extension can check index status without knowing the wlId, but needs it to trigger a scrape.

3. **Storage in `chrome.storage.local`** — API key + whitelabel ID are persisted MV3-style. Content script has no direct storage access; it relays through the background SW.

4. **Popup auto-save** — typing in the API key or whitelabel ID fields immediately commits to storage (no debounce). No save button needed.

5. **History API patching** — intercepts `pushState`/`replaceState` in addition to `popstate` to catch SPA framework navigation. Debounced at 300 ms to avoid duplicate checks during multi-step transitions.

6. **Styling matches existing pill** — `.dls-page-pill` uses the same dimensions, font, border-radius, and color scheme as the model status `.dls-status-pill`.

---

## Verification

- `pnpm tsc --noEmit` — passes clean (zero errors)
- `pnpm build` — passes clean; all chunks built:
  - `background.js` (22 kB) — includes bridge
  - `content-scripts/content.js` (51 kB) — includes nav detection + pill
  - `chunks/popup-*.js` (9 kB) — includes RAG config settings
  - `chunks/models-*.js` (3 kB) — includes storage key constants

---

## What to Review

When reviewing, please focus on:

1. **Background bridge correctness** — message flow, `sendResponse` keepalive, storage read, API call sequencing
2. **Content script** — navigation detection completeness (edge cases: hash-only changes, pushState without URL change, rapid SPA transitions)
3. **Popup settings** — storage key consistency between popup and bridge, input handling
4. **Error handling** — API failures, missing config, extension context invalidated
5. **Type safety** — no `as any`, no `@ts-ignore`, no untagged `unknown` casts
