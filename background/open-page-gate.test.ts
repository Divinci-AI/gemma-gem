import { describe, it, expect } from "vitest";
import { gateOpenPageRequest } from "./open-page-gate";
import { grantScopes, type GrantMap } from "@/shared/origin-consent";
import { DIVINCI_PUBLIC_NS, type PublicRequest } from "@/shared/public-api";

const TRUSTED = ["https://chat.divinci.app"];
const ns = DIVINCI_PUBLIC_NS;

function req(partial: Partial<PublicRequest> & { op: PublicRequest["op"] }): PublicRequest {
  return { __ns: ns, id: "r1", ...partial } as PublicRequest;
}

describe("gateOpenPageRequest", () => {
  const empty: GrantMap = {};

  it("ping/abort never need a grant", () => {
    expect(gateOpenPageRequest({ req: req({ op: "ping" }), origin: "https://x.com", grants: empty, trustedOrigins: TRUSTED }))
      .toEqual({ kind: "pong" });
    expect(gateOpenPageRequest({ req: req({ op: "abort" }), origin: "https://x.com", grants: empty, trustedOrigins: TRUSTED }))
      .toEqual({ kind: "abort" });
  });

  it("first-party chat forwards with no grant", () => {
    const a = gateOpenPageRequest({ req: req({ op: "chat" }), origin: "https://chat.divinci.app", grants: empty, trustedOrigins: TRUSTED });
    expect(a).toEqual({ kind: "forward" });
  });

  it("unknown-origin chat needs a grant", () => {
    const a = gateOpenPageRequest({ req: req({ op: "chat" }), origin: "https://shop.example.com", grants: empty, trustedOrigins: TRUSTED });
    expect(a).toEqual({ kind: "reply-error", code: "needs-grant", message: 'Requires "chat" access' });
  });

  it("granted-origin chat forwards", () => {
    const grants = grantScopes({}, "https://shop.example.com", ["chat"], 1);
    const a = gateOpenPageRequest({ req: req({ op: "chat" }), origin: "https://shop.example.com", grants, trustedOrigins: TRUSTED });
    expect(a).toEqual({ kind: "forward" });
  });

  it("invalid/insecure origin chat is denied (not prompted)", () => {
    const a = gateOpenPageRequest({ req: req({ op: "chat" }), origin: "http://insecure.com", grants: empty, trustedOrigins: TRUSTED });
    expect(a).toMatchObject({ kind: "reply-error", code: "denied" });
    const b = gateOpenPageRequest({ req: req({ op: "chat" }), origin: undefined, grants: empty, trustedOrigins: TRUSTED });
    expect(b).toMatchObject({ kind: "reply-error", code: "denied" });
  });

  it("requestAccess commits valid scopes", () => {
    const a = gateOpenPageRequest({
      req: req({ op: "requestAccess", scopes: ["chat", "webmcp"] }) as PublicRequest,
      origin: "https://shop.example.com",
      grants: empty,
      trustedOrigins: TRUSTED,
    });
    expect(a).toEqual({ kind: "commit-grant", scopes: ["chat", "webmcp"] });
  });

  it("requestAccess filters junk scopes and dedupes", () => {
    const a = gateOpenPageRequest({
      req: req({ op: "requestAccess", scopes: ["chat", "chat", "hax"] as unknown as ConsentScopeArr }) as PublicRequest,
      origin: "https://shop.example.com",
      grants: empty,
      trustedOrigins: TRUSTED,
    });
    expect(a).toEqual({ kind: "commit-grant", scopes: ["chat"] });
  });

  it("requestAccess with no valid scopes is an invalid-request", () => {
    const a = gateOpenPageRequest({
      req: req({ op: "requestAccess", scopes: [] }) as PublicRequest,
      origin: "https://shop.example.com",
      grants: empty,
      trustedOrigins: TRUSTED,
    });
    expect(a).toMatchObject({ kind: "reply-error", code: "invalid-request" });
  });

  it("configure prompts without the configure scope, forwards with it", () => {
    const noGrant = gateOpenPageRequest({ req: req({ op: "configure", config: {} }) as PublicRequest, origin: "https://x.com", grants: empty, trustedOrigins: TRUSTED });
    expect(noGrant).toMatchObject({ kind: "reply-error", code: "needs-grant" });
    const grants = grantScopes({}, "https://x.com", ["configure"], 1);
    const ok = gateOpenPageRequest({ req: req({ op: "configure", config: {} }) as PublicRequest, origin: "https://x.com", grants, trustedOrigins: TRUSTED });
    expect(ok).toEqual({ kind: "forward-config" });
  });

  it("configure does NOT ride the chat grant (distinct scope)", () => {
    const grants = grantScopes({}, "https://x.com", ["chat"], 1);
    const res = gateOpenPageRequest({ req: req({ op: "configure", config: {} }) as PublicRequest, origin: "https://x.com", grants, trustedOrigins: TRUSTED });
    expect(res).toMatchObject({ kind: "reply-error", code: "needs-grant" });
  });

  it("a2a.card needs no grant (public metadata)", () => {
    const a = gateOpenPageRequest({ req: req({ op: "a2a.card" }), origin: "https://x.com", grants: empty, trustedOrigins: TRUSTED });
    expect(a).toEqual({ kind: "agent-card" });
  });

  it("a2a.task prompts without an a2a grant, forwards with one", () => {
    const noGrant = gateOpenPageRequest({ req: req({ op: "a2a.task", prompt: "hi" }) as PublicRequest, origin: "https://x.com", grants: empty, trustedOrigins: TRUSTED });
    expect(noGrant).toMatchObject({ kind: "reply-error", code: "needs-grant" });
    const grants = grantScopes({}, "https://x.com", ["a2a"], 1);
    const ok = gateOpenPageRequest({ req: req({ op: "a2a.task", prompt: "hi" }) as PublicRequest, origin: "https://x.com", grants, trustedOrigins: TRUSTED });
    expect(ok).toEqual({ kind: "forward-task" });
  });

  it("a2a.task from a first-party origin forwards without a grant", () => {
    const ok = gateOpenPageRequest({ req: req({ op: "a2a.task", prompt: "hi" }) as PublicRequest, origin: "https://chat.divinci.app", grants: empty, trustedOrigins: TRUSTED });
    expect(ok).toEqual({ kind: "forward-task" });
  });

  it("requestAccess to an insecure origin is denied", () => {
    const a = gateOpenPageRequest({
      req: req({ op: "requestAccess", scopes: ["chat"] }) as PublicRequest,
      origin: "http://evil.com",
      grants: empty,
      trustedOrigins: TRUSTED,
    });
    expect(a).toMatchObject({ kind: "reply-error", code: "denied" });
  });
});

// Local alias to keep the junk-scope cast readable.
type ConsentScopeArr = ("chat" | "webmcp" | "a2a")[];
