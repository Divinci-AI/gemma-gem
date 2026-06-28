/**
 * PUBLIC programmatic API protocol — the `window.divinci` surface any website
 * can call (Phase 1 of the open-extension program; see the server repo's
 * strategy/2026-06-28-extension-open-programmatic-api.md).
 *
 * Unlike the first-party `DivinciExternal*` protocol (web app ↔ extension over
 * externally_connectable, which can't be wildcarded), this protocol travels the
 * content-script MAIN↔ISOLATED-world postMessage bridge so it reaches ANY
 * origin. Every message is namespace-tagged (`__ns: DIVINCI_PUBLIC_NS`) so the
 * bridge ignores unrelated page chatter, and every inbound request is
 * authorized by the per-origin consent core (`origin-consent.ts`) before the SW
 * touches the model.
 *
 * This module is the transport-agnostic protocol CORE only: the envelope types,
 * type guards, and the op→scope authorization map. The MAIN-world injection,
 * the content-script relay, and the SW gate are thin glue that speak it.
 */

import type { ConsentScope } from "./origin-consent";
import type { ChatToolCall } from "./messages";

/** postMessage namespace tag — distinct from the WebMCP-consumer bridge NS. */
export const DIVINCI_PUBLIC_NS = "divinci-public-api";

/**
 * Control channel namespace — MAIN↔ISOLATED config push (NOT page-facing). The
 * ISOLATED relay reads extension settings the MAIN world can't (chrome.storage)
 * and pushes them to MAIN: currently whether WebMCP-expose is enabled.
 */
export const DIVINCI_CONTROL_NS = "divinci-public-control";

/** chrome.storage.local flag gating the experimental WebMCP-expose surface. */
export const STORAGE_KEY_WEBMCP_EXPOSE = "divinci-experimental-webmcp";

export interface ControlConfig {
  __ns: typeof DIVINCI_CONTROL_NS;
  op: "config";
  webmcpExpose: boolean;
}

export interface ControlGetConfig {
  __ns: typeof DIVINCI_CONTROL_NS;
  op: "get-config";
}

/**
 * chrome.runtime.connect port name the ISOLATED-world relay opens to the SW.
 * Uses onConnect (NOT onConnectExternal) so the port is guaranteed to come from
 * THIS extension's own content script — the SW trusts the relayed page origin
 * (browser-set on `port.sender`) and the user-approved grant commits.
 */
export const OPEN_PAGE_PORT = "divinci-open-page";

/** Protocol version, surfaced by `ping` so an SDK can feature-detect. */
export const DIVINCI_PUBLIC_PROTOCOL_VERSION = 1;

// ---- Request ops (page → extension) ----------------------------------------

export type PublicOp =
  | "ping"
  | "requestAccess"
  | "chat"
  | "abort"
  // Reserved for later phases — declared now so the scope map + SDK are stable.
  | "webmcp.list"
  | "webmcp.call"
  | "a2a.card"
  | "a2a.task";

/**
 * Authorization map: which consent scope each op requires. `null` means the op
 * is unauthenticated (safe for any origin without a grant) — `ping` exposes only
 * version/model metadata, and `requestAccess` IS the grant flow so it can't
 * require a pre-existing grant. Everything that touches the model/agent requires
 * a scope. The SW gate reads THIS map — never trust an op's self-declared scope.
 */
export const OP_REQUIRED_SCOPE: Record<PublicOp, ConsentScope | null> = {
  ping: null,
  requestAccess: null,
  chat: "chat",
  abort: null, // aborting your own in-flight request needs no standing grant
  "webmcp.list": "webmcp",
  "webmcp.call": "webmcp",
  "a2a.card": null, // the signed Agent Card is public metadata
  "a2a.task": "a2a",
};

export function requiredScopeForOp(op: PublicOp): ConsentScope | null {
  return OP_REQUIRED_SCOPE[op] ?? null;
}

interface BaseRequest {
  __ns: typeof DIVINCI_PUBLIC_NS;
  /** Correlates streamed responses to the call. Page-generated, opaque. */
  id: string;
  op: PublicOp;
}

export interface PublicPingRequest extends BaseRequest {
  op: "ping";
}

export interface PublicRequestAccessRequest extends BaseRequest {
  op: "requestAccess";
  scopes: ConsentScope[];
}

export interface PublicChatRequest extends BaseRequest {
  op: "chat";
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  // SECURITY: the open API deliberately has NO `tools` field. Forwarding tools
  // would let an arbitrary granted origin trigger Gemma tool-calls, which the
  // offscreen routes through the user's Divinci account (server-held keys,
  // billed) or local CF/Brave/Serper keys (finalize-chat.ts). "chat" consent
  // means on-device inference only — never the user's account/keys. First-party
  // tool-routing flows through the separate externally_connectable bridge.
}

export interface PublicAbortRequest extends BaseRequest {
  op: "abort";
}

export interface PublicA2ACardRequest extends BaseRequest {
  op: "a2a.card";
}

export interface PublicA2ATaskRequest extends BaseRequest {
  op: "a2a.task";
  /** The task prompt (wrapped into an A2A text message internally). */
  prompt: string;
}

export type PublicRequest =
  | PublicPingRequest
  | PublicRequestAccessRequest
  | PublicChatRequest
  | PublicAbortRequest
  | PublicA2ACardRequest
  | PublicA2ATaskRequest;

// ---- Responses / events (extension → page) ---------------------------------

export interface PublicPongResponse {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "pong";
  protocolVersion: number;
  extensionVersion: string;
  supportedModels: string[];
}

/** Result of a requestAccess flow (user allowed/denied the prompt). */
export interface PublicAccessResultResponse {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "access-result";
  /** Scopes now held by this origin after the prompt (may be a subset). */
  grantedScopes: ConsentScope[];
}

export interface PublicChatTokenEvent {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "chat-token";
  delta: string;
}

export interface PublicChatDoneEvent {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "chat-done";
  fullText: string;
  tokensGenerated: number;
  durationMs: number;
  toolCalls?: ChatToolCall[];
}

export interface PublicAbortedEvent {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "aborted";
}

export interface PublicErrorEvent {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "error";
  message: string;
  /** Set when the request was refused at the consent gate (vs a runtime error). */
  code?: "denied" | "needs-grant" | "invalid-request" | "busy" | "runtime";
  fatal: boolean;
}

export interface PublicA2ACardResponse {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "a2a-card";
  /** A2AAgentCard (see shared/a2a-local.ts). Kept as unknown here to avoid a cycle. */
  card: unknown;
}

export interface PublicA2ATaskResponse {
  __ns: typeof DIVINCI_PUBLIC_NS;
  id: string;
  op: "a2a-task";
  /** A2ATask (see shared/a2a-local.ts). */
  task: unknown;
}

export type PublicResponse =
  | PublicPongResponse
  | PublicAccessResultResponse
  | PublicChatTokenEvent
  | PublicChatDoneEvent
  | PublicAbortedEvent
  | PublicErrorEvent
  | PublicA2ACardResponse
  | PublicA2ATaskResponse;

// ---- Type guards (used by the bridge to filter page postMessage noise) ------

const VALID_OPS: ReadonlySet<string> = new Set<PublicOp>([
  "ping",
  "requestAccess",
  "chat",
  "abort",
  "webmcp.list",
  "webmcp.call",
  "a2a.card",
  "a2a.task",
]);

/** True for a well-formed, namespace-tagged public request envelope. */
export function isPublicRequest(msg: unknown): msg is PublicRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.__ns === DIVINCI_PUBLIC_NS &&
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.op === "string" &&
    VALID_OPS.has(m.op)
  );
}

/**
 * The `window.divinci` object shape an injected page sees. (Declared here for
 * the SDK + the MAIN-world injector to share; not used by the protocol core
 * itself.) Streaming is delivered via the `onToken` callback; the promise
 * resolves with the final text.
 */
export interface DivinciPublicApi {
  readonly protocolVersion: number;
  /** Probe the extension; resolves with version + supported models. */
  ping(): Promise<{ extensionVersion: string; supportedModels: string[] }>;
  /** Trigger the consent prompt for the given scopes; resolves with what was granted. */
  requestAccess(scopes: ConsentScope[]): Promise<ConsentScope[]>;
  /** Run a local-inference chat. Requires the `chat` scope (prompts if absent). */
  chat(
    req: Omit<PublicChatRequest, "__ns" | "id" | "op">,
    handlers?: { onToken?: (delta: string) => void; signal?: AbortSignal },
  ): Promise<{ fullText: string; tokensGenerated: number; durationMs: number; toolCalls?: ChatToolCall[] }>;
  /** Fetch the local agent's A2A Agent Card (public metadata, no grant needed). */
  agentCard(): Promise<unknown>;
  /** Submit an A2A task (prompt) to the local agent. Requires the `a2a` scope. */
  task(prompt: string): Promise<unknown>;
}
