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
Divinci Local Inference brings Google's Gemma 4 E2B model to your browser, running fully on-device via WebGPU. Built specifically to power the local-LLM option in Divinci AI's chat at chat.divinci.app.

WHAT IT DOES
The extension hosts the Gemma 4 model in an offscreen document so it loads ONCE per browser profile and stays available across every tab. When you pick "Gemma 4 E2B (Local, Free)" in chat.divinci.app's model picker, this extension serves the inference — your messages never leave your device for the model call.

WHY USE IT
• No API costs for chat (the model runs on your GPU)
• Model loads once, instant response in every tab thereafter
• Faster and more reliable than running the same model in a regular web page (sidesteps known WebGPU buffer-mapping bugs in Web Worker contexts)
• Runs cross-origin-isolated for SharedArrayBuffer-accelerated inference

WHAT IT DOES NOT DO
• Does NOT inject UI into any web page (no content scripts)
• Does NOT modify, read, or watch your browsing
• Does NOT make any authenticated calls — only fetches the model files from huggingface.co
• Does NOT collect telemetry or analytics
• Does NOT auto-update model versions — pinned to a specific Hugging Face revision

PERMISSIONS
• offscreen — required to host WebGPU; service workers can't use WebGPU directly in MV3
• storage — used by transformers.js to cache model downloads via the Cache API
• externally_connectable — restricted to chat.divinci.app and its staging/dev origins; the extension only accepts messages from these specific origins

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
We don't collect any data. The extension communicates only with:
• Hugging Face (huggingface.co + cas-bridge.xethub.hf.co) — for model downloads
• chat.divinci.app (and staging/dev variants) — for the inference port
No analytics, no tracking, no remote logs. Full privacy policy: <your privacy policy URL>
```

---

## Single Purpose Description (required by CWS)

```
This extension serves Gemma 4 E2B inference to chat.divinci.app via a chrome.runtime port. It exists for one purpose: route LLM inference requests from chat.divinci.app to a locally-hosted, WebGPU-accelerated Gemma 4 model in an offscreen document, so chat.divinci.app users can have a privacy-friendly local model option without API costs.
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
The extension uses chrome.storage to persist the user's last-selected model id (gemma-4-e2b vs e4b) so it can auto-load on subsequent extension wake-ups. Model file bytes (the ~3 GB Gemma weights) are cached separately by the browser's Cache API via the @huggingface/transformers library — chrome.storage is only used for small key/value preferences (a few hundred bytes).
```

### `externally_connectable` (host permissions in manifest)
```
The extension's purpose is to receive inference requests from chat.divinci.app pages over a chrome.runtime port. The manifest restricts externally_connectable to a small allowlist of Divinci AI origins (chat.divinci.app, chat.stage.divinci.app, chat.dev.divinci.app, http://localhost:8080). The extension also re-validates the origin at port-acceptance time. No other site can talk to the extension.
```

---

## Privacy Disclosures (required for any extension that handles user data)

### "Does this item collect or use any of the following user data?"
- Personally identifiable information: **No**
- Health information: **No**
- Financial and payment information: **No**
- Authentication information: **No**
- Personal communications: **No** (the extension does not store, transmit, or collect chat messages — they pass through the runtime port to the offscreen document for inference and are discarded after the response)
- Location: **No**
- Web history: **No**
- User activity: **No**
- Website content: **No**

### "I do not use or transfer user data for purposes unrelated to my item's single purpose"
**Confirmed.**

### "I do not use or transfer user data to determine creditworthiness or for lending purposes"
**Confirmed.**

### "I do not sell or transfer user data to third parties, apart from the approved use cases"
**Confirmed.**

---

## Privacy Policy URL

You need to host the privacy policy at a public URL before you can submit. Suggested location: `https://divinci.app/legal/divinci-local-inference-privacy` or as a section on the existing privacy policy at `https://divinci.app/privacy`. Draft text below — paste it into a new doc/page.

```
Divinci Local Inference — Privacy Policy

The Divinci Local Inference Chrome extension does not collect, store, transmit, or sell any personal data. There is no analytics, telemetry, or remote logging.

WHAT THE EXTENSION DOES
The extension downloads Google's Gemma 4 model from Hugging Face on first use, caches it in your browser, and runs the model on your device's GPU when chat.divinci.app sends an inference request through a chrome.runtime port.

NETWORK ACCESS
The extension makes network requests to two destinations:
• huggingface.co (and its CDN cas-bridge.xethub.hf.co) — to download the model files. Subject to Hugging Face's privacy policy at https://huggingface.co/privacy.
• Pages on chat.divinci.app (and our staging/dev origins) connect to the extension via chrome.runtime ports — no outbound network traffic, just same-machine message passing.

DATA YOU SEND TO THE EXTENSION
When chat.divinci.app sends a chat message to the extension for inference, the message text is passed to the local model and the generated response is streamed back. The extension does not log, store, transmit, or persist these messages anywhere outside the model's transient compute. After the response is returned, the message and response exist only in the requesting page (chat.divinci.app), which has its own privacy policy.

PERMISSIONS
• offscreen — required to run the WebGPU model
• storage — caches the model selection preference (a small key/value)
• externally_connectable — limited to Divinci AI domains; no other website can connect

CHANGES TO THIS POLICY
If we change how the extension handles data, we will update this policy and bump the extension version. The version is shown on the extension's chrome://extensions card.

CONTACT
Questions? Email <your contact email>.

Last updated: <date>
```

---

## Screenshots needed for the listing (1280×800 or 640×400, PNG)

1. **Hero shot** — chat.divinci.app's chat panel mid-stream from the local model, with the picker visible showing "Gemma 4 E2B (Local, Free)". The user message + assistant streaming response in view.
2. **Model selector open** — picker dropdown with "Gemma 4 E2B (Local, Free)" highlighted.
3. **The brave://extensions card** — showing the extension installed with its description.
4. **(Optional)** Model load progress modal at ~50% — proves the offline-first capability.

5 screenshots is the CWS max; 1-3 is the minimum. Generate from a fresh smoke run, save to PNG.

---

## Pre-submission checklist

- [ ] Production zip exists: `.output/divinci-local-inference-0.1.0-chrome.zip` ✅ (already built)
- [ ] CWS developer account exists (created by you, $5 one-time fee)
- [ ] Privacy policy URL is live and reachable
- [ ] At least one 1280×800 screenshot saved
- [ ] Promotional 128×128 icon ready (we already ship one in icon/128.png)
- [ ] Decide visibility: **Unlisted** for the alpha
- [ ] Bump `package.json` `version` if anything changed since last build
- [ ] Re-run `pnpm build:prod && pnpm zip` after any change
