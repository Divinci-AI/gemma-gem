/**
 * Open-page authorization gate — the PURE decision layer for the any-website
 * programmatic API. Given one inbound PublicRequest, the page origin (browser-
 * attested via `port.sender`), and the current grant map, it returns the single
 * action the SW glue should take. No chrome.* here, so the whole authorization
 * surface is unit-testable (same discipline as origin-consent.ts).
 *
 * Trust model: this runs only for ports accepted on chrome.runtime.onConnect
 * with name OPEN_PAGE_PORT — i.e. opened by THIS extension's own ISOLATED-world
 * relay content script. So:
 *   - the origin is whatever the browser put on `port.sender` (unspoofable);
 *   - a `requestAccess` op is a COMMIT of a grant the user already approved in
 *     the relay's own shadow-DOM banner (the page can't click that button), so
 *     the gate persists it. The page can ASK for access (which makes the relay
 *     show the banner) but only the relay commits, and only after a real click.
 */

import {
  decideConsent,
  isConsentScope,
  type ConsentScope,
  type GrantMap,
} from "@/shared/origin-consent";
import { requiredScopeForOp, type PublicRequest } from "@/shared/public-api";

export type GateAction =
  /** Authorized — forward to the offscreen model with this required scope. */
  | { kind: "forward" }
  /** Reply pong (handled in glue with manifest metadata). */
  | { kind: "pong" }
  /** Reply the (public, unsigned) A2A agent card — no grant needed. */
  | { kind: "agent-card" }
  /** Authorized A2A task — forward to the model, result wrapped as an A2A Task. */
  | { kind: "forward-task" }
  /** Forward an abort for the in-flight request (no standing grant needed). */
  | { kind: "abort" }
  /** Persist these scopes for the origin, then reply access-result. */
  | { kind: "commit-grant"; scopes: ConsentScope[] }
  /** Authorized site config — validate + store, then reply configure-result. */
  | { kind: "forward-config" }
  /** Refuse — reply an error event with this code + message. */
  | {
      kind: "reply-error";
      code: "denied" | "needs-grant" | "invalid-request" | "runtime";
      message: string;
    };

/**
 * Decide what to do with one open-page request. `origin` is `port.sender`'s
 * origin (may be undefined if the browser didn't supply one → deny).
 */
export function gateOpenPageRequest(args: {
  req: PublicRequest;
  origin: string | undefined;
  grants: GrantMap;
  trustedOrigins: readonly string[];
}): GateAction {
  const { req, origin, grants, trustedOrigins } = args;

  switch (req.op) {
    case "ping":
      return { kind: "pong" };

    case "abort":
      return { kind: "abort" };

    case "requestAccess": {
      // Commit-only: arrives on the trusted internal port AFTER the relay's
      // banner click. Validate + dedupe the scopes; empty → nothing to commit.
      const scopes = Array.isArray(req.scopes)
        ? Array.from(new Set(req.scopes.filter(isConsentScope)))
        : [];
      if (scopes.length === 0) {
        return { kind: "reply-error", code: "invalid-request", message: "No valid scopes requested" };
      }
      // An invalid/insecure origin can't hold a grant — refuse rather than
      // persisting a key that grantScopes would silently drop anyway.
      const probe = decideConsent({ rawOrigin: origin, scope: scopes[0], grants, trustedOrigins });
      if (probe.reason === "invalid-origin" || probe.reason === "insecure-origin") {
        return { kind: "reply-error", code: "denied", message: `Cannot grant to ${probe.reason}` };
      }
      return { kind: "commit-grant", scopes };
    }

    case "a2a.card":
      return { kind: "agent-card" };

    case "chat":
    case "a2a.task":
    case "configure": {
      const scope = requiredScopeForOp(req.op);
      const allowKind: GateAction["kind"] =
        req.op === "a2a.task" ? "forward-task" : req.op === "configure" ? "forward-config" : "forward";
      // all three ops have a required scope; belt-and-suspenders fallthrough.
      if (!scope) return { kind: allowKind };
      const res = decideConsent({ rawOrigin: origin, scope, grants, trustedOrigins });
      if (res.decision === "allow") return { kind: allowKind };
      if (res.decision === "prompt") {
        return { kind: "reply-error", code: "needs-grant", message: `Requires "${scope}" access` };
      }
      return { kind: "reply-error", code: "denied", message: `Refused: ${res.reason}` };
    }

    default:
      return { kind: "reply-error", code: "invalid-request", message: `Unsupported op: ${(req as { op: string }).op}` };
  }
}
