# Divinci Local — Offline Chat Roadmap

Planning doc for three initiatives requested 2026-06-19:

1. A **dedicated page-wide chat** with account-or-local transcript persistence + import-on-signup.
2. **More tools + MCP** for the offline Gemma model.
3. A **desktop downloadable** version of the mini offline chat app.

Status: planning only — nothing here is built yet. Today's shipped foundation:
Gemma 4 E2B in an offscreen doc (WebGPU + transformers.js), a popup + an in-page
sidebar, account-mode (Auth0 PKCE → `POST /api/v1/workspaces/:id/chat/completions`
server tool proxy), and a local tool loop (Gemma detects intent → Kimi via CF →
web_search). See `TOOL_CALLING_HANDOFF.md` and `project_extension_oauth_tool_proxy`.

---

## 0. Shared foundation (do this first — all three depend on it)

Today the chat logic, inference client, persistence (none), and account proxy are
entangled inside `entrypoints/content.ts` (sidebar) and the popup. Each of the three
initiatives is a new *surface* over the same engine, so the highest-leverage first
move is to extract that engine into reusable, surface-agnostic modules:

- **`chat-core/`** — a framework-free `ChatController`: holds a transcript, streams
  tokens, drives the tool loop, exposes events. No DOM. Consumed by sidebar, popup
  chat, the page-wide app, and the desktop app alike.
- **`chat-core/inference.ts`** — one `InferenceClient` interface with two impls:
  `LocalInference` (the offscreen-doc port we have) and `AccountInference` (the
  server proxy). The current account-vs-local branch in `finalize-chat.ts`
  generalizes into this.
- **`chat-core/transcript-store.ts`** — `TranscriptStore` interface (initiative 1).

This refactor is ~2–3 days and pays for itself immediately: the page-wide chat and
desktop app become thin shells, not rewrites.

---

## 1. Dedicated page-wide chat + account/local persistence + import

**Goal:** a full-page chat (conversation list + thread), not cramped into a 380px
sidebar. Transcripts persist to the **Divinci account** when signed in, else to a
**local browser DB**, and local history can be **imported into the account** on
sign-up/sign-in.

**Surface:** a new extension page `entrypoints/chat/` → `chat.html`, opened from the
popup ("Open full chat") and optionally as a new-tab override (opt-in — overriding
the new tab page is intrusive, make it a setting). Same offscreen Gemma + account
proxy; just a richer UI (left rail of conversations, main thread, model/account
header reusing the widgets we built).

**Persistence — `TranscriptStore` interface, two impls:**
- `LocalTranscriptStore` — **IndexedDB** (via the tiny `idb` wrapper). Stores
  conversations + messages keyed by a client-generated `conversationId` (UUID).
  Survives offline, no account needed. *(localStorage is too small/синхронous for
  transcripts — IndexedDB is the right call.)*
- `AccountTranscriptStore` — the server already persists transcripts (the OAuth chat
  endpoint creates one per conversation; `/api/v1/transcripts` lists/reads them).
  When signed in, mirror writes there.

**Strategy: local-first, mirror-when-signed-in.**
- Every conversation has a stable client `conversationId`. Local store is always
  written. When signed in, the same turns also go to the account (we already pass a
  reused `transcriptId` in account mode — extend it to carry the server transcript id
  back into the local record, so each local convo knows its server twin).
- **Import on sign-in/sign-up:** detect local conversations with no server twin →
  offer "Import N local chats to your Divinci account." Push each via the server's
  batch message ingest (`transcripts.ingestBatch` / `POST …/message/batch` — already
  used by the local-LLM "inference performed elsewhere" path) so the server stores
  the full thread without re-running inference. Stamp the returned server id onto the
  local record; mark imported.
- Conflict model: per-message append, last-write-wins on metadata. Good enough — a
  single user across devices, low contention.

**Key decisions to lock:**
- New-tab override? (recommend: NO by default — opt-in setting; ship as a popup
  button + `chat.html` first.)
- Import UX: automatic prompt on first sign-in vs a manual "Import" button in
  settings (recommend: a one-time prompt + a permanent manual button).
- Do we dedupe re-imports? (yes — the `imported` + server-id stamp prevents doubles.)

**Effort:** ~1 week after the foundation (UI is the bulk; the store interface + import
are small once the server batch path is wired).

**Dependencies:** §0 foundation; confirm the `message/batch` ingest accepts a
whole-thread import under OAuth auth (server-side check).

---

## 2. More tools + MCP for the offline Gemma model

**Today:** `REGISTERED_TOOLS = [web_search]`; the Kimi loop executes it locally (CF +
Brave/Serper) or the server executes the full catalog in account mode.

**Two tracks — local tools vs MCP — because offline and online have different reach:**

**Track A — expand the local tool registry (works offline / no account):**
- Pure-offline tools (no network): `calculator`, `datetime`, `unit_convert`,
  `page_extract` (read the current tab's main content — the sidebar already has page
  context plumbing). These make the offline model genuinely more useful with zero
  dependencies.
- Online-but-local tools (need a key, no account): `fetch_url` (readability extract),
  richer `web_search`. Add executors next to the existing `web_search` one; register
  in `REGISTERED_TOOLS`; the Kimi loop already dispatches by name.

**Track B — MCP (Model Context Protocol):**
- **B1, account-proxied (recommended first):** account mode already routes to the
  server's tool loop, which has the real tool catalog *and* the user's connected MCP
  servers (the Divinci MCP infra). So "MCP for offline Gemma" is mostly *free* in
  account mode — surface the server's available tools/MCP servers in the UI and let
  the server execute them. Lowest effort, biggest catalog, no client MCP runtime.
- **B2, direct remote MCP (later):** the SW connects to remote MCP servers over
  Streamable HTTP/SSE, lists their tools, and feeds them into the local Kimi loop as
  tool defs. Needs a client MCP client in the SW + per-server auth + a UI to add
  servers. More work; do after B1 proves demand.
- **B3, WebMCP / `window.ai` (watch):** page-provided tools the page exposes to the
  agent. We already track this (`project_browser_llm_emerging_standards`). Wire when
  the standard firms up — the tool-call wire is already forward-compatible.

**Key decisions:** which offline tools ship first (recommend calculator + datetime +
page_extract — all offline, high utility); MCP via account-proxy (B1) before any
client MCP runtime (B2).

**Effort:** Track A ~2–3 days for the first 3–4 tools. B1 ~3–4 days (mostly UI +
server surfacing of the tool list). B2 is a separate ~1–2 week project.

**Dependencies:** the tool registry already exists; B1 needs a server endpoint to
*list* a workspace's available tools/MCP servers (may need a small addition).

---

## 3. Desktop downloadable app

**Goal:** a standalone desktop build of the mini offline Divinci chat (the page-wide
chat from §1, as a native-feeling app).

**The deciding constraint is WebGPU** — Gemma runs via transformers.js on WebGPU, so
the desktop runtime MUST expose WebGPU to the web layer.

| Option | WebGPU | Binary size | Effort | Notes |
|---|---|---|---|---|
| **PWA (installable)** | ✅ (Chrome/Edge engine) | ~0 (uses browser) | **Lowest** | Reuses §1 verbatim; "Install app" from the browser; offline via service worker. Not a true native binary. |
| **Electron** | ✅ (bundles Chromium) | ~150–200 MB | Medium | Guaranteed WebGPU + transformers.js as-is. True downloadable installer. Heaviest binary. |
| **Tauri** | ⚠️ system webview (WebView2 ✅; WKWebView/WebKitGTK WebGPU is experimental/inconsistent) | ~10–20 MB | Medium | Tiny binary, but WebGPU support varies by OS webview — real risk for the model path. |

**Recommendation: PWA first, Electron for the true binary, skip Tauri for now.**
- **Phase 1 — PWA:** make the §1 page-wide chat installable (manifest + service
  worker caching the app shell; the ~2.9 GB model already caches via the Cache API).
  Near-zero extra work once §1 exists; gives a "downloadable" offline app immediately
  on Chrome/Edge.
- **Phase 2 — Electron:** wrap the same web build in Electron for a real downloadable
  installer with guaranteed WebGPU, code-signing, auto-update. This is the "desktop
  app" deliverable proper.
- **Tauri** only if binary size becomes a hard requirement AND WebView2-on-Windows
  is the primary target (where WebGPU works).

**Auth in desktop:** OAuth PKCE can't use the `chromiumapp.org` redirect outside an
extension. Desktop uses a **loopback redirect** (`http://127.0.0.1:<port>/callback`)
or a **custom scheme** (`divinci://callback`). Register a dedicated Auth0 app +
callback for desktop (same pattern as the extension app we created). The token logic
from `divinci-auth.ts` ports over; only the redirect + the "open the system browser"
step change.

**Reuse:** §0 `chat-core` + §1 page-wide UI + the account proxy are the entire app.
Desktop adds: a shell (PWA manifest or Electron main), desktop OAuth redirect, and
auto-update (Electron).

**Effort:** PWA ~2–3 days (after §1). Electron ~1–2 weeks (packaging, signing,
auto-update, CI for 3 OSes).

---

## Recommended sequencing

```
§0 Shared foundation (chat-core: controller + inference + store)   ~2–3 d   ← unblocks all
   │
   ├─ §1 Page-wide chat + local/account persistence + import       ~1 wk
   │     │
   │     ├─ §3 Phase 1: PWA (installable offline app)               ~2–3 d
   │     └─ §3 Phase 2: Electron desktop binary                     ~1–2 wk
   │
   └─ §2 Track A: offline tools (calc/datetime/page_extract)        ~2–3 d  (parallelizable)
         §2 Track B1: account-proxied MCP/tool catalog              ~3–4 d
         §2 Track B2: direct remote MCP client                      ~1–2 wk (later)
```

**Fastest path to user-visible value:** §0 → §1 → §3-PWA gives a full offline chat
app, installable, with synced history — reusing everything we already built. §2
Track A (offline tools) can run in parallel since it only touches the tool registry.

## Open questions for the owner
1. New-tab override for the page-wide chat: opt-in setting, or never? (recommend opt-in)
2. Desktop: PWA-first acceptable as the initial "download," or do you need a true
   native installer (Electron) on day one?
3. MCP: is account-proxied (B1) enough for v1, or do you want the extension to connect
   to remote MCP servers directly (B2)?
4. Offline tool priority: which 3–4 tools first?
