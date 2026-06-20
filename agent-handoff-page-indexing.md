# WWW RAG — global page-context indexing (design)

> Supersedes the earlier "manual API key + whitelabel ID" page-check design,
> which got the model wrong. Indexing is **not** a per-user, manually-keyed,
> per-tenant thing. It is one **global, behind-the-scenes Divinci corpus
> ("WWW RAG")** that authorized users' extensions and a background pipeline
> co-populate, queryable by URL for page-specific context.

## 1. The model (corrected)

- **WWW RAG = one shared Divinci project** (a single system-owned whitelabel,
  call it `WWW_RAG`). Every crawled page on the public internet lands in this
  one project's RAG vector. It is **cross-tenant / global**, not per-user.
- **Authorized, behind the scenes.** The extension acts as the **signed-in
  Divinci user** (OAuth Bearer — the header sign-in we already ship). No
  manually-pasted API keys or whitelabel IDs. Reads are available to any
  authenticated Divinci user (it's a shared public-read corpus); contributions
  are guarded (see §4).
- **Two populators of the same corpus:**
  1. **This extension** — opportunistic collection as users browse (+ on-demand
     context queries for the page they're on).
  2. **A background pipeline** — runs around the clock, crawling/refreshing
     WWW RAG independent of any user.

## 2. Per-page flow (what the extension does on each navigation)

```
signed in?  ── no ─► do nothing (pill hidden / "sign in to enable")
   │ yes
URL allowed by client denylist? ── no ─► pill: "skipped" (see §4)
   │ yes
GET  /api/v1/www-rag/page-status?url=<href>&hash=<clientContentHash>   (Bearer)
   ├─ not-indexed ────► [optional] POST /api/v1/www-rag/submit-url {url}  → pill "indexing…"
   ├─ indexed, stale ─► [optional] submit-url (re-crawl) + still usable    → pill "indexed (update queued)"
   └─ indexed, fresh ─► POST /api/v1/www-rag/page-context {url, query}     → pill "indexed ✓"
                          (returns chunks scoped to THIS url → ground the
                           sidebar chat / answer about the current page)
```

- **"site has an index?"** collapses to "is there a crawled page (or any page
  for this host) in WWW RAG?" — answered by `page-status` (per-URL) with an
  optional host-level hint.
- **"has this page been crawled?"** → `page-status` returns `crawled: bool` +
  `version`, `lastCrawledAt`, `contentHash`.
- **"new version?"** → content-hash compare, see §3.
- **"query context for this page"** → `page-context` (URL-scoped retrieval).

## 3. Content-hash / versioning

The HTML-page model already has `contentHash`, `version`, `versionHistory`
(`workspace/resources/models/src/white-label/RagVector/html/html-page.ts`).
**Parity is the catch:** the server's `contentHash` is over the *scraped
markdown*; the extension can't reproduce that from the live DOM. Decision:

- Introduce a **client-comparable fingerprint** — `sha256(normalizedVisibleText)`
  computed **identically** in (a) the extension content script and (b) the
  crawler, stored on the page doc (reuse `contentHash` only if the crawler
  adopts the same normalization; otherwise add `clientContentHash`).
- `page-status?...&hash=<fp>` lets the server answer `fresh | stale` directly.
- v1 fallback if parity slips: server-authoritative staleness by
  `lastCrawledAt` age; the background pipeline owns re-crawl. (`hash` becomes
  advisory.)

## 4. Blacklist (critical — any signed-in user can contribute)

Two layers + robots:

1. **Client quick denylist** (content script, cheap, fail-safe): skip
   non-`http(s)` (`chrome://`, `file://`, extension pages), `localhost` /
   private-IP / non-standard ports, and obviously-sensitive surfaces (auth/login
   pages, banking, webmail, healthcare portals — heuristic seed list). Never
   even send `page-status` for these.
2. **Server authoritative denylist** (the real guard): a `WWW_RAG` exclusion
   config (collection or env-backed) the `submit-url` endpoint enforces —
   domain/pattern denylist + per-user rate limit + dedup. This is mandatory
   because contribute is open to any authenticated user.
3. **robots.txt** — the crawler already parses/respects it
   (`workspace/resources/tools/src/rag/crawl/util/robots-txt.ts`); WWW RAG
   crawls must keep `respectRobotsTxt: true`.

## 5. Server gaps (what must be BUILT — from a monorepo audit)

| Need | Status | Note |
|---|---|---|
| `WWW_RAG` project (system-owned whitelabel + RAG vector) | ❌ build | one global project; pick embedding model (gemini-001 for batch scale) |
| `GET /api/v1/www-rag/page-status?url=&hash=` | ❌ build | Bearer, **any authed user**; resolves target=WWW_RAG server-side; returns indexed/crawled/version/contentHash/fresh-stale |
| `POST /api/v1/www-rag/page-context {url, query}` | ❌ build | URL-scoped retrieval (today `/api/v1/rag/context` has **no URL filter**; `chunk-search` needs a `fileId`) |
| `POST /api/v1/www-rag/submit-url {url}` | ❌ build | guarded by §4 denylist + rate limit + dedup; enqueues into chunks-workflow |
| Shared-read auth posture (not owner-gated) | ❌ build | `chat-oauth` is **owner-gated**; WWW RAG read must allow any authed user |
| Global crawl denylist | ❌ build | none today (only per-crawl `excludePaths` + robots) |
| Around-the-clock pipeline | ❌ build | chunks-workflow does crawl→chunk→embed, but there is **no cron scheduler**; add a scheduled worker polling WWW RAG for stale/new URLs |
| HTML-page model (contentHash/version) | ✅ exists | reuse; possibly add `clientContentHash` |
| `GET /api/v1/html-pages/by-url` | ✅ exists | per-`req.target`; not WWW-RAG-scoped → new endpoints wrap it |
| OAuth Bearer on `/api/v1/*` | ✅ exists | reuse the verify middleware |
| chunks-workflow crawl→chunk→embed | ✅ exists | reuse for both populators |

## 6. Phased plan

- **P0 — popup tidy-up (this change):** header = sign up / sign in / sign out
  only; consolidate Inference defaults + account-mode chat config + Tool-API
  manual keys under one **Advanced settings**; **remove the manual Indexing
  keys** (replaced by the account-authorized model). Page-pill is dormant until
  P2. *No server dependency.*
- **P1 — server WWW RAG foundation:** create the `WWW_RAG` project + vector;
  `page-status` + `page-context` read endpoints (shared-read auth); the global
  denylist config. 
- **P2 — extension wiring:** re-point the page-check at the OAuth `www-rag`
  endpoints (drop `divinci-api.ts`'s `X-API-Key`); compute `clientContentHash`;
  render real pill states; use `page-context` to ground the sidebar chat.
- **P3 — contribute path:** `submit-url` + denylist enforcement + rate limit.
- **P4 — background pipeline:** scheduled worker that refreshes stale WWW RAG
  pages around the clock.

## 7. Decisions (LOCKED 2026-06-19)

1. **Storage** = ✅ **one shared system-owned project** (`WWW_RAG`). Reuses the
   existing per-whitelabel RAG/crawl/by-url/chunk machinery.
2. **Read auth** = ✅ **any signed-in Divinci user** (rate-limited). Read
   endpoints resolve `target=WWW_RAG` server-side and are NOT owner-gated.
3. **Freshness** = ✅ **content-hash parity** — `sha256(normalizedVisibleText)`
   computed identically in crawler + extension, stored on the page doc;
   `page-status?...&hash=` answers fresh/stale directly. (Keep `lastCrawledAt`
   as a secondary signal so the background pipeline can refresh.)
4. **Contribute** = ✅ **auto-submit**, with the privacy guardrails in §8.

## 8. Contribute privacy/compliance posture (auto-submit)

Auto-submitting *visited URLs* is browsing-activity collection — sensitive even
though crawled CONTENT is public. **Get counsel to sign off before CWS publish.**
Engineering guardrails to keep auto-submit defensible:

- **Disclose** in the privacy policy + CWS Data Safety ("collects web browsing
  activity to maintain a shared public-web index") and ship a clear **opt-out**
  toggle. (CWS Limited-Use likely requires both; EU may push toward opt-in.)
- **Sanitize before send**: submit origin+pathname only — **strip query string
  + fragment** (they carry tokens/PII), drop capability/by-obscurity URLs
  (share links, magic links, pre-signed URLs), never send non-`http(s)`,
  localhost, or private-IP/non-standard-port hosts.
- **Scope to engaged pages** (sidebar opened / user asks about the page) rather
  than every background tab — clearly user-facing, far easier under CWS
  Limited Use, still feeds the corpus from real usage.
- Server **denylist + per-user rate limit + dedup** (§4) remain mandatory.

## 9. Blacklist seed (client quick-skip — confirm)

Hard-skip categories before any `page-status`/`submit-url`: non-`http(s)` &
extension/internal pages; `localhost`/private-IP/non-standard ports; auth/login
& account pages; banking/financial; healthcare/patient portals; webmail; URLs
with query strings or fragments (until sanitization lands). The authoritative
denylist lives server-side (§4).
