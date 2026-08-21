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
"dedupe" framing were reverted; the reframing worked on the first try —
`build/ort-asset-emission.ts` splits the literal so Vite cannot resolve it,
leaving the evaluated string identical.

⚠️ **Not verified at runtime.** The argument that the branch is dead is static:
ORT installs `locateFile` whenever `wasmPaths` is set, so the `new URL`
fallback is not taken, and the other site is guarded by `!wasmPaths`. If that
is wrong, ORT 404s at SESSION CREATION — which no test here reaches, because
every model load starts with a multi-hundred-MB download. Run
`RUN_REAL_INFERENCE=1 pnpm e2e` before shipping a store update.

## Fixed 2026-08-21

`offscreen/wake-host.ts` now imports `onnxruntime-web/webgpu`, so both
consumers share the asyncify binary. Two consequences:

- The build inlines ONE ORT runtime instead of two, and Vite stops emitting
  `assets/…jsep-<hash>.wasm` because nothing references it. **The package went
  from 78.89 MB to 52.39 MB** — a 26.5 MB drop from a one-line import change.
- `build/ort-binaries.ts` reads each inlined bundle's required filenames out of
  ORT's own dist and fails the build if `ort/` lacks them, so an ORT upgrade
  that renames a binary is a build error rather than a runtime 404.

Wake word has NOT been exercised end to end since the change — it needs a
microphone. What is verified is that the binary it asks for now ships.

## The original defect: wake word could not load

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


## Package size, 2026-08-21

| | unpacked | zipped |
|---|---|---|
| before | 78.89 MB | 21.02 MB |
| after unifying on one ORT build | 52.39 MB | — |
| after suppressing the dead asset | **28.82 MB** | **9.2 MB** |

Nothing was compressed or removed from the product: one wasm variant was never
loadable, and one was never fetched.
