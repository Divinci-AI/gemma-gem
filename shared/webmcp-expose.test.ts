import { describe, it, expect, vi } from "vitest";
import {
  resolveModelContext,
  isWebMcpExposeSupported,
  buildDivinciTools,
  exposeDivinciTools,
  type ModelContextLike,
  type WebMcpToolDef,
} from "./webmcp-expose";

const chat = async () => ({ fullText: "hello from gemma" });

describe("resolveModelContext", () => {
  it("prefers navigator.modelContext", () => {
    const nav = { registerTool: () => {} };
    expect(resolveModelContext({ navigator: { modelContext: nav } })).toBe(nav);
  });
  it("falls back to document.modelContext", () => {
    const doc = { provideContext: () => {} };
    expect(resolveModelContext({ document: { modelContext: doc } })).toBe(doc);
  });
  it("returns null when neither present", () => {
    expect(resolveModelContext({})).toBeNull();
    expect(resolveModelContext({ navigator: {} })).toBeNull();
  });
});

describe("isWebMcpExposeSupported", () => {
  it("true for registerTool or provideContext", () => {
    expect(isWebMcpExposeSupported({ registerTool: () => {} })).toBe(true);
    expect(isWebMcpExposeSupported({ provideContext: () => {} })).toBe(true);
  });
  it("false for null / empty object", () => {
    expect(isWebMcpExposeSupported(null)).toBe(false);
    expect(isWebMcpExposeSupported({})).toBe(false);
  });
});

describe("buildDivinciTools", () => {
  it("exposes divinci_local_chat with a prompt schema", () => {
    const [tool] = buildDivinciTools(chat);
    expect(tool.name).toBe("divinci_local_chat");
    expect(tool.inputSchema.required).toEqual(["prompt"]);
  });

  it("execute routes the prompt to chat and wraps the text", async () => {
    const [tool] = buildDivinciTools(chat);
    const out = await tool.execute({ prompt: "hi" });
    expect(out).toEqual({ content: [{ type: "text", text: "hello from gemma" }] });
  });

  it("execute errors on missing prompt without calling chat", async () => {
    const spy = vi.fn(chat);
    const [tool] = buildDivinciTools(spy);
    const out = await tool.execute({});
    expect(out.content[0].text).toMatch(/required/i);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("exposeDivinciTools", () => {
  it("no-ops (inert unregister) when unsupported", () => {
    const un = exposeDivinciTools(null, chat);
    expect(typeof un).toBe("function");
    expect(() => un()).not.toThrow();
  });

  it("uses registerTool and unregisters via returned fn", () => {
    const unregister = vi.fn();
    const registerTool = vi.fn((_t: WebMcpToolDef) => unregister);
    const ctx: ModelContextLike = { registerTool };
    const un = exposeDivinciTools(ctx, chat);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect((registerTool.mock.calls[0][0] as WebMcpToolDef).name).toBe("divinci_local_chat");
    un();
    expect(unregister).toHaveBeenCalledTimes(1);
    un(); // idempotent
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("uses registerTool disposable-object shape", () => {
    const unregister = vi.fn();
    const ctx: ModelContextLike = { registerTool: () => ({ unregister }) };
    exposeDivinciTools(ctx, chat)();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("falls back to provideContext and clears on unregister", () => {
    const provideContext = vi.fn((_c: { tools: WebMcpToolDef[] }) => {});
    const ctx: ModelContextLike = { provideContext };
    const un = exposeDivinciTools(ctx, chat);
    expect(provideContext).toHaveBeenCalledTimes(1);
    expect(provideContext.mock.calls[0][0].tools).toHaveLength(1);
    un();
    expect(provideContext).toHaveBeenLastCalledWith({ tools: [] });
  });

  it("survives a tool that throws on registration", () => {
    const ctx: ModelContextLike = {
      registerTool: () => {
        throw new Error("boom");
      },
    };
    expect(() => exposeDivinciTools(ctx, chat)()).not.toThrow();
  });
});
