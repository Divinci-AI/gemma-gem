/**
 * Stop Vite emitting an ORT wasm binary that nothing fetches.
 *
 * ORT's ESM carries `new URL("ort-wasm-….wasm", import.meta.url)`. Vite treats
 * that as an asset reference, copies the 23.57 MB binary into `assets/` and
 * rewrites the URL — whether or not the expression is ever evaluated.
 *
 * It is not. Both sites sit on a dead branch:
 *
 *   we ??= r.locateFile ? r.locateFile(name, dir) : new URL(name, import.meta.url)
 *   !wasm.wasmPaths && (…) && (wasmPaths = { wasm: new URL(name, import.meta.url) })
 *
 * ORT installs `locateFile` whenever `wasmPaths` is set, and `wasmPaths` is set
 * at module scope by `offscreen/chat-host.ts` before any session exists. (If it
 * somehow were not, transformers.js's own default takes over first — and points
 * at a jsDelivr CDN, which is its own problem; see notes/ort-binaries.md.)
 *
 * So the binary ships purely because a static analyser cannot see that the
 * branch is dead. Splitting the literal makes it unanalysable without changing
 * the string it evaluates to, so the runtime value is byte-identical and the
 * emission stops.
 *
 * ⚠️ This trades a silent 24 MB for a 404 IF that branch ever becomes live —
 * the URL would then resolve against `chunks/`. `no-emitted-wasm-assets` in
 * wxt.config fails the build if the asset reappears, which is the signal that
 * ORT changed shape and this reasoning needs redoing.
 */
export interface OrtAssetPlugin {
  name: string
  enforce: 'pre'
  transform(code: string, id: string): { code: string; map: null } | null
  /** How many references were defused. Zero on a real build means it stopped working. */
  readonly rewrites: number
}

const ORT_WASM_URL = /new URL\((["'])(ort-wasm-[A-Za-z0-9_.-]+\.wasm)\1\s*,\s*import\.meta\.url\)/g

export function stripUnusedOrtWasmAsset(): OrtAssetPlugin {
  let rewrites = 0
  return {
    name: 'divinci:strip-unused-ort-wasm-asset',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.includes('onnxruntime-web')) return null
      if (!ORT_WASM_URL.test(code)) {
        ORT_WASM_URL.lastIndex = 0
        return null
      }
      ORT_WASM_URL.lastIndex = 0
      const out = code.replace(ORT_WASM_URL, (_m, q: string, name: string) => {
        rewrites++
        // Same string, one concatenation Vite will not fold.
        const cut = name.length - '.wasm'.length
        return `new URL(${q}${name.slice(0, cut)}${q}+${q}${name.slice(cut)}${q},import.meta.url)`
      })
      return { code: out, map: null }
    },
    get rewrites() {
      return rewrites
    },
  }
}

/** Emitted wasm under `assets/` — by construction, a binary nothing fetches. */
export function emittedWasmAssets(
  outDir: string,
  fs: { existsSync(p: string): boolean; readdirSync(p: string): string[] },
  join: (...parts: string[]) => string,
): string[] {
  const dir = join(outDir, 'assets')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.wasm'))
    .map((f) => `assets/${f}`)
    .sort()
}
