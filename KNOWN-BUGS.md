# Known bugs

Found 2026-08-20 while capturing Chrome Web Store listing assets. None is fixed
here; each is recorded so it is not rediscovered from scratch.

## 1. Selecting a non-default model does not reach inference

Selecting **Qwen2.5 0.5B** in the panel picker updates the chip, the empty-state
title and the composer placeholder, and the weights download and load to
completion. Sending a message then fails with:

```
Error: Model gemma-4-e2b not loaded — call divinci:load first
```

So the picker's selection reaches the UI and the loader but NOT the send path,
which still asks for the default `gemma-4-e2b`. Reproduced from a clean profile
with `MODEL="Qwen2.5 0.5B" node scripts/capture-hero-screenshot.mjs`.

Affects 5 of the 6 shipped models. Blocks capturing a listing screenshot with
anything but Gemma.

## 2. A failed model download shows a frozen progress bar, never an error

`transformers.js` buffers a whole shard in memory before writing it to the Cache
API, so a ~1.4 GB shard is a ~1.4 GB renderer allocation. Under memory pressure
the renderer is killed mid-fetch and the panel simply STOPS at its last
percentage — no error, no retry, no timeout. From the UI it is indistinguishable
from a slow download; the only way to tell is that the process holds no sockets
and no buffer.

Same shape as the `[ai-reply-failed]` / `[audio-transcript-failed]` classes in
the server repo: the failure path renders as success.

## 3. A crash leaves a stale load-mirror that blocks a different model

After the killed download above, the next run selecting a DIFFERENT model showed
`⚠ Already loading gemma-4-e2b; wait for it to finish first` and kept the crashed
model's branding in the header. The `LoadingMirror` written to `chrome.storage`
survives the crash with nothing to expire or clear it. Wiping the profile clears
it.

## 4. The disclaimer line is hardcoded to "Gemma"

`ui/chat-panel.ts renderDisclaimer()` writes `Gemma runs locally on your device.`
and `Page reading is off — Gemma only sees the page title & URL.` regardless of
the selected model, so a Qwen session reads "Gemma runs locally on your device."
The empty-state title and composer placeholder ARE model-aware; only the
disclaimer is not.
