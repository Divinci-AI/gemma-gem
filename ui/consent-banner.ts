/**
 * In-page consent banner for the open programmatic API.
 *
 * Rendered by the ISOLATED-world relay content script (NOT the page), so the
 * page can never script or auto-click it — that's the trust boundary that lets
 * the SW treat a `requestAccess` commit as genuine user approval. Shadow-DOM
 * isolated so page CSS can't restyle it into something deceptive.
 *
 * Pure DOM + a Promise — no chrome.* — so it works identically in the content
 * script and is trivially reasoned about. Resolves true (Allow) / false (Deny);
 * Escape / clicking the backdrop counts as Deny (default-deny).
 */

import type { ConsentScope } from "@/shared/origin-consent";

const SCOPE_LABELS: Record<ConsentScope, string> = {
  chat: "run AI chat on your device (uses your GPU)",
  webmcp: "let this site's AI assistant use Divinci tools",
  a2a: "let this site's AI agent send tasks to Divinci",
  configure: "customize the Divinci assistant (greeting, prompts, context)",
};

/** Already-open banner, so a burst of requests doesn't stack banners. */
let openBanner: { dispose: () => void } | null = null;

export interface ConsentBannerDeps {
  /** Defaults to document.documentElement; injectable for tests. */
  root?: HTMLElement;
}

/**
 * Show the consent banner for `origin` requesting `scopes`. Resolves with the
 * user's choice. If a banner is already open it's dismissed (Deny) first so the
 * newest request wins.
 */
export function showConsentBanner(
  origin: string,
  scopes: ConsentScope[],
  deps: ConsentBannerDeps = {},
): Promise<boolean> {
  if (openBanner) {
    openBanner.dispose();
    openBanner = null;
  }
  const mount = deps.root ?? document.documentElement;

  return new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-divinci-consent", "");
    // Pin above page content; the shadow root holds the real styles.
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });

    const safeOrigin = origin.replace(/[<>&"]/g, ""); // belt-and-suspenders; set via textContent below anyway
    const items = scopes.map((s) => SCOPE_LABELS[s] ?? s).join(", ");

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <style>
        .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:flex-end;justify-content:center;}
        .card{font:14px/1.45 system-ui,-apple-system,sans-serif;background:#fff;color:#111;max-width:420px;width:calc(100% - 32px);
              margin:0 0 24px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:18px 18px 14px;}
        .h{font-weight:650;font-size:15px;margin:0 0 6px;display:flex;align-items:center;gap:8px;}
        .dot{width:9px;height:9px;border-radius:50%;background:#6c5ce7;flex:0 0 auto;}
        .o{font-weight:600;word-break:break-all;}
        .b{margin:8px 0 14px;color:#333;}
        .row{display:flex;gap:8px;justify-content:flex-end;}
        button{font:inherit;font-weight:600;border-radius:9px;padding:8px 14px;cursor:pointer;border:1px solid #d0d0d8;background:#f4f4f7;color:#222;}
        button.allow{background:#6c5ce7;border-color:#6c5ce7;color:#fff;}
        @media (prefers-color-scheme: dark){.card{background:#1d1d22;color:#eee;}.b{color:#bbb;}button{background:#2a2a31;border-color:#3a3a44;color:#eee;}}
      </style>
      <div class="backdrop" part="backdrop">
        <div class="card" role="dialog" aria-modal="true" aria-label="Divinci access request">
          <p class="h"><span class="dot"></span>Allow <span class="o"></span>?</p>
          <p class="b">This site wants to <span class="items"></span>.</p>
          <div class="row">
            <button class="deny" type="button">Deny</button>
            <button class="allow" type="button">Allow</button>
          </div>
        </div>
      </div>`;
    // Set untrusted strings via textContent (never innerHTML) — XSS-safe.
    wrap.querySelector(".o")!.textContent = safeOrigin;
    wrap.querySelector(".items")!.textContent = items;
    shadow.appendChild(wrap);
    mount.appendChild(host);

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      openBanner = null;
    };

    wrap.querySelector("button.allow")!.addEventListener("click", () => finish(true));
    wrap.querySelector("button.deny")!.addEventListener("click", () => finish(false));
    wrap.querySelector(".backdrop")!.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) finish(false);
    });
    document.addEventListener("keydown", onKey, true);

    openBanner = { dispose: () => finish(false) };
  });
}
