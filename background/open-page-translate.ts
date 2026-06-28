/**
 * Pure translation of the internal offscreen event stream into the public
 * protocol the page speaks. Extracted from open-page-bridge.ts so the wire
 * mapping is unit-testable without the chrome/offscreen stack.
 *
 * Only the chat/stream events that are part of the v1 public surface are
 * translated; load-progress / load-done / queued / tool-status are internal and
 * return null (silently dropped). A2A-task collapsing is stateful and stays in
 * the bridge.
 */

import { DIVINCI_PUBLIC_NS, type PublicResponse } from "@/shared/public-api";
import type { DivinciExternalEvent } from "@/shared/messages";

/** All DivinciExternalEvents carry a requestId; pull it for the public id. */
export function extractRequestId(ev: DivinciExternalEvent): string {
  return (ev as { requestId?: string }).requestId ?? "";
}

export function translateEventToPublic(id: string, ev: DivinciExternalEvent): PublicResponse | null {
  switch (ev.type) {
    case "divinci:chat-token":
      return { __ns: DIVINCI_PUBLIC_NS, id, op: "chat-token", delta: ev.delta };
    case "divinci:chat-done":
      return {
        __ns: DIVINCI_PUBLIC_NS,
        id,
        op: "chat-done",
        fullText: ev.fullText,
        tokensGenerated: ev.tokensGenerated,
        durationMs: ev.durationMs,
        toolCalls: ev.toolCalls,
      };
    case "divinci:aborted":
      return { __ns: DIVINCI_PUBLIC_NS, id, op: "aborted" };
    case "divinci:error":
      return { __ns: DIVINCI_PUBLIC_NS, id, op: "error", message: ev.message, code: "runtime", fatal: ev.fatal };
    default:
      // load-progress / load-done / queued / tool-status are not in the v1
      // public surface — the page sees tokens then done.
      return null;
  }
}
