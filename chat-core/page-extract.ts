/**
 * Page-content extraction helpers.
 *
 * The DOM read itself lives in the content script (needs `document`); this
 * module holds the pure, testable normalizer that collapses whitespace and
 * caps the length. The cap matters: Gemma 4 E2B runs on a memory-bounded
 * WebGPU KV cache, so we must not feed it an entire large page.
 */

/** Max characters of page text fed to the model (~2–3k tokens). */
export const PAGE_CONTENT_MAX_CHARS = 8000

export interface NormalizedPageText {
  text: string
  truncated: boolean
}

/**
 * Collapse runs of spaces/tabs, squeeze 3+ blank lines to 2, trim, and cap to
 * `maxChars` (appending an ellipsis when truncated). Pure + side-effect free.
 */
export function normalizePageText(
  raw: string,
  maxChars: number = PAGE_CONTENT_MAX_CHARS,
): NormalizedPageText {
  const collapsed = (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (collapsed.length <= maxChars) return { text: collapsed, truncated: false }
  return { text: collapsed.slice(0, maxChars).trimEnd() + '…', truncated: true }
}
