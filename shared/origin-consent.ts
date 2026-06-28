/**
 * Per-origin consent core for the OPEN programmatic API (any-website access to
 * the extension's local inference / agent / page-tool surfaces).
 *
 * The first-party path (chat.divinci.app via externally_connectable) is
 * authorized by the manifest allowlist and never reaches here. This module
 * governs the SECOND surface: arbitrary origins reaching the extension through
 * the content-script `window.divinci` MAIN-world bridge. Because any page can
 * try, authorization can't be implicit — every unknown origin is denied until
 * the user grants a scope, and grants are revocable.
 *
 * Everything here is a PURE function over plain data (the grant map + the
 * trusted-origin list). The browser glue (chrome.storage read/write, the
 * in-page consent prompt, the SW gate) calls these; this module never touches
 * chrome.* so the authorization logic is fully unit-testable without a browser.
 * That's the validate-before-mount discipline — authorization is the last place
 * you want a bug hiding in untestable bridge plumbing.
 */

/**
 * Capability scopes a page can be granted. Deliberately coarse — one scope per
 * open surface, not per method, so the consent prompt stays comprehensible.
 *   - `chat`      : run local model inference (consume the user's GPU)
 *   - `webmcp`    : the page's own agent may call extension-exposed tools
 *   - `a2a`       : the page's agent may submit tasks to the in-browser agent
 *   - `configure` : the site may configure the panel (welcome / starters /
 *                   system context) — site-supplied input reaching the model,
 *                   so it's a distinct, explicit scope (never folded into chat).
 */
export type ConsentScope = "chat" | "webmcp" | "a2a" | "configure";

export const ALL_CONSENT_SCOPES: readonly ConsentScope[] = ["chat", "webmcp", "a2a", "configure"];

export function isConsentScope(v: unknown): v is ConsentScope {
  return v === "chat" || v === "webmcp" || v === "a2a" || v === "configure";
}

/** A persisted grant for one origin. Stored under `divinci_origin_grants`. */
export interface OriginGrant {
  /** Normalized origin (scheme://host[:port], no path, lower-cased host). */
  origin: string;
  /** Scopes the user approved. Empty array == revoked (treat as absent). */
  scopes: ConsentScope[];
  /** ms epoch the grant was last updated. */
  grantedAt: number;
}

/** The full grant table: origin → grant. */
export type GrantMap = Record<string, OriginGrant>;

/** chrome.storage.local key the SW persists the grant map under. */
export const STORAGE_KEY_ORIGIN_GRANTS = "divinci_origin_grants";

export type ConsentDecision = "allow" | "prompt" | "deny";

export interface ConsentResult {
  decision: ConsentDecision;
  /** Machine-readable reason, for logging + the prompt UI. */
  reason:
    | "first-party"
    | "granted"
    | "needs-grant"
    | "invalid-origin"
    | "insecure-origin"
    | "invalid-scope";
}

/**
 * Normalize an origin string to the canonical form used as the grant-map key.
 * Returns null for anything that isn't a well-formed http(s) origin — paths,
 * wildcards, opaque origins ("null"), and non-http schemes are all rejected so
 * a malformed/hostile value can never become a grant key that later matches a
 * real origin.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // "null" is the opaque origin (sandboxed iframe, data: doc) — never grantable.
  if (raw === "null") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // An origin has no path/query/hash. `new URL("https://x.com/a")` parses, so
  // reject anything whose origin round-trip doesn't equal the input shape.
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (u.search || u.hash || u.username || u.password) return null;
  // u.origin lower-cases the host and drops the default port — the canonical key.
  return u.origin;
}

/** True only for https origins, or http://localhost / http://127.0.0.1 (dev). */
export function isSecureOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  return false;
}

/** Read the live scopes for an origin (empty grant / unknown origin → []). */
export function grantedScopes(grants: GrantMap, origin: string): ConsentScope[] {
  const g = grants[origin];
  if (!g || !Array.isArray(g.scopes)) return [];
  return g.scopes.filter(isConsentScope);
}

export function hasScope(grants: GrantMap, origin: string, scope: ConsentScope): boolean {
  return grantedScopes(grants, origin).includes(scope);
}

/**
 * The authorization decision for one (origin, scope) request. Pure: the caller
 * supplies the current grant map and the trusted first-party origin list
 * (ALLOWED_WEB_APP_ORIGINS). Order matters — validity first, then first-party
 * fast-path, then existing grant, else prompt.
 */
export function decideConsent(args: {
  rawOrigin: unknown;
  scope: unknown;
  grants: GrantMap;
  trustedOrigins: readonly string[];
}): ConsentResult {
  const { rawOrigin, scope, grants, trustedOrigins } = args;

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return { decision: "deny", reason: "invalid-origin" };
  if (!isSecureOrigin(origin)) return { decision: "deny", reason: "insecure-origin" };
  if (!isConsentScope(scope)) return { decision: "deny", reason: "invalid-scope" };

  // First-party origins are authorized by the manifest allowlist — all scopes,
  // no prompt. Keeps chat.divinci.app behavior identical to today.
  if (trustedOrigins.includes(origin)) return { decision: "allow", reason: "first-party" };

  if (hasScope(grants, origin, scope)) return { decision: "allow", reason: "granted" };

  return { decision: "prompt", reason: "needs-grant" };
}

/**
 * Return a NEW grant map with `scopes` added to `origin` (idempotent union).
 * Invalid origin/scopes are dropped rather than throwing — the caller has
 * already shown a prompt, and a malformed grant must never be persisted.
 * Does not mutate the input.
 */
export function grantScopes(
  grants: GrantMap,
  rawOrigin: unknown,
  scopes: readonly unknown[],
  now: number,
): GrantMap {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin || !isSecureOrigin(origin)) return grants;
  const add = scopes.filter(isConsentScope);
  if (add.length === 0) return grants;
  const existing = grantedScopes(grants, origin);
  const merged = Array.from(new Set([...existing, ...add]));
  return {
    ...grants,
    [origin]: { origin, scopes: merged, grantedAt: now },
  };
}

/**
 * Return a NEW grant map with `scopes` removed from `origin`. Removing the last
 * scope drops the origin entry entirely (no empty-grant tombstones). Omitting
 * `scopes` revokes the origin completely. Does not mutate the input.
 */
export function revokeScopes(
  grants: GrantMap,
  rawOrigin: unknown,
  scopes?: readonly unknown[],
): GrantMap {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin || !grants[origin]) return grants;
  const next = { ...grants };
  if (!scopes) {
    delete next[origin];
    return next;
  }
  const remove = new Set(scopes.filter(isConsentScope));
  const remaining = grantedScopes(grants, origin).filter((s) => !remove.has(s));
  if (remaining.length === 0) {
    delete next[origin];
  } else {
    next[origin] = { origin, scopes: remaining, grantedAt: grants[origin].grantedAt };
  }
  return next;
}

/**
 * Defensive sanitize of a grant map read from storage — drops entries with
 * invalid origins, normalizes keys, and filters scopes. Use after every
 * chrome.storage read so a corrupted/old-format value can't poison decisions.
 */
export function sanitizeGrantMap(raw: unknown): GrantMap {
  if (!raw || typeof raw !== "object") return {};
  const out: GrantMap = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const origin = normalizeOrigin((val as { origin?: unknown })?.origin ?? key);
    if (!origin || !isSecureOrigin(origin)) continue;
    const scopes = Array.isArray((val as { scopes?: unknown })?.scopes)
      ? ((val as { scopes: unknown[] }).scopes.filter(isConsentScope) as ConsentScope[])
      : [];
    if (scopes.length === 0) continue;
    const grantedAt =
      typeof (val as { grantedAt?: unknown })?.grantedAt === "number"
        ? (val as { grantedAt: number }).grantedAt
        : 0;
    out[origin] = { origin, scopes, grantedAt };
  }
  return out;
}
