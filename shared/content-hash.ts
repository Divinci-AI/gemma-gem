/**
 * Shared content fingerprint for WWW RAG freshness (content-hash parity).
 *
 * The whole point of this module is PARITY: the extension content script and
 * the server-side crawler must produce the SAME fingerprint for the same
 * logical page content, so `page-status?...&hash=` can answer fresh/stale
 * directly (design doc §3). Both sides MUST:
 *   1. extract the page's VISIBLE text (extension: `document.body.innerText`;
 *      crawler: its rendered/scraped text), then
 *   2. pass it through `normalizeVisibleText()` and `contentHash()` here.
 *
 * Keep this file pure (string -> string) and dependency-free so it can be
 * copied/ported verbatim into the crawler. The DOM extraction step lives in
 * the caller (it is the parity-sensitive part — see the caveat below).
 *
 * CAVEAT (tracked, intentional): true byte-parity also requires the two sides
 * to EXTRACT equivalent visible text. A static server crawl (HTML->text) and a
 * live-DOM `innerText` will not always match exactly, so v1 treats the hash as
 * advisory alongside `lastCrawledAt` staleness. This module pins the
 * normalization+hash half of the contract; extraction parity is a P2 concern.
 */

/**
 * Zero-width / BOM code points that editors and copy-paste inject as invisible
 * noise: ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), BOM (U+FEFF). Kept as
 * numeric codes so this source stays plain ASCII (no invisible chars in the
 * file) — important for a contract the crawler must mirror exactly.
 */
const ZERO_WIDTH_CODES = new Set<number>([0x200b, 0x200c, 0x200d, 0xfeff]);

/** Any run of whitespace (incl. NBSP, tabs, newlines) collapses to one space. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Deterministically normalize visible text so cosmetic differences
 * (whitespace, zero-width chars, Unicode form) don't change the fingerprint,
 * while real content changes do. NOT lowercased — a case change is a real
 * content change.
 */
export function normalizeVisibleText(raw: string): string {
  let stripped = "";
  for (const ch of raw.normalize("NFC")) {
    if (!ZERO_WIDTH_CODES.has(ch.codePointAt(0) ?? -1)) stripped += ch;
  }
  return stripped.replace(WHITESPACE_RUN, " ").trim();
}

/**
 * SHA-256 (lowercase hex) of the normalized visible text.
 *
 * Uses Web Crypto (`crypto.subtle`), available identically in MV3 content
 * scripts, service workers, Cloudflare Workers, and Node 20+ — so the
 * extension and the crawler compute the same digest. Returns 64-char hex.
 */
export async function contentHash(visibleText: string): Promise<string> {
  const normalized = normalizeVisibleText(visibleText);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
