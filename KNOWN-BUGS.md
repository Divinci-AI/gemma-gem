# Known bugs

Found 2026-08-20 while capturing Chrome Web Store listing assets. None is fixed
here; each is recorded so it is not rediscovered from scratch.

## 1. Selecting a non-default model does not reach inference — FIXED

Selecting **Qwen2.5 0.5B** in the panel picker updates the chip, the empty-state
title and the composer placeholder, and the weights download and load to
completion. Sending a message then fails with:

```
Error: Model gemma-4-e2b not loaded — call divinci:load first
```

So the picker's selection reaches the UI and the loader but NOT the send path,
which still asks for the default `gemma-4-e2b`. Reproduced from a clean profile
with `MODEL="Qwen2.5 0.5B" node scripts/capture-hero-screenshot.mjs`.

Affects 5 of the 6 shipped models.

**Cause:** `LocalInference` is constructed ONCE with `{ modelId, label,
isLoaded }`, where `isLoaded` was a getter but `modelId` and `label` were plain
values. The load path read the surface's live `MODEL_ID` and loaded the picked
model; this client kept the id captured at construction and asked the offscreen
host for the original.

**Fixed:** all three options are getters, read per request. Regression test in
`chat-core/local-inference.test.ts` ("sends the model selected at request time,
not at construction time"), mutation-tested.

## 2. A failed model download shows a frozen progress bar, never an error — FIXED

`transformers.js` buffers a whole shard in memory before writing it to the Cache
API, so a ~1.4 GB shard is a ~1.4 GB renderer allocation. Under memory pressure
the renderer is killed mid-fetch and the panel simply STOPS at its last
percentage — no error, no retry, no timeout. From the UI it is indistinguishable
from a slow download; the only way to tell is that the process holds no sockets
and no buffer.

Same shape as the `[ai-reply-failed]` / `[audio-transcript-failed]` classes in
the server repo: the failure path renders as success.

**Fixed:** `ui/load-watchdog.ts`. Progress events arrive per chunk, so silence
longer than 120s while loading means the producer is gone — the panel clears its
loading state and says so, naming memory as the likely cause and noting that
finished parts stay cached. It re-checks `isLoading` inside the callback, so a
load that completed between the timer firing and the callback running cannot
raise a false error.

Kept as its own module with injected timers because the panel is DOM-heavy and
would not otherwise be testable. 5 unit tests, mutation-tested (dropping the
re-check, and dropping the re-arm reset, each fail a distinct test).

⚠️ NOT covered: an end-to-end browser reproduction. Simulating a *silently*
killed renderer is not the same as going offline — offline produces a normal
fetch error, which the panel already handled. An attempt at that test passed
trivially for the wrong reason and was deleted rather than kept as false
assurance.

## 3. A crash leaves a stale load-mirror that blocks a different model

After the killed download above, the next run selecting a DIFFERENT model showed
`⚠ Already loading gemma-4-e2b; wait for it to finish first` and kept the crashed
model's branding in the header. The `LoadingMirror` written to `chrome.storage`
survives the crash with nothing to expire or clear it. Wiping the profile clears
it.

## 4. The disclaimer line is hardcoded to "Gemma" — FIXED

`ui/chat-panel.ts renderDisclaimer()` writes `Gemma runs locally on your device.`
and `Page reading is off — Gemma only sees the page title & URL.` regardless of
the selected model, so a Qwen session reads "Gemma runs locally on your device."
The empty-state title and composer placeholder ARE model-aware, and two of
`renderDisclaimer`'s four branches already used `MODELS[MODEL_ID].shortLabel` —
the other two were simply missed. All four now name the selected model.

## 5. `load-done` promised a model that could not answer — FIXED

Measured against the SHIPPED 0.14.8 store build on 2026-08-23, driven through
the `externally_connectable` port from `chat.divinci.app` so no UI was involved:

| model | `load-done` | first chat TTFT | second chat TTFT |
|---|---|---|---|
| Gemma 4 E2B (already resident) | 15 ms | **14,521 ms** | 846 ms |
| SmolLM2 360M (fresh download) | after download | **1,719 ms** | — |

The cost is GPU shader compilation on the first `generate()`, and it scales
with the model. `load-done` fired when the weights were resident, the panel
went green, the user typed "Hi", and nothing happened for fourteen seconds.

**Fixed:** `ChatHost._load()` runs a 1-token generation before resolving, and
reports a `prepare` phase (`fraction: null` — compilation has no byte count).
The panel renders "Preparing <model> — first run compiles GPU shaders…".

## 6. Stop did nothing before generation began — FIXED

`InterruptableStoppingCriteria` is only consulted BETWEEN generated tokens, so
an abort arriving during bug 5's window had nothing to interrupt. Worse, the
offscreen `state.aborted` flag only suppressed token EMISSION — its own comment
claimed a "runChat short-circuit" that did not exist — so an aborted chat still
generated to `max_new_tokens` with nobody listening, holding the single GPU
queue and every chat behind it.

**Fixed:** `ChatOptions.signal`, checked before the prompt is rendered.

## 7. The popup and the panel disagreed about whether a model was loaded — FIXED

Screenshot 2026-08-23: popup said `Active · CACHED`, panel beside it said "Load
the model to start chatting". Different fields of the same status — the popup
reads `loadedModelIds`/`activeModelId`, the panel read
`status.isLoaded && currentModelId === MODEL_ID`. `isLoaded` means "some model
is loaded"; `currentModelId` is the active TARGET, while `chat()` serves any
resident model.

**Fixed:** both read residency via `isResident()`, with a source assertion
against re-inlining.

⚠️ I destroyed the live evidence for this one. The first probe I sent was
`divinci:load`, which begins `if (loaded.has(id)) { activeModelId = id; return }`
— setting the very field worth reading first. Same class as stamping
`last_used` before checking it. **Read state before sending anything that
mutates it.**

## 8. The in-page dock never knew what was cached — FIXED

`entrypoints/inference/main.ts` reported `cacheBreakdown: emptyBreakdown()`
unconditionally. That reads as "nothing is cached", not "unknown", so the
panel's auto-load — gated on `cacheBreakdown[id].isCached` — NEVER fired on the
dock, and cache reads were announced as ~2.9 GB downloads. The iframe is
same-origin with the offscreen document and reads the same Cache API.

## 9. The injected iframe breaks other extensions on every page — OPEN

`entrypoints/content.ts` appends a `chrome-extension://` inference iframe at
content-script mount on EVERY page, whether or not the dock is ever opened.
Chrome then refuses cross-extension frame access, so other extensions cannot
script the page:

```
Cannot access a chrome-extension:// URL of different extension
```

Verified 2026-08-23: with 0.14.8 installed, Claude in Chrome could not evaluate
JavaScript on ANY http(s) page. The `exclude_matches` for divinci.ai/divinci.app
already exists for exactly this reason — the comment there says so — but it
only protects our own pages.

**Fix (not done):** attach lazily, on first `send`/`queryStatus` or first dock
open, instead of at mount. It also saves an extension page per tab.

NOT done because it invalidates `e2e/extension-web-accessible.spec.ts`, which
waits for the frame to appear on page load, and the machine was at 233 MB
unused with 16 GB of swap in use — the documented freeze condition — so the
browser test could not be re-run. Do it with a browser available.

## 10. The launcher handle was drawn on every page by default — FIXED

Through 0.14.8 a purple star handle was pinned to the right edge of every site
the user visited. Reported as intrusive on 2026-08-23, and it is: browser
extensions conventionally put their entry point on the TOOLBAR, not on your
pages.

It is now off by default (`shared/handle-visibility.ts`), with the popup's
"Open on this page" button as the way in.

⚠️ **That button had to be built as part of the same change.** Through 0.14.8
the handle was the ONLY way to open the in-page dock — no keyboard command
(`commands` is unset in the manifest) and no popup action. Defaulting the
handle off on its own would have made the dock unreachable. A test asserts the
button exists.

The storage key changed with the default. `divinci_sidebar_handle_hidden`
defaulting to "hidden" reads backwards at every call site (`hidden !== true`
meaning shown), which is how a polarity bug gets written later; the new
`divinci_sidebar_handle_shown` states what it controls. The legacy key is
honoured for exactly one case: a user who wrote `hidden === false` by
re-enabling the handle from the popup had actively asked for it, and is
migrated rather than overridden.

Note this does NOT fix bug 9 — the iframe is still injected on every page even
with nothing visible, which is now purely invisible cost.
