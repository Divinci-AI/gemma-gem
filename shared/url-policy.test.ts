import { describe, it, expect } from "vitest";
import { sanitizeUrlForIndex, urlIndexDecision } from "./url-policy";

describe("sanitizeUrlForIndex", () => {
  it("keeps origin+pathname and drops query + fragment", () => {
    expect(sanitizeUrlForIndex("https://example.com/a/b?x=1&y=2#frag")).toBe(
      "https://example.com/a/b",
    );
  });

  it("returns null for non-http(s) schemes", () => {
    expect(sanitizeUrlForIndex("chrome://extensions")).toBeNull();
    expect(sanitizeUrlForIndex("file:///etc/passwd")).toBeNull();
    expect(sanitizeUrlForIndex("javascript:alert(1)")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(sanitizeUrlForIndex("not a url")).toBeNull();
  });
});

describe("urlIndexDecision", () => {
  it("allows a normal public https page and returns the sanitized url", () => {
    const d = urlIndexDecision("https://example.com/docs/guide?ref=nav#top");
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("ok");
    expect(d.sanitizedUrl).toBe("https://example.com/docs/guide");
  });

  it.each([
    ["chrome://extensions", "non-http"],
    ["http://localhost:3000/x", "private-host"],
    ["http://127.0.0.1/x", "private-host"],
    ["http://192.168.1.5/admin", "private-host"],
    ["http://router/setup", "private-host"], // bare intranet name (no dot)
    ["https://example.com:8443/x", "non-standard-port"],
    ["https://mail.google.com/inbox", "sensitive-host"],
    ["https://chase.com/dashboard", "sensitive-host"],
    ["https://example.com/login", "sensitive-path"],
    ["https://example.com/account/settings", "sensitive-path"],
    ["https://docs.google.com/document/d/1A2B3C4D5E6F7G8H9I0J/edit", "capability-path"],
    ["https://example.com/page?access_token=abc123", "capability-query"],
    ["https://bucket.s3.amazonaws.com/key?X-Amz-Signature=xyz", "capability-query"],
  ])("blocks %s as %s", (url, reason) => {
    const d = urlIndexDecision(url);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe(reason);
    expect(d.sanitizedUrl).toBeUndefined();
  });

  it("does not over-block benign query params (allows, strips query)", () => {
    const d = urlIndexDecision("https://example.com/search?q=cats&page=2");
    expect(d.allow).toBe(true);
    expect(d.sanitizedUrl).toBe("https://example.com/search");
  });
});
