/**
 * Detect whether the current page already hosts a Divinci chat widget — the
 * embeddable "Ask Divinci" UI (embed-chat-ui) or an embed-script release widget.
 * When one is present the extension stands down (hides its launcher) and lets
 * the page's own widget route to the local model, so a page never shows two
 * Divinci assistants.
 *
 * DOM-only signals (visible to a content script — no MAIN-world global needed),
 * ranked by reliability. Pure: takes a query root (Document in prod, a fake in
 * tests) so detection is unit-testable without a browser. Deliberately specific
 * so it never matches the extension's OWN shadow-DOM panel.
 */

interface ElLike {
  getAttribute(name: string): string | null;
}
interface QueryRoot {
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
}

export interface DivinciEmbedInfo {
  /** Which widget flavor was found. */
  kind: "embed-chat-ui" | "embed-script" | "docs-config";
  /** The release the page widget is configured for, when discoverable. */
  releaseId?: string;
}

export function detectDivinciEmbed(doc: QueryRoot): DivinciEmbedInfo | null {
  const cfgReleaseId = () => doc.getElementById("divinci-docs-config")?.getAttribute("data-release-id") ?? undefined;

  // 1. embed-chat-ui ("Ask Divinci" widget — fixed id + a uniquely-marked style).
  if (doc.getElementById("divinci-docs-assistant") || doc.querySelector("style[data-divinci-embed]")) {
    return { kind: "embed-chat-ui", releaseId: cfgReleaseId() };
  }

  // 2. embed-script toggleable widget (its container class is `divinci-*-container`).
  if (doc.querySelector('[class*="divinci-"][class*="-container"]')) {
    return { kind: "embed-script" };
  }

  // 3. embed-script <script> tag (carries the release id; src matches embed-script).
  const script = doc.querySelector("script[divinci-release-id], script[src*='embed-script']");
  if (script) {
    return { kind: "embed-script", releaseId: script.getAttribute("divinci-release-id") ?? undefined };
  }

  // 4. Docs config element on its own (widget may still be booting).
  const cfg = doc.getElementById("divinci-docs-config");
  if (cfg) return { kind: "docs-config", releaseId: cfg.getAttribute("data-release-id") ?? undefined };

  return null;
}
