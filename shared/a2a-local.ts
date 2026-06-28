/**
 * A2A (Agent-to-Agent) surface for the in-browser local agent — the heaviest of
 * the three open surfaces, for when a visiting website ALSO has an agent and
 * wants to delegate to Divinci's on-device model.
 *
 * These shapes MIRROR the spec-validated server core at
 * `workspace/resources/server-resources/src/a2a/` (agent-card.ts / task.ts),
 * which was field-checked against `@a2a-js/sdk` types. They can't be imported
 * cross-repo (the server package isn't published), so they're reproduced here
 * wire-compatibly. Keep them in sync if the server core's shapes change.
 *
 * SIGNING: the TrustBench Ed25519 platform key is server-side only (Infisical) —
 * the extension never holds it. So the LOCAL card is served unsigned; an
 * optional `signatures` array is carried verbatim when the SW has fetched a
 * server-signed card for the active release (account mode). Unsigned local +
 * optionally-signed server-fetched is the honest split.
 *
 * Pure (no chrome.*, deterministic given `now`) so it's fully unit-testable.
 */

export const A2A_PROTOCOL_VERSION = "0.3.0";

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** Logical endpoint — for the in-browser agent this is the bridge namespace. */
  url: string;
  version: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  /** Present only when a server-signed card was fetched; omitted for the local card. */
  signatures?: Array<{ protected: string; signature: string }>;
}

export interface A2ATextPart {
  kind: "text";
  text: string;
}

export interface A2AArtifact {
  artifactId: string;
  parts: A2ATextPart[];
}

export interface A2AMessage {
  kind: "message";
  role: "agent" | "user";
  parts: A2ATextPart[];
  messageId: string;
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: "completed" | "failed"; timestamp?: string; message?: A2AMessage };
  artifacts: A2AArtifact[];
  history: A2AMessage[];
}

/** Build the local agent's (unsigned) Agent Card. `extensionVersion` → card version. */
export function buildLocalAgentCard(opts: {
  extensionVersion: string;
  supportedModels: string[];
  url?: string;
}): A2AAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Divinci Local Agent",
    description:
      "On-device AI agent running in the user's browser via the Divinci extension (WebGPU). " +
      "Private inference — prompts never leave the device.",
    url: opts.url ?? "webext:divinci-local-agent",
    version: opts.extensionVersion,
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "local-chat",
        name: "On-device chat",
        description: `Answer prompts with the local model${
          opts.supportedModels.length ? ` (${opts.supportedModels.join(", ")})` : ""
        }.`,
        tags: ["chat", "on-device", "private"],
      },
    ],
  };
}

/** Extract the user's prompt text from an inbound A2A message (parts → joined text). */
export function extractTaskPrompt(message: unknown): string {
  const parts = (message as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is A2ATextPart => !!p && (p as { kind?: unknown }).kind === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Build a completed Task carrying the model's text as a single artifact. */
export function buildCompletedTask(args: {
  id: string;
  contextId: string;
  text: string;
  now: string;
}): A2ATask {
  return {
    kind: "task",
    id: args.id,
    contextId: args.contextId,
    status: { state: "completed", timestamp: args.now },
    artifacts: [{ artifactId: `${args.id}-artifact-0`, parts: [{ kind: "text", text: args.text }] }],
    history: [],
  };
}

/** Build a failed Task whose status message carries the error reason. */
export function buildFailedTask(args: { id: string; contextId: string; reason: string; now: string }): A2ATask {
  return {
    kind: "task",
    id: args.id,
    contextId: args.contextId,
    status: {
      state: "failed",
      timestamp: args.now,
      message: { kind: "message", role: "agent", messageId: `${args.id}-err`, parts: [{ kind: "text", text: args.reason }] },
    },
    artifacts: [],
    history: [],
  };
}
