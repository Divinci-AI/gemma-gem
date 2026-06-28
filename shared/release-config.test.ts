import { describe, it, expect } from "vitest";
import { parseReleaseConfig, sanitizeSiteConfigMap } from "./release-config";

describe("parseReleaseConfig", () => {
  it("accepts the web release field names", () => {
    const cfg = parseReleaseConfig({
      welcomeMessage: "Hi there!",
      conversationStarters: ["What's new?", "Help me cook"],
      systemPrompt: "You are a helpful cooking assistant.",
      supportedLanguages: ["en", "es", "zh-Hans"],
      theme: { preset: "ocean", accent: "#3366ff" },
    });
    expect(cfg).toEqual({
      welcomeMessage: "Hi there!",
      conversationStarters: ["What's new?", "Help me cook"],
      systemPrompt: "You are a helpful cooking assistant.",
      supportedLanguages: ["en", "es", "zh-Hans"],
      theme: { preset: "ocean", accent: "#3366ff" },
    });
  });

  it("tolerates the design-doc aliases (welcome / starters / systemContext)", () => {
    const cfg = parseReleaseConfig({
      welcome: "Hello",
      starters: ["a"],
      systemContext: "context",
    });
    expect(cfg).toEqual({ welcomeMessage: "Hello", conversationStarters: ["a"], systemPrompt: "context" });
  });

  it("clamps lengths and caps starters at 10", () => {
    const cfg = parseReleaseConfig({
      welcomeMessage: "x".repeat(5000),
      systemPrompt: "y".repeat(50000),
      conversationStarters: Array.from({ length: 30 }, (_, i) => `s${i}`),
    });
    expect(cfg!.welcomeMessage!.length).toBe(2000);
    expect(cfg!.systemPrompt!.length).toBe(10_000);
    expect(cfg!.conversationStarters!.length).toBe(10);
  });

  it("clamps each starter to 200 chars and drops empties", () => {
    const cfg = parseReleaseConfig({ conversationStarters: ["z".repeat(500), "  ", "ok"] });
    expect(cfg!.conversationStarters![0].length).toBe(200);
    expect(cfg!.conversationStarters).toEqual([expect.any(String), "ok"]);
  });

  it("rejects non-hex theme colors (blocks CSS injection)", () => {
    expect(parseReleaseConfig({ theme: { accent: "url(javascript:alert(1))" } })).toBeNull();
    expect(parseReleaseConfig({ theme: { accent: "red" } })).toBeNull();
    expect(parseReleaseConfig({ theme: { accent: "#abc" } })).toEqual({ theme: { accent: "#abc" } });
  });

  it("drops malformed languages (only [A-Za-z0-9-])", () => {
    const cfg = parseReleaseConfig({ supportedLanguages: ["en", "es;rm -rf", "fr", 5] });
    expect(cfg!.supportedLanguages).toEqual(["en", "fr"]);
  });

  it("returns null for empty / garbage / no-usable-fields input", () => {
    expect(parseReleaseConfig(null)).toBeNull();
    expect(parseReleaseConfig("nope")).toBeNull();
    expect(parseReleaseConfig({})).toBeNull();
    expect(parseReleaseConfig({ unknown: 1, welcomeMessage: "   " })).toBeNull();
  });

  it("keeps a partial config (only welcome)", () => {
    expect(parseReleaseConfig({ welcomeMessage: "Hey" })).toEqual({ welcomeMessage: "Hey" });
  });
});

describe("sanitizeSiteConfigMap", () => {
  const valid = (o: string) => o.startsWith("https://");

  it("keeps valid origins with usable configs, drops the rest", () => {
    const map = sanitizeSiteConfigMap(
      {
        "https://good.com": { welcomeMessage: "Hi" },
        "http://insecure.com": { welcomeMessage: "Hi" }, // invalid origin per predicate
        "https://empty.com": { junk: 1 }, // no usable fields
      },
      valid,
    );
    expect(Object.keys(map)).toEqual(["https://good.com"]);
    expect(map["https://good.com"]).toEqual({ welcomeMessage: "Hi" });
  });

  it("returns {} for non-object input", () => {
    expect(sanitizeSiteConfigMap(null, valid)).toEqual({});
  });
});
