/**
 * WebMCP consumer bridge protocol tests (Phase 3b). A fake transport stands in
 * for the MAIN-world shim: requests posted by the bridge are answered by a
 * scripted responder, exercising correlation, results, errors, and timeout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PageWebMcpBridge,
  WEBMCP_BRIDGE_NS,
  type BridgeTransport,
  type PageToolMeta,
} from "./webmcp-consumer";

/** A fake MAIN-world: collects posted requests + lets the test push replies. */
function fakeTransport() {
  let handler: ((msg: unknown) => void) | null = null;
  const posted: Array<{ id: string; op: string; name?: string }> = [];
  const transport: BridgeTransport = {
    post: (msg) => {
      posted.push(msg as { id: string; op: string; name?: string });
    },
    subscribe: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return {
    transport,
    posted,
    reply: (msg: Record<string, unknown>) => handler?.({ __ns: WEBMCP_BRIDGE_NS, ...msg }),
    hasHandler: () => handler !== null,
  };
}

const TOOLS: PageToolMeta[] = [{ name: "addTodo", description: "Add a todo" }];

afterEach(() => {
  vi.useRealTimers();
});

describe("PageWebMcpBridge", () => {
  it("listTools resolves with the page's tools (id-correlated)", async () => {
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1" });
    const p = bridge.listTools();
    expect(f.posted[0]).toMatchObject({ id: "req_1", op: "list" });
    f.reply({ id: "req_1", op: "list-result", tools: TOOLS });
    await expect(p).resolves.toEqual(TOOLS);
  });

  it("callTool forwards name+input and resolves with the result", async () => {
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1" });
    const p = bridge.callTool("addTodo", { text: "milk" });
    expect(f.posted[0]).toMatchObject({ op: "call", name: "addTodo" });
    f.reply({ id: "req_1", op: "call-result", ok: true, result: "added" });
    await expect(p).resolves.toBe("added");
  });

  it("callTool rejects on an error result", async () => {
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1" });
    const p = bridge.callTool("addTodo");
    f.reply({ id: "req_1", op: "call-result", ok: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
  });

  it("ignores unrelated / mismatched-id messages", async () => {
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1" });
    const p = bridge.listTools();
    f.reply({ id: "other", op: "list-result", tools: [] }); // wrong id → ignored
    f.reply({ id: "req_1", op: "list-result", tools: TOOLS });
    await expect(p).resolves.toEqual(TOOLS);
  });

  it("times out when the page never replies", async () => {
    vi.useFakeTimers();
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1", timeoutMs: 1000 });
    const p = bridge.listTools();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("dispose() unsubscribes and rejects in-flight requests", async () => {
    const f = fakeTransport();
    const bridge = new PageWebMcpBridge(f.transport, { idgen: () => "req_1" });
    const p = bridge.callTool("addTodo");
    bridge.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(f.hasHandler()).toBe(false);
  });
});
