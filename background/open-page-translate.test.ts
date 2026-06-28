import { describe, it, expect } from "vitest";
import { translateEventToPublic, extractRequestId } from "./open-page-translate";
import { DIVINCI_PUBLIC_NS } from "@/shared/public-api";
import type { DivinciExternalEvent } from "@/shared/messages";

describe("translateEventToPublic", () => {
  it("maps chat-token", () => {
    const ev: DivinciExternalEvent = { type: "divinci:chat-token", requestId: "r1", delta: "hi" };
    expect(translateEventToPublic("r1", ev)).toEqual({ __ns: DIVINCI_PUBLIC_NS, id: "r1", op: "chat-token", delta: "hi" });
  });

  it("maps chat-done with metrics", () => {
    const ev: DivinciExternalEvent = {
      type: "divinci:chat-done",
      requestId: "r1",
      fullText: "answer",
      tokensGenerated: 5,
      durationMs: 100,
    };
    expect(translateEventToPublic("r1", ev)).toMatchObject({
      op: "chat-done",
      fullText: "answer",
      tokensGenerated: 5,
      durationMs: 100,
    });
  });

  it("maps aborted + error", () => {
    expect(translateEventToPublic("r1", { type: "divinci:aborted", requestId: "r1" })?.op).toBe("aborted");
    const err = translateEventToPublic("r1", { type: "divinci:error", requestId: "r1", message: "boom", fatal: true });
    expect(err).toMatchObject({ op: "error", message: "boom", code: "runtime", fatal: true });
  });

  it("drops internal-only events (load/queue/tool-status) → null", () => {
    expect(translateEventToPublic("r1", { type: "divinci:load-progress", requestId: "r1", fraction: 0.5, bytesLoaded: 1, bytesTotal: 2 })).toBeNull();
    expect(translateEventToPublic("r1", { type: "divinci:load-done", requestId: "r1", loadTimeMs: 1 })).toBeNull();
    expect(translateEventToPublic("r1", { type: "divinci:queued", requestId: "r1", position: 1 })).toBeNull();
    expect(translateEventToPublic("r1", { type: "divinci:tool-status", requestId: "r1", status: "routing", calls: [] })).toBeNull();
  });

  it("never leaks a non-public op shape (every result is namespaced)", () => {
    const ev: DivinciExternalEvent = { type: "divinci:chat-token", requestId: "r1", delta: "x" };
    const out = translateEventToPublic("r1", ev);
    expect(out?.__ns).toBe(DIVINCI_PUBLIC_NS);
  });
});

describe("extractRequestId", () => {
  it("pulls requestId, defaults to empty string", () => {
    expect(extractRequestId({ type: "divinci:aborted", requestId: "abc" })).toBe("abc");
    expect(extractRequestId({ type: "divinci:pong", extensionVersion: "1", supportedModels: [] } as unknown as DivinciExternalEvent)).toBe("");
  });
});
