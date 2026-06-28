/**
 * WebMCP EXPOSE — the inverse of webmcp-consumer.ts. Registers the extension's
 * capabilities (on-device chat) into the PAGE's WebMCP surface so a browser
 * agent visiting that page can drive Divinci as a tool, not just the page's own
 * tools.
 *
 * The WebMCP spec is unsettled on two axes, so this is deliberately tolerant:
 *   - Namespace: `navigator.modelContext` (Chrome docs) vs `document.modelContext`
 *     (W3C draft). We probe both.
 *   - Method: `registerTool(tool)` (returns a disposable / unregister fn) vs
 *     `provideContext({tools})` (declarative, replace-all). We use whichever
 *     exists.
 * Unsupported / absent → a safe no-op returning an inert unregister. Never
 * throws, so wiring it unconditionally behind a flag can't break a page.
 *
 * Pure: takes the modelContext object + the chat executor as arguments (the
 * MAIN-world script supplies the real ones; tests supply fakes), so the
 * registration logic is fully unit-testable without a browser.
 */

/** Minimal shape of a WebMCP tool registration, spanning both draft method styles. */
export interface WebMcpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** The page's model-context object, in either draft shape. */
export interface ModelContextLike {
  registerTool?: (tool: WebMcpToolDef) => { unregister?: () => void } | (() => void) | void;
  provideContext?: (ctx: { tools: WebMcpToolDef[] }) => void;
}

/**
 * Resolve the page's modelContext from either namespace, or null if absent.
 * Params are `unknown` because the real callers pass `window.navigator` /
 * `window.document` (whose lib.dom types don't yet declare `modelContext`).
 */
export function resolveModelContext(globals: { navigator?: unknown; document?: unknown }): ModelContextLike | null {
  const nav = (globals.navigator as { modelContext?: unknown } | undefined)?.modelContext;
  if (nav && typeof nav === "object") return nav as ModelContextLike;
  const doc = (globals.document as { modelContext?: unknown } | undefined)?.modelContext;
  if (doc && typeof doc === "object") return doc as ModelContextLike;
  return null;
}

/** True when the page exposes a usable WebMCP registration surface. */
export function isWebMcpExposeSupported(ctx: ModelContextLike | null): boolean {
  if (!ctx) return false;
  return typeof ctx.registerTool === "function" || typeof ctx.provideContext === "function";
}

export type ChatExecutor = (req: {
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ fullText: string }>;

/** Build the Divinci tool definitions exposed to the page's agent. */
export function buildDivinciTools(chat: ChatExecutor): WebMcpToolDef[] {
  return [
    {
      name: "divinci_local_chat",
      description:
        "Run a prompt through Divinci's on-device AI model (private, no server round-trip). " +
        "Returns the model's text response.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The user prompt to answer." },
        },
        required: ["prompt"],
      },
      async execute(input) {
        const prompt = typeof input?.prompt === "string" ? input.prompt : "";
        if (!prompt) {
          return { content: [{ type: "text", text: "Error: 'prompt' is required." }] };
        }
        const res = await chat({ messages: [{ role: "user", content: prompt }] });
        return { content: [{ type: "text", text: res.fullText }] };
      },
    },
  ];
}

/**
 * Register Divinci's tools into the page's modelContext. Returns an unregister
 * function (idempotent). No-ops safely when the surface is unsupported.
 */
export function exposeDivinciTools(ctx: ModelContextLike | null, chat: ChatExecutor): () => void {
  if (!isWebMcpExposeSupported(ctx) || !ctx) return () => {};
  const tools = buildDivinciTools(chat);

  // Prefer registerTool (per-tool disposable). Fall back to provideContext.
  if (typeof ctx.registerTool === "function") {
    const disposers: Array<() => void> = [];
    for (const tool of tools) {
      try {
        const handle = ctx.registerTool(tool);
        if (typeof handle === "function") disposers.push(handle);
        else if (handle && typeof handle.unregister === "function") disposers.push(() => handle.unregister!());
      } catch {
        /* a single tool failing to register must not break the rest */
      }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    };
  }

  // provideContext is replace-all; unregister clears it back to no tools.
  try {
    ctx.provideContext!({ tools });
  } catch {
    return () => {};
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      ctx.provideContext!({ tools: [] });
    } catch {
      /* ignore */
    }
  };
}
