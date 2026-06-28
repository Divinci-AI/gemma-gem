/**
 * Open-page bridge (SW side) — the any-website programmatic API channel.
 *
 * The ISOLATED-world relay content script (entrypoints/divinci-api-bridge) opens
 * an internal port named OPEN_PAGE_PORT and forwards the page's PublicRequests.
 * Because this is chrome.runtime.onConnect (NOT onConnectExternal), the port can
 * only come from THIS extension's own content script, so:
 *   - the page origin is `port.sender`'s browser-set origin (unspoofable), and
 *   - a `requestAccess` op is a user-approved grant commit (the relay only sends
 *     it after a click on its own shadow-DOM banner).
 *
 * Authorization is the pure `gateOpenPageRequest` (tested separately); this file
 * is the chrome glue: grant-map cache, offscreen forwarding, and translating the
 * internal DivinciExternalEvent stream into the public protocol the page speaks.
 */

import { ensureOffscreenDocument } from "./offscreen-manager";
import { MODELS, ALLOWED_WEB_APP_ORIGINS, type ModelId } from "@/shared/models";
import { log } from "@/shared/logger";
import {
  STORAGE_KEY_ORIGIN_GRANTS,
  grantScopes,
  grantedScopes,
  sanitizeGrantMap,
  type GrantMap,
} from "@/shared/origin-consent";
import { STORAGE_KEY_SITE_CONFIGS, parseReleaseConfig } from "@/shared/release-config";
import {
  DIVINCI_PUBLIC_NS,
  DIVINCI_PUBLIC_PROTOCOL_VERSION,
  OPEN_PAGE_PORT,
  isPublicRequest,
  type PublicRequest,
  type PublicResponse,
} from "@/shared/public-api";
import { gateOpenPageRequest } from "./open-page-gate";
import { translateEventToPublic, extractRequestId } from "./open-page-translate";
import { buildLocalAgentCard, buildCompletedTask, buildFailedTask } from "@/shared/a2a-local";
import type { InternalRequest, InternalEvent, Message } from "@/shared/messages";

interface CallerEntry {
  port: chrome.runtime.Port;
  origin: string;
}

const callers = new Map<string, CallerEntry>();
let nextCallerSeq = 0;

/** In-memory grant cache; refreshed from chrome.storage on change. */
let grantCache: GrantMap = {};

/**
 * Request ids currently running as A2A tasks (op a2a.task). A2A is non-streaming
 * over the bridge: tokens are suppressed and the terminal event is wrapped into
 * a single A2A Task. requestId → contextId.
 */
const taskRequests = new Map<string, string>();

function defaultModelId(): ModelId {
  return Object.keys(MODELS)[0] as ModelId;
}

function originOf(port: chrome.runtime.Port): string | undefined {
  // Prefer the explicit origin Chrome sets on content-script senders; fall back
  // to deriving it from the tab URL.
  const s = port.sender;
  if (s?.origin) return s.origin;
  if (s?.url) {
    try {
      return new URL(s.url).origin;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function postPublic(port: chrome.runtime.Port, msg: PublicResponse): void {
  try {
    port.postMessage(msg);
  } catch (e) {
    log.warn("open-page postPublic threw — port likely closed", e);
  }
}

async function persistGrants(next: GrantMap): Promise<void> {
  grantCache = next;
  await chrome.storage.local.set({ [STORAGE_KEY_ORIGIN_GRANTS]: next });
}

async function handleRequest(caller: string, port: chrome.runtime.Port, req: PublicRequest): Promise<void> {
  const origin = originOf(port);
  const action = gateOpenPageRequest({
    req,
    origin,
    grants: grantCache,
    trustedOrigins: ALLOWED_WEB_APP_ORIGINS,
  });

  switch (action.kind) {
    case "pong": {
      const manifest = chrome.runtime.getManifest();
      postPublic(port, {
        __ns: DIVINCI_PUBLIC_NS,
        id: req.id,
        op: "pong",
        protocolVersion: DIVINCI_PUBLIC_PROTOCOL_VERSION,
        extensionVersion: manifest.version,
        supportedModels: Object.keys(MODELS),
      });
      return;
    }

    case "reply-error":
      postPublic(port, {
        __ns: DIVINCI_PUBLIC_NS,
        id: req.id,
        op: "error",
        message: action.message,
        code: action.code,
        fatal: false,
      });
      return;

    case "commit-grant": {
      if (origin) {
        const next = grantScopes(grantCache, origin, action.scopes, Date.now());
        await persistGrants(next);
        postPublic(port, {
          __ns: DIVINCI_PUBLIC_NS,
          id: req.id,
          op: "access-result",
          grantedScopes: grantedScopes(next, origin),
        });
      } else {
        postPublic(port, {
          __ns: DIVINCI_PUBLIC_NS,
          id: req.id,
          op: "access-result",
          grantedScopes: [],
        });
      }
      return;
    }

    case "abort": {
      const internal: InternalRequest = { type: "internal:abort", requestId: req.id, caller };
      chrome.runtime.sendMessage(internal as Message).catch((e) => log.warn("open-page abort forward failed:", e));
      return;
    }

    case "forward-config": {
      if (req.op !== "configure" || !origin) {
        postPublic(port, { __ns: DIVINCI_PUBLIC_NS, id: req.id, op: "configure-result", applied: null });
        return;
      }
      const applied = parseReleaseConfig(req.config);
      // Read-modify-write the per-origin config map. null applied → clear this
      // origin's config (a site can reset by sending an empty/garbage config).
      const stored = await chrome.storage.local.get(STORAGE_KEY_SITE_CONFIGS);
      const map = (stored[STORAGE_KEY_SITE_CONFIGS] as Record<string, unknown>) ?? {};
      if (applied) map[origin] = applied;
      else delete map[origin];
      await chrome.storage.local.set({ [STORAGE_KEY_SITE_CONFIGS]: map });
      postPublic(port, { __ns: DIVINCI_PUBLIC_NS, id: req.id, op: "configure-result", applied });
      return;
    }

    case "agent-card": {
      const manifest = chrome.runtime.getManifest();
      postPublic(port, {
        __ns: DIVINCI_PUBLIC_NS,
        id: req.id,
        op: "a2a-card",
        card: buildLocalAgentCard({ extensionVersion: manifest.version, supportedModels: Object.keys(MODELS) }),
      });
      return;
    }

    case "forward-task": {
      if (req.op !== "a2a.task") return;
      await ensureOffscreenDocument();
      taskRequests.set(req.id, `ctx-${req.id}`);
      const internal: InternalRequest = {
        type: "internal:chat",
        requestId: req.id,
        modelId: defaultModelId(),
        caller,
        messages: [{ role: "user", content: req.prompt }],
      };
      chrome.runtime.sendMessage(internal as Message).catch((e) => {
        taskRequests.delete(req.id);
        postPublic(port, {
          __ns: DIVINCI_PUBLIC_NS,
          id: req.id,
          op: "a2a-task",
          task: buildFailedTask({ id: req.id, contextId: `ctx-${req.id}`, reason: `Failed to start task: ${(e as Error).message}`, now: new Date().toISOString() }),
        });
      });
      return;
    }

    case "forward": {
      if (req.op !== "chat") return; // only chat forwards in v1
      await ensureOffscreenDocument();
      const internal: InternalRequest = {
        type: "internal:chat",
        requestId: req.id,
        modelId: defaultModelId(),
        caller,
        messages: req.messages,
        maxNewTokens: req.maxNewTokens,
        temperature: req.temperature,
        topP: req.topP,
        // No `tools`: see PublicChatRequest. Omitting tools means the offscreen
        // parses no tool-calls → finalize-chat never routes to the account/CF
        // path → arbitrary origins get pure on-device inference only.
      };
      chrome.runtime.sendMessage(internal as Message).catch((e) => {
        log.error("open-page chat forward failed:", e);
        postPublic(port, {
          __ns: DIVINCI_PUBLIC_NS,
          id: req.id,
          op: "error",
          message: `Failed to forward chat: ${(e as Error).message}`,
          code: "runtime",
          fatal: false,
        });
      });
      return;
    }
  }
}

export function setupOpenPageBridge(): void {
  // Hydrate the grant cache; keep it fresh across SW evictions + popup revokes.
  chrome.storage.local
    .get(STORAGE_KEY_ORIGIN_GRANTS)
    .then((s) => {
      grantCache = sanitizeGrantMap(s[STORAGE_KEY_ORIGIN_GRANTS]);
    })
    .catch((e) => log.warn("open-page grant hydrate failed:", e));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY_ORIGIN_GRANTS]) {
      grantCache = sanitizeGrantMap(changes[STORAGE_KEY_ORIGIN_GRANTS].newValue);
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== OPEN_PAGE_PORT) return; // internal-bridge owns its own names

    const origin = originOf(port);
    nextCallerSeq += 1;
    const caller = `op${nextCallerSeq}-${origin ?? "unknown"}`;
    callers.set(caller, { port, origin: origin ?? "unknown" });
    log.info("Open-page port connected:", caller);

    port.onMessage.addListener((msg: unknown) => {
      if (!isPublicRequest(msg)) {
        log.warn("open-page: dropping non-public message");
        return;
      }
      void handleRequest(caller, port, msg);
    });

    port.onDisconnect.addListener(() => {
      callers.delete(caller);
      chrome.runtime
        .sendMessage({ type: "internal:abort", requestId: "*", caller } as InternalRequest as Message)
        .catch(() => {});
    });
  });

  // Route offscreen events back to the originating port, translated to public.
  chrome.runtime.onMessage.addListener((msg: InternalEvent) => {
    if (msg?.type !== "internal:event") return;
    const entry = callers.get(msg.caller);
    if (!entry) return;
    const id = extractRequestId(msg.event);

    // A2A task: collapse the streamed chat into a single terminal Task.
    if (taskRequests.has(id)) {
      const contextId = taskRequests.get(id)!;
      const now = new Date().toISOString();
      const ev = msg.event;
      if (ev.type === "divinci:chat-done") {
        taskRequests.delete(id);
        postPublic(entry.port, {
          __ns: DIVINCI_PUBLIC_NS,
          id,
          op: "a2a-task",
          task: buildCompletedTask({ id, contextId, text: ev.fullText, now }),
        });
      } else if (ev.type === "divinci:error") {
        taskRequests.delete(id);
        postPublic(entry.port, {
          __ns: DIVINCI_PUBLIC_NS,
          id,
          op: "a2a-task",
          task: buildFailedTask({ id, contextId, reason: ev.message, now }),
        });
      } else if (ev.type === "divinci:aborted") {
        taskRequests.delete(id);
        postPublic(entry.port, {
          __ns: DIVINCI_PUBLIC_NS,
          id,
          op: "a2a-task",
          task: buildFailedTask({ id, contextId, reason: "aborted", now }),
        });
      }
      // chat-token + load/queue events are suppressed for tasks.
      return;
    }

    const pub = translateEventToPublic(id, msg.event);
    if (pub) postPublic(entry.port, pub);
  });
}
