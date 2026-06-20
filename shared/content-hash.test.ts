import { describe, it, expect } from "vitest";
import { normalizeVisibleText, contentHash } from "./content-hash";

const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0x00a0);

describe("normalizeVisibleText", () => {
  it("collapses every whitespace run (incl. NBSP/tabs/newlines) to one space", () => {
    expect(normalizeVisibleText("a  \t\n  b")).toBe("a b");
    expect(normalizeVisibleText(`a${NBSP}${NBSP}b`)).toBe("a b");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeVisibleText("  hello world  ")).toBe("hello world");
  });

  it("strips zero-width and BOM characters", () => {
    expect(normalizeVisibleText(`a${ZWSP}b${ZWJ}c${BOM}`)).toBe("abc");
  });

  it("is case-preserving (case change is a real content change)", () => {
    expect(normalizeVisibleText("Hello")).not.toBe(normalizeVisibleText("hello"));
  });

  it("is idempotent", () => {
    const once = normalizeVisibleText("  a \n b ");
    expect(normalizeVisibleText(once)).toBe(once);
  });

  it("NFC-normalizes equivalent Unicode forms to the same string", () => {
    // "cafe-acute": composed (U+00E9) vs decomposed (e + combining acute U+0301).
    const composed = "caf" + String.fromCharCode(0x00e9);
    const decomposed = "cafe" + String.fromCharCode(0x0301);
    expect(composed).not.toBe(decomposed); // genuinely different inputs
    expect(normalizeVisibleText(composed)).toBe(normalizeVisibleText(decomposed));
  });
});

describe("contentHash", () => {
  it("returns a 64-char lowercase hex digest", async () => {
    const h = await contentHash("hello world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 vector for the normalized input", async () => {
    // sha256("hello world") — normalization is a no-op for this input.
    expect(await contentHash("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("is whitespace/zero-width insensitive (same hash for cosmetic diffs)", async () => {
    const a = await contentHash("a b");
    const b = await contentHash(`  a${ZWSP}\t\n b  `);
    expect(a).toBe(b);
  });

  it("changes when real content changes", async () => {
    expect(await contentHash("version one")).not.toBe(
      await contentHash("version two"),
    );
  });
});
