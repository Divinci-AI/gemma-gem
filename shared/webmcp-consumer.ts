/**
 * WebMCP consumer (Phase 3b of the divinci-ai/server browser-AI/agent-interop
 * program). Lets the extension's Gemma agent discover + call the WebMCP tools a
 * visited page registers — strictly better than DOM-scraping.
 *
 * Page-registered WebMCP tools live on the page's `document.modelContext` /
 * `navigator.modelContext`, which is in the page's MAIN world. A content script
 * runs in an ISOLATED world and cannot see those page-JS-assigned properties,
 * so the consumer bridges to a tiny MAIN-world script via postMessage. This
 * module is that bridge's transport-agnostic protocol core — `PageWebMcpBridge`
 * takes an injected transport (window.postMessage + 'message' listener in
 * production; a fake in tests), so the protocol is fully unit-testable without a
 * real page. The MAIN-world injection itself (chrome.scripting.executeScript
 * `world: "MAIN"`) is a thin wrapper that speaks this protocol.
 */

/** postMessage namespace tag so we ignore unrelated page messages. */
export const WEBMCP_BRIDGE_NS = "divinci-webmcp-bridge";

/** Tool metadata the page exposes (no executor — calls go back over the bridge). */
export interface PageToolMeta {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

type BridgeRequest =
  | { __ns: typeof WEBMCP_BRIDGE_NS; id: string; op: "list" }
  | { __ns: typeof WEBMCP_BRIDGE_NS; id: string; op: "call"; name: string; input: Record<string, unknown> };

type BridgeResponse =
  | { __ns: typeof WEBMCP_BRIDGE_NS; id: string; op: "list-result"; tools: PageToolMeta[] }
  | { __ns: typeof WEBMCP_BRIDGE_NS; id: string; op: "call-result"; ok: true; result: unknown }
  | { __ns: typeof WEBMCP_BRIDGE_NS; id: string; op: "call-result"; ok: false; error: string };

/** Injected transport: post a request to the MAIN world + subscribe to replies. */
export interface BridgeTransport {
  post: (msg: BridgeRequest) => void;
  /** Register a reply handler; returns an unsubscribe fn. */
  subscribe: (handler: (msg: unknown) => void) => () => void;
}

export interface BridgeOptions {
  timeoutMs?: number;
  /** Deterministic id generator for tests (default: monotonic counter). */
  idgen?: () => string;
}

function isResponse(msg: unknown): msg is BridgeResponse {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { __ns?: unknown }).__ns === WEBMCP_BRIDGE_NS &&
    typeof (msg as { id?: unknown }).id === "string"
  );
}

/**
 * Speaks the bridge protocol to a page's MAIN-world WebMCP shim. Correlates
 * requests/responses by id and times out so a missing/broken page can't hang
 * the agent. Never throws on construction.
 */
export class PageWebMcpBridge {
  private readonly timeoutMs: number;
  private readonly nextId: () => string;
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;

  constructor(private readonly transport: BridgeTransport, opts: BridgeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    let counter = 0;
    this.nextId = opts.idgen ?? (() => `req_${++counter}`);
    this.unsubscribe = transport.subscribe((msg) => this.onMessage(msg));
  }

  private onMessage(msg: unknown): void {
    if (!isResponse(msg)) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.op === "list-result") {
      entry.resolve(msg.tools);
    } else if (msg.op === "call-result") {
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    }
  }

  private request<T>(req: BridgeRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("bridge disposed"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`WebMCP bridge timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(req.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.transport.post(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** List the page's registered WebMCP tools. Returns [] is the page's job; a
   * missing page surfaces as a timeout rejection. */
  listTools(): Promise<PageToolMeta[]> {
    return this.request<PageToolMeta[]>({ __ns: WEBMCP_BRIDGE_NS, id: this.nextId(), op: "list" });
  }

  /** Invoke a page tool by name; resolves with its result or rejects on error. */
  callTool(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    return this.request<unknown>({
      __ns: WEBMCP_BRIDGE_NS,
      id: this.nextId(),
      op: "call",
      name,
      input,
    });
  }

  /** Tear down: unsubscribe + reject any in-flight requests. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("bridge disposed"));
    }
    this.pending.clear();
  }
}
