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
  'assets/ort-wasm-*.wasm',
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

  return [...reachable].filter((f) => !isMatched(f, patterns)).sort()
}
