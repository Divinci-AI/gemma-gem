import { describe, it, expect } from "vitest";
import { detectDivinciEmbed } from "./divinci-embed-detect";

/** Minimal fake query root: id map + selector→element matcher. */
type El = { getAttribute(n: string): string | null };
function fakeDoc(opts: {
  ids?: Record<string, Record<string, string>>;
  selectors?: Record<string, Record<string, string>>;
}): { getElementById: (id: string) => El | null; querySelector: (s: string) => El | null } {
  const mk = (attrs: Record<string, string>): El => ({ getAttribute: (n: string) => attrs[n] ?? null });
  return {
    getElementById: (id) => (opts.ids?.[id] ? mk(opts.ids[id]) : null),
    querySelector: (sel) => (opts.selectors?.[sel] ? mk(opts.selectors[sel]) : null),
  };
}

describe("detectDivinciEmbed", () => {
  it("detects the embed-chat-ui widget by its container id + reads release id", () => {
    const doc = fakeDoc({
      ids: { "divinci-docs-assistant": {}, "divinci-docs-config": { "data-release-id": "rel_123" } },
    });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "embed-chat-ui", releaseId: "rel_123" });
  });

  it("detects the canonical [data-divinci-embed] marker (no value) alone", () => {
    const doc = fakeDoc({ selectors: { "[data-divinci-embed]": {} } });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "embed-chat-ui", releaseId: undefined });
  });

  it("reads the release id from the [data-divinci-embed] marker value", () => {
    const doc = fakeDoc({ selectors: { "[data-divinci-embed]": { "data-divinci-embed": "rel_marker" } } });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "embed-chat-ui", releaseId: "rel_marker" });
  });

  it("detects the embed-script toggleable container", () => {
    const doc = fakeDoc({ selectors: { '[class*="divinci-"][class*="-container"]': {} } });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "embed-script" });
  });

  it("detects the embed-script tag + reads its release id", () => {
    const doc = fakeDoc({
      selectors: { "script[divinci-release-id], script[src*='embed-script']": { "divinci-release-id": "rel_abc" } },
    });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "embed-script", releaseId: "rel_abc" });
  });

  it("falls back to the docs config element", () => {
    const doc = fakeDoc({ ids: { "divinci-docs-config": { "data-release-id": "rel_x" } } });
    expect(detectDivinciEmbed(doc)).toEqual({ kind: "docs-config", releaseId: "rel_x" });
  });

  it("returns null on a plain page (no Divinci widget)", () => {
    expect(detectDivinciEmbed(fakeDoc({}))).toBeNull();
  });

  it("prefers the embed-chat-ui signal over weaker ones", () => {
    const doc = fakeDoc({
      ids: { "divinci-docs-assistant": {} },
      selectors: { '[class*="divinci-"][class*="-container"]': {} },
    });
    expect(detectDivinciEmbed(doc)?.kind).toBe("embed-chat-ui");
  });
});
