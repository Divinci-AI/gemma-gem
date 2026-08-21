/**
 * `web_accessible_resources` — what a WEB PAGE may load from this extension.
 *
 * The boundary was measured on 2026-08-21, not reasoned about
 * (`e2e/extension-web-accessible.spec.ts`, project `web-accessible`):
 *
 *   from a web page            → an unexposed resource is BLOCKED
 *   from a framed extension    → an unexposed resource loads fine, by
 *   page (robot / inference)     `fetch` AND by `<script src>`
 *
 * So the rule is: expose the DOCUMENTS the page frames, and nothing else.
 * Once `inference.html` is loaded it is a same-origin extension context and
 * the manifest stops applying to what it pulls in — its chunks, its ORT
 * binaries, all of it.
 *
 * ⚠️ This file used to say the opposite: that a framed page's sub-resources
 * "must ALSO be web-accessible or the browser blocks them and nothing in the
 * iframe runs". Two build-time guards enforced that belief, and it is why the
 * manifest exposed eleven app chunks and ~50 MB of ORT binaries to
 * `<all_urls>`. Both framed pages boot with those entries removed — verified
 * by waiting for the `ready` message inference.html posts at the END of its
 * module, and for the robot's mount log. If Chrome ever tightens this, the
 * e2e test fails and says to restore them; over-exposing permanently against
 * that possibility is not the trade.
 */
export const WEB_ACCESSIBLE_RESOURCES = [
  // Framed into the host page by the content script (ui/chat-panel.ts sets
  // the empty-state robot, entrypoints/content.ts the inference host).
  'robot.html',
  'inference.html',
]

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

export function isMatched(path: string, patterns: string[] = WEB_ACCESSIBLE_RESOURCES): boolean {
  return patterns.some((p) => globToRegExp(p).test(path))
}

export interface PageContextRef {
  /** Extension-root-relative path the page context will load. */
  path: string
  /** The content-script bundle that names it. */
  script: string
}

/**
 * Paths the PAGE context resolves — the only ones the manifest governs.
 *
 * Content scripts are the bridge: they run alongside the page and everything
 * they hand it (an iframe src, an injected stylesheet, an image) is fetched
 * subject to `web_accessible_resources`. `chrome.runtime.getURL` is how a
 * content script names such a path, and it is unambiguous — always relative
 * to the extension root.
 *
 * MAIN-world content scripts declared in the manifest are NOT included and do
 * not need an entry: Chrome injects those itself.
 */
export function pageContextRefs(
  outDir: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf-8'): string; readdirSync(p: string): string[] },
  join: (...parts: string[]) => string,
): PageContextRef[] {
  const dir = join(outDir, 'content-scripts')
  if (!fs.existsSync(dir)) return []
  const refs: PageContextRef[] = []
  const seen = new Set<string>()

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(join(dir, file), 'utf-8')
    // Backticks included: a minifier keeps a template literal, and
    // getURL(`x/${y}`) resolves a directory just as getURL('x/') does.
    for (const m of src.matchAll(/getURL\(\s*["'`]([^"'`$]*)/g)) {
      const path = m[1].replace(/^\//, '')
      if (path === '') continue // getURL('') is the origin, not a file.
      const key = `${file}:${path}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ path, script: `content-scripts/${file}` })
    }
  }
  return refs
}

/** Page-context paths the manifest does not cover. The page cannot load these. */
export function unexposedPageContextRefs(
  outDir: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf-8'): string; readdirSync(p: string): string[] },
  join: (...parts: string[]) => string,
  patterns: string[] = WEB_ACCESSIBLE_RESOURCES,
): PageContextRef[] {
  return pageContextRefs(outDir, fs, join).filter(
    // A path absent from the build cannot be loaded either way, and is a
    // different bug — reported by `danglingExposure`'s sibling below, not
    // here, so a 404 does not masquerade as a manifest problem.
    (r) => fs.existsSync(join(outDir, r.path)) && !isMatched(r.path, patterns),
  )
}

/**
 * Exposure that buys nothing: a pattern no page-context path needs.
 *
 * This is the half that keeps the list honest. Without it the list only ever
 * grows — every entry looks defensible in isolation, and the eleven chunks and
 * ~50 MB of ORT binaries that used to be here were each added for a reason
 * that had stopped being true.
 */
export function unnecessaryExposure(
  outDir: string,
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf-8'): string; readdirSync(p: string): string[] },
  join: (...parts: string[]) => string,
  patterns: string[] = WEB_ACCESSIBLE_RESOURCES,
): string[] {
  const refs = pageContextRefs(outDir, fs, join)
  return patterns.filter((p) => !refs.some((r) => globToRegExp(p).test(r.path)))
}
