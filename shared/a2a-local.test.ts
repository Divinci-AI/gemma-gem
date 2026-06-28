import { describe, it, expect } from "vitest";
import {
  A2A_PROTOCOL_VERSION,
  buildLocalAgentCard,
  extractTaskPrompt,
  buildCompletedTask,
  buildFailedTask,
} from "./a2a-local";

describe("buildLocalAgentCard", () => {
  it("produces a spec-shaped, UNSIGNED card", () => {
    const card = buildLocalAgentCard({ extensionVersion: "1.2.3", supportedModels: ["gemma-4-e2b"] });
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.name).toBe("Divinci Local Agent");
    expect(card.version).toBe("1.2.3");
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.skills[0].id).toBe("local-chat");
    expect(card.skills[0].description).toContain("gemma-4-e2b");
    expect(card.signatures).toBeUndefined(); // local card is never self-signed
  });

  it("handles no models gracefully", () => {
    const card = buildLocalAgentCard({ extensionVersion: "1.0.0", supportedModels: [] });
    expect(card.skills[0].description).not.toContain("(");
  });
});

describe("extractTaskPrompt", () => {
  it("joins text parts and trims", () => {
    const msg = { parts: [{ kind: "text", text: "hello" }, { kind: "text", text: "world" }] };
    expect(extractTaskPrompt(msg)).toBe("hello\nworld");
  });
  it("ignores non-text parts", () => {
    const msg = { parts: [{ kind: "file", uri: "x" }, { kind: "text", text: "ok" }] };
    expect(extractTaskPrompt(msg)).toBe("ok");
  });
  it("returns empty for malformed input", () => {
    expect(extractTaskPrompt(null)).toBe("");
    expect(extractTaskPrompt({})).toBe("");
    expect(extractTaskPrompt({ parts: "nope" })).toBe("");
  });
});

describe("buildCompletedTask", () => {
  it("wraps text into a completed task with one artifact", () => {
    const t = buildCompletedTask({ id: "t1", contextId: "c1", text: "answer", now: "2026-06-28T00:00:00Z" });
    expect(t).toEqual({
      kind: "task",
      id: "t1",
      contextId: "c1",
      status: { state: "completed", timestamp: "2026-06-28T00:00:00Z" },
      artifacts: [{ artifactId: "t1-artifact-0", parts: [{ kind: "text", text: "answer" }] }],
      history: [],
    });
  });
});

describe("buildFailedTask", () => {
  it("carries the reason in the status message", () => {
    const t = buildFailedTask({ id: "t2", contextId: "c2", reason: "model not loaded", now: "2026-06-28T00:00:00Z" });
    expect(t.status.state).toBe("failed");
    expect(t.status.message?.parts[0].text).toBe("model not loaded");
    expect(t.artifacts).toEqual([]);
  });
});
