/**
 * Client-side URL policy for WWW RAG (design doc §4, §8, §9).
 *
 * Two jobs, both fail-safe:
 *   - `sanitizeUrlForIndex` — reduce a URL to origin+pathname (drop query +
 *     fragment, which carry tokens/PII) before it's ever sent.
 *   - `urlIndexDecision` — a conservative quick blacklist so the extension
 *     NEVER even sends a sensitive / capability / private URL to the server.
 *
 * This is the cheap client gate; the AUTHORITATIVE denylist lives server-side.
 * When in doubt, this errs toward NOT indexing.
 */

/** Private / loopback / link-local IPv4 prefixes. */
const PRIVATE_HOST =
  /^(0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function isPrivateOrLocal(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (PRIVATE_HOST.test(h)) return true;
  // No dot => bare intranet name (e.g. "router", "nas"); not a public site.
  if (!h.includes(".")) return true;
  return false;
}

/** Hosts whose content is inherently sensitive (seed list; server is authoritative). */
const SENSITIVE_HOST = [
  /(^|\.)(mail|webmail|outlook|gmail|protonmail|proton|yahoo)\./i,
  /(^|\.)(bank|chase|wellsfargo|citi|paypal|venmo|stripe|coinbase|robinhood|fidelity|schwab)\./i,
];

/** Path segments that indicate an auth/account/payment surface. */
const SENSITIVE_PATH =
  /\/(log[-]?in|sign[-]?in|sign[-]?up|register|auth|oauth|sso|password|passwd|reset|forgot|account|accounts|billing|checkout|payment|wallet|admin)(\/|$)/i;

/** Capability/by-obscurity share paths (Google Docs, Dropbox, etc.). */
const CAPABILITY_PATH = /\/(d|s|sh|scl|file|document)\/[A-Za-z0-9_-]{16,}/;

/** Query params that carry credentials/capabilities — the whole URL is unsafe. */
const CAPABILITY_QUERY =
  /[?&](access[_-]?token|id[_-]?token|refresh[_-]?token|token|sig|signature|secret|api[_-]?key|apikey|key|password|pwd|passwd|auth|otp|session)=/i;
/** AWS pre-signed URL marker. */
const PRESIGNED_QUERY = /[?&]x-amz-/i;

/**
 * Reduce a URL to the canonical origin+pathname (drops query + fragment).
 * Returns null for anything that isn't a sane http(s) URL.
 */
export function sanitizeUrlForIndex(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin + u.pathname;
}

export interface UrlIndexDecision {
  allow: boolean;
  /** Machine-readable reason; useful for the pill state + telemetry. */
  reason:
    | "ok"
    | "invalid-url"
    | "non-http"
    | "private-host"
    | "non-standard-port"
    | "sensitive-host"
    | "sensitive-path"
    | "capability-path"
    | "capability-query";
  /** origin+pathname; present only when allow === true. */
  sanitizedUrl?: string;
}

/**
 * Decide whether a URL may be sent to WWW RAG (page-status / submit-url).
 * Conservative: any sensitive/capability/private signal => not allowed.
 */
export function urlIndexDecision(href: string): UrlIndexDecision {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { allow: false, reason: "invalid-url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { allow: false, reason: "non-http" };
  if (isPrivateOrLocal(u.hostname))
    return { allow: false, reason: "private-host" };
  if (u.port && u.port !== "80" && u.port !== "443")
    return { allow: false, reason: "non-standard-port" };
  if (SENSITIVE_HOST.some((re) => re.test(u.hostname)))
    return { allow: false, reason: "sensitive-host" };
  if (SENSITIVE_PATH.test(u.pathname))
    return { allow: false, reason: "sensitive-path" };
  if (CAPABILITY_PATH.test(u.pathname))
    return { allow: false, reason: "capability-path" };
  if (CAPABILITY_QUERY.test(u.search) || PRESIGNED_QUERY.test(u.search))
    return { allow: false, reason: "capability-query" };
  return { allow: true, reason: "ok", sanitizedUrl: u.origin + u.pathname };
}
