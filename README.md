# Divinci Local Inference

Chrome extension that hosts Google's Gemma 4 in an offscreen document so [chat.divinci.app](https://chat.divinci.app) can run inference locally on your GPU instead of paying per-token API costs. Forked from [kessler/gemma-gem](https://github.com/kessler/gemma-gem) (Apache-2.0); the original full-page agent loop has been stripped — this fork is purely a transport layer for chat.divinci.app's local-LLM picker option.

## What it is

- **One offscreen document** holds the model in WebGPU memory. Loads ~3 GB once per browser profile, stays resident across tabs and across service-worker evictions.
- **External port bridge** (`chrome.runtime.connect`) accepts inference requests from a small allowlist of Divinci origins (`chat.divinci.app`, staging, dev). All other sites are rejected by the manifest's `externally_connectable` and re-checked at runtime.
- **Toolbar popup** — clicking the extension icon opens a small management UI: shows the loaded model, disk used, queue depth, live download progress, and Load/Unload buttons for E2B / E4B.

## What it isn't

- Not a content script. We don't inject UI into pages, don't read DOM, don't watch your browsing.
- Not authenticated. The extension only fetches model files from Hugging Face. It cannot make calls to any Divinci API.
- Not telemetry. No analytics, no remote logs.

## Install (developer / internal alpha)

```bash
pnpm install
pnpm build:prod
pnpm zip
# → .output/divinci-local-inference-0.1.0-chrome.zip
```

Unzip somewhere stable, then in Brave / Chrome / Edge:

1. `chrome://extensions` → Developer Mode ON
2. **Load unpacked** → pick the unzipped folder
3. Confirm the assigned extension ID is `laeebjagghfeepomjhbfohefghonemeo` (it will be — `manifest.key` is pinned for stable identity across team installs)

Then visit [chat.stage.divinci.app](https://chat.stage.divinci.app), open the agent panel, and pick **"Gemma 4 E2B (Local, Free)"** from the model selector. The extension probe will find the bridge automatically.

## The popup

Click the toolbar icon. You'll see:

- **Loaded model** — current state (idle, loading X, or `Gemma 4 E2B`)
- **Queue depth** — chats waiting to run (0 in solo use)
- **Disk used** — total bytes the extension is holding via the browser's Cache API
- **Download progress bar** — file + percent + bytes, only visible while a load is in flight
- **Per-model "Load" buttons** — the loading card has a spinner; the loaded card shows "Loaded"
- **"Unload model from GPU"** — drops the model from VRAM (Cache API entries survive for the next load)
- **Error toast** — surfaces any load failure with a dismiss button; clears on next successful load

Selecting a model via the popup persists in `chrome.storage.local`; on subsequent service-worker startups (browser restart, extension reload, idle eviction) the background auto-warms the remembered model so the first chat is instant.

## Architecture

```
            chrome.runtime.connect (port)
chat.divinci.app  ────────────────────────►  Background SW (external-bridge.ts)
                                                     │
                                                     │  internal:* (sendMessage)
                                                     ▼
                                              Offscreen document
                                              (chat-host.ts)
                                                     │
                                                     ▼
                                              transformers.js + WebGPU
                                              (single ChatHost, serial queue)

Toolbar icon click ─────►  popup/index.html  ─────►  internal:status / internal:load / internal:unload
```

| Layer | File |
|---|---|
| Background SW (port routing + auto-warm) | `entrypoints/background.ts` |
| External port bridge (origin allowlist) | `background/external-bridge.ts` |
| Offscreen launcher | `background/offscreen-manager.ts` |
| Offscreen entrypoint (request router) | `entrypoints/offscreen/main.ts` |
| ChatHost (transformers.js + queue) | `offscreen/chat-host.ts` |
| Popup UI | `entrypoints/popup/index.html` + `popup/main.ts` + `popup/popup.css` |
| Wire protocol (external + internal) | `shared/messages.ts` |
| Model registry (pinned HF revisions) | `shared/models.ts` |

## Hardware requirements

| | Gemma 4 E2B | Gemma 4 E4B |
|---|---|---|
| **One-time download** | ~2.9 GB (q4f16) | ~4.6 GB (q4f16) |
| **GPU memory** | ~4 GB | ~6 GB |
| **System RAM** | 8 GB+ | 12 GB+ |
| **Browser** | Chrome / Edge / Brave 113+ with WebGPU | Same |
| **GPU feature** | `shader-f16` required | Same |

E4B is defined in `shared/models.ts` and selectable from the popup, but is hidden from chat.divinci.app's picker until the web-app capability probe gains a stronger gate.

## Development

```bash
pnpm dev           # WXT dev mode — hot reloads on file change. Manifest also includes localhost:8080.
pnpm build         # Development build (logging on, source maps)
pnpm build:prod    # Production build (logging silenced, optimized)
pnpm zip           # Pack .output/chrome-mv3 into a distributable .zip
pnpm test          # Run the ChatHost unit tests
pnpm compile       # tsc --noEmit (no emit, type-check only)
```

The production manifest only allows `chat.{,stage.,dev.}divinci.app` origins. Localhost is dev-mode-only — see `wxt.config.ts` for the security rationale (any random :8080 service would otherwise be able to consume the user's GPU).

## Tests

`offscreen/chat-host.test.ts` — 12 unit tests covering the queue + abort + error invariants. transformers.js + chrome.runtime are mocked at the module boundary so tests run in plain node (no WebGPU, no WASM).

```bash
pnpm test                # one-shot
pnpm test:watch          # interactive
```

## Pinned dependencies (deliberate)

- `@huggingface/transformers` is pinned to **`4.2.0` exactly** (no caret) so future minor/patch releases don't silently roll into the bundle. Bumping requires a deliberate edit + re-test.
- `MODELS[id].revision` in `shared/models.ts` pins the **exact Hugging Face commit SHA** for each model so we get the bytes we tested against, never whatever HEAD happens to be at fetch time. To upgrade, fetch the new SHA from `https://huggingface.co/api/models/<hfRepo>` and bump the spec's `version` field to bust user-side caches.
- `manifest.key` (in `wxt.config.ts`) pins the **deterministic extension ID** `laeebjagghfeepomjhbfohefghonemeo`. Every machine that loads the unpacked / signs the .crx with the matching private key gets that same ID. The web-app probe hardcodes this value.

## Chrome Web Store

A submission-ready listing draft lives in `STORE_LISTING.md`: copy/paste-ready text for every CWS form field, plus permission justifications for the privacy review. The actual submission requires a CWS developer account + the $5 fee + a public privacy-policy URL — not automated.
