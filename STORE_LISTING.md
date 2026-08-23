# Chrome Web Store listing draft — Divinci Local Inference

Copy/paste-ready text for the CWS submission form. Update the placeholder
URLs (`<your privacy policy URL>`, screenshots) before submitting.

---

## Item details

**Name** (max 75 chars)
> Divinci Local Inference

**Summary** (max 132 chars)
> Run Gemma 4 in your browser via WebGPU, locally and without API costs. For use with chat.divinci.app.

**Category**
> Productivity

**Language**
> English

**Visibility** (recommended for first launch)
> **Unlisted** — install via direct URL only; not searchable in the store. Switch to Public after the alpha shakes out.

---

## Description (max 16,000 chars)

```
Divinci Local Inference brings Google's Gemma 4 E2B model to your browser, running fully on-device via WebGPU. Use it as an on-page AI assistant on any site, and as the local-LLM option in Divinci AI's chat at chat.divinci.app.

WHAT IT DOES
The extension hosts the Gemma 4 model in an offscreen document so it loads ONCE per browser profile and stays available across every tab. Open the side panel on any page to chat with the local model — fully on your device. When you pick "Gemma 4 E2B (Local, Free)" in chat.divinci.app's model picker, this extension also serves that inference locally. Optionally sign in to your Divinci account for page-aware answers (grounded in Divinci's public-web knowledge index) and account-mode chat — see PRIVACY for exactly what those send.

WHY USE IT
• No API costs for chat (the model runs on your GPU)
• Model loads once, instant response in every tab thereafter
• Faster and more reliable than running the same model in a regular web page (sidesteps known WebGPU buffer-mapping bugs in Web Worker contexts)
• Runs cross-origin-isolated for SharedArrayBuffer-accelerated inference

WHAT IT DOES NOT DO
• Does NOT show ads, or use your data for advertising or cross-site tracking
• Does NOT sell or rent your data
• Does NOT send the CONTENT of pages you visit (only a trimmed address + a one-way hash, and only while signed in with the side panel open)
• Does NOT send anything about your browsing when signed out, or with the side panel closed
• Does NOT collect third-party analytics/telemetry
• Does NOT auto-update model versions — pinned to a specific Hugging Face revision

PERMISSIONS
• offscreen — host the WebGPU model; service workers can't use WebGPU directly in MV3
• storage — store settings + the cached-model preference locally
• identity — complete an optional OAuth sign-in to your Divinci account
• host permissions (api.divinci.app + staging/dev, and the Auth0 sign-in origin) — make authenticated requests for the optional signed-in features
• content script (all sites) — draw the side-panel assistant and, only while it's open AND you're signed in, check whether the current page is in Divinci's public-web index (reads page text locally to compute a hash; does not transmit page content)
• externally_connectable — restricted to Divinci AI origins; lets chat.divinci.app use the local model via a runtime port

REQUIREMENTS
• Chrome 113+ (or Chromium-based browser with offscreen + WebGPU support)
• A GPU with shader-f16 support
• ~3 GB free disk space for the model cache
• ~5 GB free RAM at runtime
• A one-time ~3 GB model download from Hugging Face on first use

OPEN SOURCE
Apache-2.0 licensed. Source: https://github.com/Divinci-AI/gemma-gem (branch: divinci-bridge)
Forked from kessler/gemma-gem with attribution preserved in LICENSE.

PRIVACY
By default the extension is local-only — your chats with the on-device model never leave your computer. Optional signed-in features send specific data to Divinci: your basic profile at sign-in; while the side panel is open, a trimmed page address + a one-way hash of pages you view (to look up Divinci's public-web index); and, for page-aware answers or account-mode chat, your chat message. Sensitive sites (banking, webmail, healthcare, sign-in pages) are skipped, and you can turn these features off in Advanced settings → Privacy. We never sell your data, show ads, or track you across the web. Full privacy policy: https://divinci.ai/local-inference-privacy/
```

---

## Single Purpose Description (required by CWS)

```
This extension provides a single, locally-hosted Gemma 4 E2B (WebGPU) AI assistant: an on-page side panel the user can open on any site to chat with the model on-device, the same model served to chat.divinci.app via a runtime port, and — when the user signs in — page-aware answers and account-mode chat through their Divinci account. Every feature is in service of that one purpose: giving the user a privacy-friendly local AI assistant (optionally connected to their Divinci account), without per-token API costs for the local model.
```

---

## Permission Justifications

For the CWS privacy review form. Be specific — vague justifications get rejected.

### `offscreen`
```
WebGPU is required for the model to run at usable speed. In Manifest V3, service workers cannot access WebGPU. The chrome.offscreen API is the official supported pattern for hosting WebGPU compute outside of a content script. We create a single offscreen document at extension startup that holds the model in memory and runs inference; without this permission the extension cannot fulfill its core purpose.
```

### `storage`
```
The extension uses chrome.storage to persist the user's last-selected model id and inference defaults (temperature, max tokens) so it can auto-load on subsequent extension wake-ups. Model file bytes (the ~3 GB Gemma weights) are cached separately by the browser's Cache API via the @huggingface/transformers library — chrome.storage is only used for small key/value preferences (a few hundred bytes).
```

### `externally_connectable`
```
The extension lets chat.divinci.app pages use the local model over a chrome.runtime port. The manifest restricts externally_connectable to exactly one origin, https://chat.divinci.app — our own web application. The extension also re-validates the origin at port-acceptance time as defense in depth. No other site can talk to the extension this way.
```

### `identity`
```
Used only when the user explicitly clicks "Sign in / Sign up". The extension calls chrome.identity.launchWebAuthFlow to complete a standard OAuth (Auth0) authorization-code + PKCE sign-in to the user's own Divinci account. This enables the optional signed-in features (page-index lookup and account-mode chat). The resulting access token is stored on-device in the background service worker and never exposed to web pages or other contexts. The user can sign out at any time, which deletes the stored tokens.
```

### host permissions (`api.divinci.app`, `divinci-prod.us.auth0.com`)
```
Required for the optional signed-in features. divinci-prod.us.auth0.com is our identity provider and is contacted only during sign-in (the OAuth token exchange). api.divinci.app receives the authenticated requests: looking up whether the current page is in Divinci's shared public-web index, retrieving page-scoped context for grounding, and (if the user enables it) account-mode chat. These two hosts are the only ones the extension is granted, and no other hosts are contacted for these features.
```

### content script (`<all_urls>`)
```
The extension provides an in-page side-panel assistant the user can open on any page. It is opened from the extension's toolbar icon ("Open on this page"); the panel itself is rendered in an isolated Shadow DOM. An optional draggable in-page handle is available as a shortcut and is OFF by default, so nothing is drawn over a page unless the user asks for it. The content script also powers the page-index feature: ONLY while the panel is open AND the user is signed in, it reads the current page's title, address, and visible text LOCALLY to (a) compute a one-way content hash and (b) send the trimmed address + that hash to Divinci to check index freshness. The page's content is not transmitted. Sensitive sites (auth/account, banking, webmail, healthcare, local/private hosts) are skipped client-side. All sites are required because the assistant is meant to be available on any page the user chooses to open it on.
```

---

## Data Safety form (Chrome Web Store)

This extension DOES collect/transfer user data for the optional signed-in
features. Answer the CWS "Data safety" form as follows (and keep it in sync
with PRIVACY.md, which is the canonical disclosure):

### "Does this item collect or use any of the following user data?"
- **Personally identifiable information: YES** — name, email, and avatar URL,
  received from the user's Divinci account only after they sign in.
- **Authentication information: YES** — an OAuth access/refresh token, stored
  on-device (service worker) to make authenticated requests. Not sold/shared.
- **Personal communications: YES** — chat messages are transferred to Divinci
  ONLY for (a) page-aware answers (the message is sent to retrieve context) and
  (b) account-mode chat (the conversation is sent + stored on the user's
  account). Local-model chat with both features off is NOT transferred.
- **Web history / Web browsing activity: YES** — while signed in AND the side
  panel is open, the trimmed address (origin + path; query/fragment stripped)
  of the viewed page + a one-way hash of its visible text are sent to look up
  Divinci's public-web index. Page content is not sent; sensitive sites are
  skipped; nothing is sent when signed out or with the panel closed.
- **Website content: YES (limited)** — a one-way hash of the page's visible
  text (a fingerprint, not the content) is sent for index-freshness checks.
- Health information: **No** (healthcare sites are skipped, not indexed).
- Financial and payment information: **No** (financial sites are skipped).
- Location: **No.**

For each "Yes" type, in the form: mark **collected** and **transferred
off-device**, purpose **App functionality** (account features / the assistant's
core page-aware + chat features), and **not** sold to third parties.

### Limited Use / certifications
- "I do not use or transfer user data for purposes unrelated to my item's
  single purpose" — **Confirmed.** (All collection serves the assistant +
  account features.)
- "I do not use or transfer user data to determine creditworthiness or for
  lending purposes" — **Confirmed.**
- "I do not sell or transfer user data to third parties, apart from the
  approved use cases" — **Confirmed.**

> ⚠️ The data declared here exceeds the pre-1.0 builds (which collected
> nothing). Have counsel review PRIVACY.md §3/§4 + these answers before
> submitting, and re-review before enabling any future auto-submit/contribute
> feature (which would add an additional browsing-data transfer).

---

## Privacy Policy URL

You need to host the privacy policy at a public URL before you can submit, then paste that URL into the CWS "Privacy policy URL" field.

**The canonical policy text is `PRIVACY.md` in the repo root.** It is hosted at
**https://divinci.ai/local-inference-privacy/** (live; also summarised as §2.8 of
https://divinci.ai/privacy-policy, which links to it). Paste that URL into the CWS
"Privacy policy URL" field. Do NOT maintain a second copy here; keep `PRIVACY.md`, this listing, and the Data Safety form above in sync. (The previous inline draft here was the pre-1.0 "collects nothing" text and is intentionally removed — it no longer matches what the extension does.)

---

## Screenshots needed for the listing (1280×800 or 640×400, PNG)

1. **Hero shot** — chat.divinci.app's chat panel mid-stream from the local model, with the picker visible showing "Gemma 4 E2B (Local, Free)". The user message + assistant streaming response in view.
2. **Model selector open** — picker dropdown with "Gemma 4 E2B (Local, Free)" highlighted.
3. **The brave://extensions card** — showing the extension installed with its description.
4. **(Optional)** Model load progress modal at ~50% — proves the offline-first capability.

5 screenshots is the CWS max; 1-3 is the minimum. Generate from a fresh smoke run, save to PNG.

---

## Production Auth0 application (referenced from shared/divinci-account.ts)

The published extension signs users into the **production** tenant
`divinci-prod.us.auth0.com`, with audience `chat.divinci.app:8080`. An Auth0
application is per-tenant, so the staging client id is unknown there and
/authorize would answer `unauthorized_client`.

**This is a chicken-and-egg and the order matters.** The Auth0 callback URL is
`https://<extension-id>.chromiumapp.org/`, and for a Chrome Web Store listing the
extension id is assigned **by the store**, at draft creation — it is NOT the
`laeebjagghfeepomjhbfohefghonemeo` derived from our pinned manifest key. (The
store also REJECTS a new item whose manifest carries a `key` at all:
`key field is not allowed in manifest.` The build now omits it outside
development.)

1. `DIVINCI_BOOTSTRAP_DRAFT=1 pnpm zip` — builds one package whose sign-in
   cannot work, and says so loudly. Without the variable the build refuses,
   because a store package whose sign-in silently 400s is indistinguishable from
   a working one until a real user clicks the button.
2. Upload it as a **draft** (Add new item). Do **not** submit. Read the **Item
   ID** from the dashboard.
3. Auth0 → `divinci-prod` tenant → Applications → Create → **Single Page
   Application** (PKCE, no client secret).
   - **Allowed Callback URLs**: `https://<item-id>.chromiumapp.org/`
   - **Allowed Web Origins**: `chrome-extension://<item-id>`
   - Both fields are comma-separated; keep any dev entry alongside during the
     transition rather than swapping it out.
4. Paste the Client ID into `PRODUCTION.authClientId` in
   `shared/divinci-account.ts`, replacing `__SET_PROD_AUTH0_CLIENT_ID__`.
5. Add the item id to `PRODUCTION_EXTENSION_ID`'s candidate list in the server
   repo's `workspace/clients/web/src/services/local-llm/extension-capabilities.ts`,
   or chat.divinci.app will not detect the published extension.
6. `pnpm zip` (no bootstrap variable) and upload that package for review.

---

## Verified publisher (the "Official URL" under the item title)

Independent of trader verification: no fee, no DUNS. The listing's *Official URL*
dropdown offers only sites verified as yours in **Google Search Console**.

`divinci.ai` **already carries two `google-site-verification` TXT records**
(checked 2026-08-20 via `dig +short TXT divinci.ai`), so the domain is verified
by at least one Google account already. If the account that owns the CWS
publisher is one of them, this step is just picking `https://divinci.ai` from
the dropdown — no DNS change.

If it is NOT one of them, add a third TXT record from that account's Search
Console flow; the existing two are unaffected (verification records accumulate,
one per verifying account).

---

## Pre-submission checklist

- [x] Privacy policy URL live: https://divinci.ai/local-inference-privacy/
- [x] Store icon 128×128 shipped (`public/icon/128.png`)
- [x] Production build targets production hosts only (guarded by
      `shared/environment-lockstep.test.ts` + the `build:done` hook)
- [x] `key` omitted from non-development builds
- [ ] CWS developer account + one-time registration fee
- [ ] Group publisher created (⚠️ **one per Google account, for the account's
      lifetime** — deleting it does not restore the quota; name it correctly
      first time)
- [ ] **Trader** declared, verified as an **organization** (D-U-N-S 149913201)
      with an SMS-capable phone. Legal name, address, email, phone and DUNS are
      **published on the listing**.
- [ ] Bootstrap draft uploaded, Item ID captured
- [ ] Production Auth0 SPA application created; `PRODUCTION.authClientId` set
- [ ] Item ID added to the web app's extension-id candidates
- [ ] 1–5 screenshots at exactly **1280×800**
- [ ] Small promo tile **440×280** (required). Marquee 1400×560 optional.
- [ ] Bump `package.json` `version` if anything changed since the last build
- [ ] Final `pnpm zip` re-run after any change
- [ ] Decide visibility: **Unlisted** for the alpha

⚠️ Review latency: developer.chrome.com currently warns of a submission surge
and extended review times, and reviews run slower for new developers, new
extensions, and broad host permissions. Budget weeks, not days.
