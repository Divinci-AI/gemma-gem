/**
 * `web_accessible_resources` for the two iframes that are framed FROM a web
 * page (robot.html, inference.html). Because they are framed rather than opened
 * as extension pages, their own sub-resource scripts must ALSO be
 * web-accessible or the browser blocks them and nothing in the iframe runs.
 *
 * The list used to end in `chunks/*.js` + `assets/*`, with a TODO to tighten.
 * That blanket also exposed the offscreen / panel / popup / release-config
 * app-logic chunks to EVERY origin — fingerprinting surface, and Chrome Web
 * Store review surface, for no functional gain.
 *
 * ⚠️ Getting this wrong fails SILENTLY: the iframe goes blank and the
 * extension looks broken with no error attributable to the manifest. So the
 * list is not maintained by hand — `verifyWebAccessibleClosure()` recomputes
 * the real transitive closure from the BUILD OUTPUT after every build and
 * throws if any reachable chunk is unmatched. Add a lazy import, and the build
 * tells you; nobody has to remember this comment.
 */
export const WEB_ACCESSIBLE_RESOURCES = [
  // The 3D mascot iframe in the panel's empty state, + its no-WebGL fallback.
  'robot.html',
  'divinci-robot.png',
  'chunks/robot-*.js',
  'chunks/logo-robot-*.js',
  // Page-context inference host iframe.
  'inference.html',
  'chunks/inference-*.js',
  'chunks/models-*.js',
  'chunks/logger-*.js',
  // Carries transformers.js + onnxruntime-web (~530 kB).
  'chunks/cache-breakdown-*.js',
  // Shared vite/wxt infra imported by both iframes.
  'chunks/preload-helper-*.js',
  'chunks/_virtual_wxt-html-plugins-*.js',
  // ORT wasm binaries, fetched by onnxruntime-web from inside the iframe.
  // NOT `assets/*` — that also exposed the popup stylesheet.
  //
  // `ort/` is the live one. chat-host.ts sets `wasmPaths = getURL('ort/')` at
  // MODULE top level and entrypoints/inference/main.ts imports chat-host, so
  // the framed iframe runs that assignment too — and a string `wasmPaths`
  // makes ORT prefix it onto every binary it loads. Exposing only `assets/`
  // left the iframe aimed at a directory it could not read;
  // `unmatchedRuntimeAssets` below is what surfaced that.
  //
  // `assets/` is a bundler artifact, NOT a second live path. ORT's own ESM
  // bundle carries `new URL('...wasm', import.meta.url)`, so Vite emits and
  // rewrites the binary whether or not anything fetches it — and nothing
  // does: every reference sits behind `!wasmPaths && …`, and wasmPaths is
  // always set. It stays listed only because the literal survives in a
  // reachable chunk, which the guard cannot tell apart from a live fetch.
  // The two `assets/*.wasm` files are ~49 MB of the package. See
  // notes/ort-binaries.md before trying to remove them.
  'assets/ort-wasm-*.wasm',
  'ort/ort-wasm-*.mjs',
  'ort/ort-wasm-*.wasm',
]

/** Pages framed from a web origin; the roots of the reachability walk. */
const FRAMED_PAGES = ['robot.html', 'inference.html']

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

export function isMatched(path: string, patterns: string[] = WEB_ACCESSIBLE_RESOURCES): boolean {
  return patterns.some((p) => globToRegExp(p).test(path))
}

/**
 * Walk the real import graph of the framed pages in `outDir` and return every
 * reachable `chunks/*.js` that no `web_accessible_resources` pattern matches.
 * Empty array == the manifest covers what the iframes actually load.
 */
export function unmatchedWebAccessibleChunks(
  outDir: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf-8'): string },
  join: (...parts: string[]) => string,
  patterns: string[] = WEB_ACCESSIBLE_RESOURCES,
): string[] {
  return [...reachableChunks(outDir, fs, join)].filter((f) => !isMatched(f, patterns)).sort()
}

/**
 * The chunks the framed pages actually reach, as build-output paths.
 * Shared by both guards below so they cannot disagree about reachability.
 */
export function reachableChunks(
  outDir: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf-8'): string },
  join: (...parts: string[]) => string,
): Set<string> {
  const reachable = new Set<string>()
  const stack: string[] = []

  for (const page of FRAMED_PAGES) {
    const p = join(outDir, page)
    if (!fs.existsSync(p)) continue
    const html = fs.readFileSync(p, 'utf-8')
    for (const m of html.matchAll(/(?:src|href)="\.?\/?(chunks\/[^"]+\.js)"/g)) stack.push(m[1])
  }

  while (stack.length > 0) {
    const file = stack.pop() as string
    if (reachable.has(file)) continue
    const p = join(outDir, file)
    if (!fs.existsSync(p)) continue
    reachable.add(file)
    const src = fs.readFileSync(p, 'utf-8')
    // Static and dynamic imports alike, relative to the chunks/ directory.
    for (const m of src.matchAll(/["']\.\/([A-Za-z0-9_.-]+\.js)["']/g)) stack.push(`chunks/${m[1]}`)
    for (const m of src.matchAll(/["'](chunks\/[A-Za-z0-9_.-]+\.js)["']/g)) stack.push(m[1])
  }

  return reachable
}

export interface RuntimeAssetProblem {
  /** Extension-root-relative path the chunk will fetch. */
  path: string
  /** The reachable chunk that names it. */
  chunk: string
  reason: 'missing-from-build' | 'not-web-accessible'
}

/**
 * Paths a reachable chunk fetches at RUN time rather than importing.
 *
 * `unmatchedWebAccessibleChunks` walks the import graph, so it sees every
 * `.js` the iframe loads — and nothing else. A `.wasm` binary that
 * onnxruntime-web fetches from a string, or an image resolved through
 * `chrome.runtime.getURL`, is invisible to it. That blind spot is the one
 * that cost the most time: the iframe loads, every chunk resolves, and then
 * a fetch 404s with the failure surfacing as a stalled model load.
 *
 * Only the two forms whose target is UNAMBIGUOUS are extracted:
 *
 *   - `chrome.runtime.getURL("p")` — always extension-root relative.
 *   - a root-relative literal (`"/assets/x.wasm"`), including as the first
 *     argument of `new URL(...)`, which is how Vite emits an asset reference.
 *
 * A bare relative literal (`new URL("ort.bundle.min.mjs", self.location.href)`)
 * is deliberately NOT extracted: its meaning depends on the fetching document's
 * URL, which is not knowable from the build output, and guessing wrong would
 * produce false failures on ORT's own internal strings. That is a real
 * remaining gap, recorded here rather than papered over.
 *
 * A path ending in `/` is a directory (`getURL('ort/')` — the prefix ORT is
 * handed as `wasmPaths`). Every file in it must be exposed, because which one
 * gets fetched is a runtime decision about the host's capabilities.
 */
export function unmatchedRuntimeAssets(
  outDir: string,
  fs: {
    existsSync(p: string): boolean
    readFileSync(p: string, enc: 'utf-8'): string
    readdirSync(p: string): string[]
  },
  join: (...parts: string[]) => string,
  patterns: string[] = WEB_ACCESSIBLE_RESOURCES,
): RuntimeAssetProblem[] {
  /** Every file under `p`, extension-root-relative. `p` itself if it is a file. */
  const filesUnder = (p: string): string[] => {
    let entries: string[]
    try {
      entries = fs.readdirSync(join(outDir, p))
    } catch {
      return [p] // not a directory
    }
    const base = p.endsWith('/') ? p : `${p}/`
    return entries.flatMap((e) => filesUnder(`${base}${e}`))
  }

  const problems: RuntimeAssetProblem[] = []
  const seen = new Set<string>()

  for (const chunk of [...reachableChunks(outDir, fs, join)].sort()) {
    const src = fs.readFileSync(join(outDir, chunk), 'utf-8')
    const refs = new Set<string>()

    // Our own deliberate runtime resolution. A directory is legitimate here —
    // `getURL('ort/')` is the prefix ORT is handed as `wasmPaths`.
    for (const m of src.matchAll(/getURL\(\s*["']([^"']*)["']/g)) refs.add(m[1])

    // A root-relative literal naming a FILE. The extension is required on
    // purpose: a bare directory literal in this form is almost always a
    // library default that nothing fetches (transformers.js ships
    // `localModelPath = '/models/'` and we run with allowLocalModels off),
    // and a guard that reports those teaches people to ignore it.
    for (const m of src.matchAll(
      /["']\/?((?:assets|ort|models|icon)\/[^"']*\.[A-Za-z0-9]+)["']/g,
    )) {
      refs.add(m[1])
    }

    for (const ref of refs) {
      if (ref === '') continue // `getURL('')` is the origin, not a file.

      if (!fs.existsSync(join(outDir, ref))) {
        const key = `${chunk}:${ref}`
        if (!seen.has(key)) {
          seen.add(key)
          problems.push({ path: ref, chunk, reason: 'missing-from-build' })
        }
        continue
      }

      for (const target of filesUnder(ref)) {
        const key = `${chunk}:${target}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!isMatched(target, patterns)) {
          problems.push({ path: target, chunk, reason: 'not-web-accessible' })
        }
      }
    }
  }

  return problems
}
