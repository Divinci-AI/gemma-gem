/**
 * MAIN-world content script — defines `window.divinci`, the public programmatic
 * API any website can call. Runs in the PAGE's JS world (so the page can see the
 * global) at document_start (so it exists before page scripts look for it).
 *
 * MAIN-world scripts have NO access to chrome.* — this only speaks
 * window.postMessage to the ISOLATED-world relay (divinci-api-bridge), which
 * does the privileged work. Direction is tagged `dir: "req"` (page→ext) so the
 * relay's `dir: "res"` replies never feed back into this script's own listener.
 */

import {
  DIVINCI_PUBLIC_NS,
  DIVINCI_PUBLIC_PROTOCOL_VERSION,
  DIVINCI_CONTROL_NS,
  type DivinciPublicApi,
  type PublicResponse,
} from "@/shared/public-api";
import type { ConsentScope } from "@/shared/origin-consent";
import type { ChatToolCall } from "@/shared/messages";
import { resolveModelContext, exposeDivinciTools } from "@/shared/webmcp-expose";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  allFrames: false,
  main() {
    // Don't clobber an existing global (e.g. double-injection on bfcache restore).
    if ((window as unknown as { divinci?: unknown }).divinci) return;

    let seq = 0;
    const nextId = () => `dvc_${Date.now().toString(36)}_${++seq}`;

    type ResHandler = (res: PublicResponse) => void;
    const handlers = new Map<string, ResHandler>();

    window.addEventListener("message", (e: MessageEvent) => {
      // Only accept replies from THIS window, in our namespace, tagged as responses.
      if (e.source !== window) return;
      const d = e.data as { __ns?: string; dir?: string; id?: string };
      if (!d || d.__ns !== DIVINCI_PUBLIC_NS || d.dir !== "res" || typeof d.id !== "string") return;
      handlers.get(d.id)?.(e.data as PublicResponse);
    });

    function send(req: Record<string, unknown>): void {
      window.postMessage({ __ns: DIVINCI_PUBLIC_NS, dir: "req", ...req }, window.location.origin);
    }

    /** One-shot request → single response (ping, requestAccess). */
    function once<T>(op: string, extra: Record<string, unknown>, map: (r: PublicResponse) => T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = nextId();
        handlers.set(id, (res) => {
          handlers.delete(id);
          if (res.op === "error") reject(Object.assign(new Error(res.message), { code: res.code }));
          else resolve(map(res));
        });
        send({ id, op, ...extra });
      });
    }

    const api: DivinciPublicApi = {
      protocolVersion: DIVINCI_PUBLIC_PROTOCOL_VERSION,

      ping() {
        return once("ping", {}, (r) => {
          if (r.op !== "pong") throw new Error("Unexpected ping reply");
          return { extensionVersion: r.extensionVersion, supportedModels: r.supportedModels };
        });
      },

      requestAccess(scopes: ConsentScope[]) {
        return once("requestAccess", { scopes }, (r) => {
          if (r.op !== "access-result") throw new Error("Unexpected requestAccess reply");
          return r.grantedScopes;
        });
      },

      chat(req, handlersArg = {}) {
        const run = (): Promise<{
          fullText: string;
          tokensGenerated: number;
          durationMs: number;
          toolCalls?: ChatToolCall[];
        }> =>
          new Promise((resolve, reject) => {
            const id = nextId();
            const onAbort = () => send({ id, op: "abort" });
            handlersArg.signal?.addEventListener("abort", onAbort, { once: true });
            handlers.set(id, (res) => {
              switch (res.op) {
                case "chat-token":
                  handlersArg.onToken?.(res.delta);
                  break;
                case "chat-done":
                  handlers.delete(id);
                  resolve({
                    fullText: res.fullText,
                    tokensGenerated: res.tokensGenerated,
                    durationMs: res.durationMs,
                    toolCalls: res.toolCalls,
                  });
                  break;
                case "aborted":
                  handlers.delete(id);
                  reject(Object.assign(new Error("aborted"), { code: "aborted" }));
                  break;
                case "error":
                  handlers.delete(id);
                  reject(Object.assign(new Error(res.message), { code: res.code }));
                  break;
              }
            });
            send({ id, op: "chat", ...req });
          });

        // Auto-trigger the consent prompt once on needs-grant, then retry.
        return run().catch(async (err: Error & { code?: string }) => {
          if (err.code !== "needs-grant") throw err;
          const granted = await api.requestAccess(["chat"]);
          if (!granted.includes("chat")) throw err;
          return run();
        });
      },

      agentCard() {
        return once("a2a.card", {}, (r) => {
          if (r.op !== "a2a-card") throw new Error("Unexpected agentCard reply");
          return r.card;
        });
      },

      task(prompt: string) {
        const run = () =>
          once("a2a.task", { prompt }, (r) => {
            if (r.op !== "a2a-task") throw new Error("Unexpected task reply");
            return r.task;
          });
        return run().catch(async (err: Error & { code?: string }) => {
          if (err.code !== "needs-grant") throw err;
          const granted = await api.requestAccess(["a2a"]);
          if (!granted.includes("a2a")) throw err;
          return run();
        });
      },

      configure(config: unknown) {
        const run = () =>
          once("configure", { config }, (r) => {
            if (r.op !== "configure-result") throw new Error("Unexpected configure reply");
            return r.applied;
          });
        return run().catch(async (err: Error & { code?: string }) => {
          if (err.code !== "needs-grant") throw err;
          const granted = await api.requestAccess(["configure"]);
          if (!granted.includes("configure")) throw err;
          return run();
        });
      },
    };

    Object.defineProperty(window, "divinci", { value: Object.freeze(api), configurable: false, enumerable: false });

    // ---- WebMCP expose (flag-gated) ----------------------------------------
    // Register Divinci's on-device chat as a WebMCP tool so the page's OWN agent
    // can call it. The spec namespace is unsettled, so this is best-effort +
    // gated by an extension flag the ISOLATED relay pushes over the control
    // channel (MAIN world can't read chrome.storage). Executing the tool routes
    // through window.divinci.chat → the normal per-origin `chat` consent prompt.
    let unexpose: (() => void) | null = null;
    const applyWebmcpConfig = (enabled: boolean) => {
      if (enabled && !unexpose) {
        const ctx = resolveModelContext({ navigator: window.navigator, document: window.document });
        unexpose = exposeDivinciTools(ctx, (req) => api.chat({ messages: req.messages }));
      } else if (!enabled && unexpose) {
        unexpose();
        unexpose = null;
      }
    };

    window.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data as { __ns?: string; op?: string; webmcpExpose?: boolean };
      if (!d || d.__ns !== DIVINCI_CONTROL_NS || d.op !== "config") return;
      applyWebmcpConfig(d.webmcpExpose === true);
    });
    // Ask the relay for the current config (covers the case where the relay's
    // startup push raced ahead of this listener).
    window.postMessage({ __ns: DIVINCI_CONTROL_NS, op: "get-config" }, window.location.origin);
  },
});
