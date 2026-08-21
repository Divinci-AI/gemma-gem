# Which ONNX Runtime binary is actually fetched

Written 2026-08-21, from the built output at `4e70123`. Every claim here is
checkable against `.output/chrome-mv3` — re-derive rather than trust it.

## Two ORT runtimes ship, and they want different binaries

| importer | specifier | bundle | requests |
|---|---|---|---|
| transformers.js (→ `ChatHost`) | `onnxruntime-web/webgpu` | `ort.webgpu.bundle.min.mjs` | `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` |
| `offscreen/wake-host.ts` | `onnxruntime-web` | `ort.bundle.min.mjs` | `ort-wasm-simd-threaded.jsep.{mjs,wasm}` |

`copyOrtFiles()` in `wxt.config.ts` copies **asyncify only** into `public/ort/`.

## `wasmPaths` always wins — there is no fallback

Both consumers set it before any session is created:

- `offscreen/chat-host.ts`, module top level: `getURL('ort/')`
- `offscreen/wake-host.ts`, in `configureOrt()`: `"/ort/"`

A **string** `wasmPaths` is used by ORT as a prefix: it loads
`${wasmPaths}${defaultFileName}`. The `assets/…wasm` URLs Vite rewrites into
ORT's bundle are reached only through `!wasmPaths && …` branches (the
proxy-worker init), and transformers.js additionally forces
`env.wasm.proxy = false`. So:

> **`assets/ort-wasm-simd-threaded.{asyncify,jsep}-<hash>.wasm` — 49.67 MB
> uncompressed, ~63% of the unpacked package — is never fetched.**

They exist because ORT's ESM carries `new URL('…wasm', import.meta.url)` and
Vite emits an asset for that unconditionally. Removing them means suppressing
the *emission*, not deduplicating a copy. Five attempts at the adjacent
"dedupe" framing were reverted; this reframing has not been tried.

## Consequence: wake word cannot load

`ort.bundle.min.mjs` asks for `/ort/ort-wasm-simd-threaded.jsep.mjs`, which is
not in the package. `configureOrt()`'s comment — "The only wasm variant bundled
is the simd-threaded asyncify build" — is correct about the package and wrong
about what its own import will request.

It is opt-in (mic permission + `internal:wake-enable`), so nobody hit it.

The cheap fix is to import `onnxruntime-web/webgpu` in wake-host so both
runtimes share the asyncify binary already shipped — rather than copying jsep
and adding another 26 MB. The wake models are tiny CPU graphs; the webgpu
bundle still carries the wasm CPU EP. **Not yet verified end to end.**

## `ort/` needs no web_accessible_resources entry

Measured 2026-08-21: a framed extension page loads its own sub-resources —
`fetch` and `<script src>` alike — with no manifest entry. The boundary is the
web page. Exposing `ort/` (done briefly on 2026-08-21, then reverted) bought
nothing. See `e2e/extension-web-accessible.spec.ts`.

## If `wasmPaths` were ever unset, we would fetch from a CDN

transformers.js defaults it to
`https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/…` when unset, and
the manifest CSP (`connect-src` unrestricted, `wasm-unsafe-eval` present) does
not stop that. The top-level assignment in `chat-host.ts` is what keeps a
"runs entirely on your device" extension from fetching 23 MB off a CDN. Treat
it as load-bearing, not as tidy-up.
