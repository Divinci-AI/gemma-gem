import { describe, it, expect } from "vitest";
import {
  DIVINCI_PUBLIC_NS,
  DIVINCI_PUBLIC_PROTOCOL_VERSION,
  OP_REQUIRED_SCOPE,
  requiredScopeForOp,
  isPublicRequest,
  type PublicOp,
} from "./public-api";
import { ALL_CONSENT_SCOPES, isConsentScope } from "./origin-consent";

describe("OP_REQUIRED_SCOPE", () => {
  it("covers every declared op exactly once", () => {
    const ops: PublicOp[] = [
      "ping",
      "requestAccess",
      "chat",
      "abort",
      "webmcp.list",
      "webmcp.call",
      "a2a.card",
      "a2a.task",
    ];
    expect(Object.keys(OP_REQUIRED_SCOPE).sort()).toEqual([...ops].sort());
  });

  it("leaves the grant-flow + metadata ops unauthenticated", () => {
    expect(OP_REQUIRED_SCOPE.ping).toBeNull();
    expect(OP_REQUIRED_SCOPE.requestAccess).toBeNull();
    expect(OP_REQUIRED_SCOPE.abort).toBeNull();
    expect(OP_REQUIRED_SCOPE["a2a.card"]).toBeNull();
  });

  it("requires a real, recognized scope for every model/agent-touching op", () => {
    expect(OP_REQUIRED_SCOPE.chat).toBe("chat");
    expect(OP_REQUIRED_SCOPE["webmcp.list"]).toBe("webmcp");
    expect(OP_REQUIRED_SCOPE["webmcp.call"]).toBe("webmcp");
    expect(OP_REQUIRED_SCOPE["a2a.task"]).toBe("a2a");
    for (const v of Object.values(OP_REQUIRED_SCOPE)) {
      if (v !== null) expect(isConsentScope(v)).toBe(true);
    }
  });

  it("every consent scope is reachable by at least one op (no orphan scope)", () => {
    const usedScopes = new Set(Object.values(OP_REQUIRED_SCOPE).filter(Boolean));
    for (const s of ALL_CONSENT_SCOPES) expect(usedScopes.has(s)).toBe(true);
  });

  it("requiredScopeForOp mirrors the map", () => {
    expect(requiredScopeForOp("chat")).toBe("chat");
    expect(requiredScopeForOp("ping")).toBeNull();
  });
});

describe("isPublicRequest", () => {
  const ok = { __ns: DIVINCI_PUBLIC_NS, id: "r1", op: "chat" };

  it("accepts a well-formed envelope", () => {
    expect(isPublicRequest(ok)).toBe(true);
  });

  it("rejects wrong/missing namespace", () => {
    expect(isPublicRequest({ ...ok, __ns: "other" })).toBe(false);
    expect(isPublicRequest({ id: "r1", op: "chat" })).toBe(false);
  });

  it("rejects unknown ops (so injected page noise can't reach the SW)", () => {
    expect(isPublicRequest({ ...ok, op: "exfiltrate" })).toBe(false);
    expect(isPublicRequest({ ...ok, op: "" })).toBe(false);
  });

  it("rejects empty / non-string ids", () => {
    expect(isPublicRequest({ ...ok, id: "" })).toBe(false);
    expect(isPublicRequest({ ...ok, id: 5 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isPublicRequest(null)).toBe(false);
    expect(isPublicRequest("chat")).toBe(false);
    expect(isPublicRequest(undefined)).toBe(false);
  });

  it("accepts every valid op token", () => {
    for (const op of Object.keys(OP_REQUIRED_SCOPE)) {
      expect(isPublicRequest({ ...ok, op })).toBe(true);
    }
  });
});

describe("protocol constants", () => {
  it("namespace is distinct from the WebMCP-consumer bridge NS", () => {
    expect(DIVINCI_PUBLIC_NS).toBe("divinci-public-api");
    expect(DIVINCI_PUBLIC_NS).not.toBe("divinci-webmcp-bridge");
  });
  it("declares a numeric protocol version", () => {
    expect(typeof DIVINCI_PUBLIC_PROTOCOL_VERSION).toBe("number");
  });
});
