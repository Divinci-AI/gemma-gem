import { describe, it, expect } from "vitest";
import {
  normalizeOrigin,
  isSecureOrigin,
  decideConsent,
  grantScopes,
  revokeScopes,
  hasScope,
  grantedScopes,
  sanitizeGrantMap,
  isConsentScope,
  ALL_CONSENT_SCOPES,
  type GrantMap,
} from "./origin-consent";

const TRUSTED = ["https://chat.divinci.app", "https://chat.stage.divinci.app"];

describe("normalizeOrigin", () => {
  it("canonicalizes a plain https origin", () => {
    expect(normalizeOrigin("https://Example.com")).toBe("https://example.com");
  });

  it("drops the default port but keeps a non-default one", () => {
    expect(normalizeOrigin("https://example.com:443")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
  });

  it("rejects URLs carrying a path / query / hash", () => {
    expect(normalizeOrigin("https://example.com/foo")).toBeNull();
    expect(normalizeOrigin("https://example.com/?x=1")).toBeNull();
    expect(normalizeOrigin("https://example.com/#h")).toBeNull();
  });

  it("rejects credentials embedded in the URL", () => {
    expect(normalizeOrigin("https://user:pass@example.com")).toBeNull();
  });

  it("rejects non-http(s) schemes, wildcards, opaque + empty", () => {
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("chrome-extension://abc")).toBeNull();
    expect(normalizeOrigin("*://*/*")).toBeNull();
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(42)).toBeNull();
  });

  it("accepts a bare origin with no trailing slash", () => {
    expect(normalizeOrigin("https://example.com")).toBe("https://example.com");
  });
});

describe("isSecureOrigin", () => {
  it("accepts https", () => {
    expect(isSecureOrigin("https://example.com")).toBe(true);
  });
  it("accepts http only for localhost/loopback", () => {
    expect(isSecureOrigin("http://localhost:8080")).toBe(true);
    expect(isSecureOrigin("http://127.0.0.1")).toBe(true);
  });
  it("rejects http for a public host", () => {
    expect(isSecureOrigin("http://example.com")).toBe(false);
  });
});

describe("isConsentScope", () => {
  it("recognizes the known scopes and nothing else", () => {
    expect(ALL_CONSENT_SCOPES).toEqual(["chat", "webmcp", "a2a", "configure"]);
    for (const s of ALL_CONSENT_SCOPES) expect(isConsentScope(s)).toBe(true);
    expect(isConsentScope("admin")).toBe(false);
    expect(isConsentScope(undefined)).toBe(false);
  });
});

describe("decideConsent", () => {
  const base = { grants: {} as GrantMap, trustedOrigins: TRUSTED };

  it("auto-allows first-party origins for any scope without a grant", () => {
    expect(
      decideConsent({ rawOrigin: "https://chat.divinci.app", scope: "chat", ...base }),
    ).toEqual({ decision: "allow", reason: "first-party" });
  });

  it("prompts for an unknown origin with no grant", () => {
    expect(
      decideConsent({ rawOrigin: "https://shop.example.com", scope: "chat", ...base }),
    ).toEqual({ decision: "prompt", reason: "needs-grant" });
  });

  it("allows once the scope is granted", () => {
    const grants = grantScopes({}, "https://shop.example.com", ["chat"], 1000);
    expect(
      decideConsent({ rawOrigin: "https://shop.example.com", scope: "chat", grants, trustedOrigins: TRUSTED }),
    ).toEqual({ decision: "allow", reason: "granted" });
  });

  it("still prompts for a DIFFERENT scope on a partially-granted origin", () => {
    const grants = grantScopes({}, "https://shop.example.com", ["chat"], 1000);
    expect(
      decideConsent({ rawOrigin: "https://shop.example.com", scope: "a2a", grants, trustedOrigins: TRUSTED }).decision,
    ).toBe("prompt");
  });

  it("denies invalid / insecure origins and invalid scopes", () => {
    expect(decideConsent({ rawOrigin: "https://x.com/path", scope: "chat", ...base }).reason).toBe("invalid-origin");
    expect(decideConsent({ rawOrigin: "http://example.com", scope: "chat", ...base }).reason).toBe("insecure-origin");
    expect(decideConsent({ rawOrigin: "https://x.com", scope: "root", ...base }).reason).toBe("invalid-scope");
  });

  it("does not let a granted insecure origin sneak through (defense in depth)", () => {
    // grantScopes refuses to persist it, so the map stays empty → prompt/deny.
    const grants = grantScopes({}, "http://evil.com", ["chat"], 1000);
    expect(Object.keys(grants)).toHaveLength(0);
  });
});

describe("grantScopes / revokeScopes", () => {
  it("adds scopes immutably and unions on repeat", () => {
    const g1 = grantScopes({}, "https://a.com", ["chat"], 100);
    const g2 = grantScopes(g1, "https://a.com", ["webmcp", "chat"], 200);
    expect(g1["https://a.com"].scopes).toEqual(["chat"]);
    expect(g2["https://a.com"].scopes.sort()).toEqual(["chat", "webmcp"]);
    expect(g2["https://a.com"].grantedAt).toBe(200);
    expect(g1).not.toBe(g2);
  });

  it("filters out non-scopes when granting", () => {
    const g = grantScopes({}, "https://a.com", ["chat", "hax", 5], 100);
    expect(g["https://a.com"].scopes).toEqual(["chat"]);
  });

  it("is a no-op for invalid/insecure origins", () => {
    expect(grantScopes({}, "http://evil.com", ["chat"], 100)).toEqual({});
    expect(grantScopes({}, "not-a-url", ["chat"], 100)).toEqual({});
    expect(grantScopes({}, "https://a.com", [], 100)).toEqual({});
  });

  it("revokes a single scope and keeps the rest", () => {
    const g = grantScopes({}, "https://a.com", ["chat", "webmcp"], 100);
    const r = revokeScopes(g, "https://a.com", ["webmcp"]);
    expect(r["https://a.com"].scopes).toEqual(["chat"]);
  });

  it("drops the origin entry when the last scope is revoked", () => {
    const g = grantScopes({}, "https://a.com", ["chat"], 100);
    const r = revokeScopes(g, "https://a.com", ["chat"]);
    expect(r["https://a.com"]).toBeUndefined();
  });

  it("revokes the whole origin when scopes omitted", () => {
    const g = grantScopes({}, "https://a.com", ["chat", "webmcp"], 100);
    expect(revokeScopes(g, "https://a.com")["https://a.com"]).toBeUndefined();
  });

  it("revoke is a no-op for an unknown origin", () => {
    const g = grantScopes({}, "https://a.com", ["chat"], 100);
    expect(revokeScopes(g, "https://b.com")).toEqual(g);
  });
});

describe("hasScope / grantedScopes", () => {
  it("reports live scopes", () => {
    const g = grantScopes({}, "https://a.com", ["chat"], 100);
    expect(hasScope(g, "https://a.com", "chat")).toBe(true);
    expect(hasScope(g, "https://a.com", "a2a")).toBe(false);
    expect(grantedScopes(g, "https://unknown.com")).toEqual([]);
  });
});

describe("sanitizeGrantMap", () => {
  it("drops invalid origins, insecure origins, and empty-scope entries", () => {
    const raw = {
      "https://good.com": { origin: "https://good.com", scopes: ["chat", "bad"], grantedAt: 1 },
      "http://evil.com": { origin: "http://evil.com", scopes: ["chat"], grantedAt: 2 },
      "https://empty.com": { origin: "https://empty.com", scopes: [], grantedAt: 3 },
      "garbage": { origin: "not-a-url", scopes: ["chat"], grantedAt: 4 },
    };
    const clean = sanitizeGrantMap(raw);
    expect(Object.keys(clean)).toEqual(["https://good.com"]);
    expect(clean["https://good.com"].scopes).toEqual(["chat"]);
  });

  it("returns {} for non-object input", () => {
    expect(sanitizeGrantMap(null)).toEqual({});
    expect(sanitizeGrantMap("x")).toEqual({});
  });

  it("round-trips a grantScopes output unchanged", () => {
    const g = grantScopes(grantScopes({}, "https://a.com", ["chat"], 1), "https://b.com", ["a2a", "webmcp"], 2);
    expect(sanitizeGrantMap(g)).toEqual(g);
  });
});
