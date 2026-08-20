# Divinci Local Inference — Privacy Policy

_Last updated: 2026-06-20_

Divinci Local Inference runs an open-weight AI model (Google's Gemma 4)
locally in your browser on your GPU, and — when you choose to sign in —
connects that local assistant to your Divinci account for optional
cloud-assisted features. This policy explains exactly what stays on your
device and what, in specific situations, is sent to Divinci.

**The short version:** By default the extension is local-only — your
chats with the on-device model never leave your computer. Some optional,
clearly-controlled features (signing in, page-aware answers, and
account-mode chat) do send data to Divinci. Those are described below.
We do not sell your data, show ads, or use it to track you across the web.

## 1. What stays on your device (default)

- **Your chats with the local Gemma model.** Prompts and responses are
  computed on your GPU and are not logged, stored, or transmitted by the
  extension. (Exceptions: the two optional features in §3 and §4.)
- **The model files**, cached in your browser after first download.
- **Your settings** (selected model, inference defaults, privacy
  toggles), stored locally via the browser's `storage` API.

When you are **not signed in**, the extension sends **no** browsing
information to Divinci.

## 2. Signing in to Divinci (optional)

If you click **Sign in / Sign up**, the extension uses Google Chrome's
`identity` API to complete a standard OAuth sign-in with Divinci's
identity provider (Auth0). On success we receive and store **on your
device** an access token and your basic profile (email, name, and avatar
URL) so the extension can show who you're signed in as and make
authenticated requests on your behalf. The access token never leaves the
extension's background service worker. You can sign out at any time from
the toolbar popup, which deletes the stored tokens.

## 3. Web browsing activity (only while signed in **and** the panel is open)

To tell you whether the page you're viewing is covered by Divinci's
shared public-web knowledge index ("WWW RAG") and to ground answers in
it, the extension — **only when you are signed in and have the Divinci
side panel open on a page** — sends the following to Divinci's API:

- **The page's address**, reduced to its origin and path only. The query
  string and fragment (the parts after `?` and `#`, which can contain
  search terms, tokens, or personal identifiers) are **stripped before
  sending**.
- **A one-way fingerprint (hash) of the page's visible text**, used to
  detect whether our index is up to date. **The page's actual content is
  not sent** — only this hash and the trimmed address.

This is "web browsing activity" under Chrome Web Store rules, so we
disclose it plainly. Important limits:

- It happens **only while the side panel is open** on a page. With the
  panel closed, the extension sends nothing about the pages you visit.
- **Sensitive sites are skipped entirely** — the extension does not send
  anything for sign-in/account pages, banking and financial sites,
  webmail, healthcare portals, local/private addresses, or non-standard
  ports.
- It is used to look up and freshen the public-web index, **not** to
  build a profile of you or to target advertising.

(The shared index itself is built by Divinci crawling **publicly
accessible** web pages on its own servers; this extension does not
upload page content to build it.)

## 4. Page-aware answers & account-mode chat (optional)

- **Page-aware answers (grounding).** When a page is in the index and you
  send a message in the side panel, the extension sends **your message
  and the trimmed page address** to Divinci to retrieve relevant context,
  which is then given to the local model. So in this case your chat
  message does leave your device. You can turn this off — see §5.
- **Account-mode chat.** If you enable *"Use my Divinci account"* for
  chat, your conversation is sent to Divinci's servers (to run
  server-hosted models / tools) and stored as a transcript on your
  account, the same as chatting on chat.divinci.app. Leaving this off
  keeps chat fully local.

## 5. Your privacy controls

In the popup under **Advanced settings → Privacy**:

- **Retrieve Divinci page context** — when off, the extension never
  sends your message for page-aware answers (your chat query stays on
  your device). Default: on.
- **Allow Divinci to use my account chats** — when off, the extension
  asks Divinci not to use your account-mode chats to improve its
  services. Default: on. _(This sends an opt-out signal with your
  requests; the actual handling is enforced by Divinci's servers.)_

You can also simply stay **signed out** (fully local) or **sign out** at
any time to stop all of §2–§4.

## 6. Where data goes

- **huggingface.co** (and CDN `cas-bridge.xethub.hf.co`) — to download
  the model files (Hugging Face's privacy policy applies:
  https://huggingface.co/privacy).
- **Divinci's identity provider** (`divinci-prod.us.auth0.com`) — only
  during sign-in.
- **Divinci's API** (`api.divinci.app`) — for the signed-in features in
  §3 and §4.

The published extension contacts the production hosts above and no
others. Internal development builds (never distributed through the
Chrome Web Store) target the staging equivalents instead.

## 7. What we do **not** do

- We do **not** sell or rent your data.
- We do **not** show ads or use your data for advertising or
  cross-site tracking.
- We do **not** send the **content** of the pages you visit (only the
  trimmed address and a one-way hash, per §3).
- We do **not** transmit anything about your browsing when you are
  signed out or when the side panel is closed.

## 8. Permissions

- **offscreen** — run the WebGPU model.
- **storage** — store settings + cached-model preference locally.
- **identity** — complete OAuth sign-in to your Divinci account (§2).
- **host permissions** (`api.divinci.app`, staging/dev, and the Auth0
  sign-in origin) — make the authenticated requests in §2–§4.
- **content script on all sites** — draw the side panel and, only while
  it's open and you're signed in, run the page-index check in §3. The
  script reads the page title, address, and visible text **locally** to
  compute the hash; it does not transmit page content.
- **externally_connectable** (Divinci AI domains only) — let
  chat.divinci.app use the local model via a `chrome.runtime` port.

## 9. Changes to this policy

If we change how the extension handles data, we will update this policy
and bump the extension version (shown on the `chrome://extensions` card).

## 10. Contact

Questions? Email mike@divinci.ai.

<!--
TODO before CWS submission:
  - LEGAL REVIEW: this policy now discloses browsing-activity + chat-data
    collection that did not exist in the pre-1.0 builds. Have counsel
    confirm the §3/§4 wording and the opt-out posture before publishing,
    and before any future auto-submit/contribute feature is enabled.
  - Host this text at a public, stable URL (e.g.
    https://divinci.ai/legal/local-inference-privacy or a section of the
    existing https://divinci.ai/privacy-policy) and paste that URL into
    the CWS "Privacy policy URL" field. A dead/placeholder URL fails review.
  - Mirror §1–§7 into the CWS "Data safety" form (see STORE_LISTING.md).
  - Confirm mike@divinci.ai vs a role address (privacy@ / support@).
-->
