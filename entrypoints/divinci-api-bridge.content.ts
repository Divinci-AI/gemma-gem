/**
 * ISOLATED-world relay for the public programmatic API. Bridges the page's
 * `window.divinci` (MAIN world) to the SW's open-page bridge, and OWNS the
 * consent banner — the one surface the page cannot script, which is what makes a
 * `requestAccess` commit trustworthy.
 *
 * Flow:
 *   page (MAIN) ──postMessage{dir:"req"}──► this (ISOLATED)
 *     · requestAccess → show banner; on Allow forward to SW, on Deny reply []
 *     · everything else → forward over the OPEN_PAGE_PORT to the SW
 *   SW ──port──► this ──postMessage{dir:"res"}──► page (MAIN)
 *
 * Origin is validated twice: here (event.origin === location.origin) and again
 * in the SW (port.sender). The page cannot forge either.
 */

import {
  OPEN_PAGE_PORT,
  DIVINCI_PUBLIC_NS,
  DIVINCI_CONTROL_NS,
  STORAGE_KEY_WEBMCP_EXPOSE,
  isPublicRequest,
  type PublicResponse,
} from "@/shared/public-api";
import { isConsentScope, type ConsentScope } from "@/shared/origin-consent";
import { showConsentBanner } from "@/ui/consent-banner";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  main() {
    let port: chrome.runtime.Port | null = null;

    /** Post a public response back into the page's MAIN world. */
    function toPage(res: PublicResponse): void {
      window.postMessage({ ...res, dir: "res" }, window.location.origin);
    }

    function ensurePort(): chrome.runtime.Port {
      if (port) return port;
      const p = chrome.runtime.connect({ name: OPEN_PAGE_PORT });
      p.onMessage.addListener((msg: unknown) => {
        const m = msg as PublicResponse;
        if (m && (m as { __ns?: string }).__ns === DIVINCI_PUBLIC_NS) toPage(m);
      });
      p.onDisconnect.addListener(() => {
        port = null; // SW evicted / errored — next request reconnects.
      });
      port = p;
      return p;
    }

    // ---- Control channel: push the WebMCP-expose flag to the MAIN world -----
    function pushConfig(enabled: boolean): void {
      window.postMessage({ __ns: DIVINCI_CONTROL_NS, op: "config", webmcpExpose: enabled }, window.location.origin);
    }
    function readAndPushConfig(): void {
      chrome.storage.local
        .get(STORAGE_KEY_WEBMCP_EXPOSE)
        .then((s) => pushConfig(s[STORAGE_KEY_WEBMCP_EXPOSE] === true))
        .catch(() => pushConfig(false));
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY_WEBMCP_EXPOSE]) {
        pushConfig(changes[STORAGE_KEY_WEBMCP_EXPOSE].newValue === true);
      }
    });
    readAndPushConfig(); // startup push (MAIN also requests via get-config)

    window.addEventListener("message", (e: MessageEvent) => {
      // Only page-originated requests from THIS document.
      if (e.source !== window) return;
      if (e.origin !== window.location.origin) return;
      const d = e.data as { __ns?: string; dir?: string; op?: string };
      // Control-channel: MAIN asks for current config.
      if (d && d.__ns === DIVINCI_CONTROL_NS && d.op === "get-config") {
        readAndPushConfig();
        return;
      }
      if (!d || d.dir !== "req") return;
      if (!isPublicRequest(d)) return;
      const req = d;

      if (req.op === "requestAccess") {
        const scopes: ConsentScope[] = Array.isArray(req.scopes)
          ? Array.from(new Set(req.scopes.filter(isConsentScope)))
          : [];
        if (scopes.length === 0) {
          toPage({ __ns: DIVINCI_PUBLIC_NS, id: req.id, op: "access-result", grantedScopes: [] });
          return;
        }
        void showConsentBanner(window.location.origin, scopes).then((allowed) => {
          if (allowed) {
            // Commit through the SW (trusted internal port) — it replies access-result.
            ensurePort().postMessage(req);
          } else {
            toPage({ __ns: DIVINCI_PUBLIC_NS, id: req.id, op: "access-result", grantedScopes: [] });
          }
        });
        return;
      }

      // ping / chat / abort → straight through to the SW gate.
      try {
        ensurePort().postMessage(req);
      } catch {
        toPage({
          __ns: DIVINCI_PUBLIC_NS,
          id: req.id,
          op: "error",
          message: "Extension unavailable",
          code: "runtime",
          fatal: true,
        });
      }
    });
  },
});
