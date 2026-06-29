/**
 * Robot iframe page — renders the vanilla-Three.js Divinci mascot full-bleed on
 * a transparent background. Embedded by the chat panel's empty state via
 * <iframe src="chrome-extension://…/robot.html">. Three.js is bundled into this
 * page's chunk, so it only downloads when the iframe mounts — never in the base
 * content script. Falls back to the static robot PNG if WebGL is unavailable.
 */

const el = document.getElementById("robot") as HTMLElement;

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function showFallback(): void {
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL("divinci-robot.png");
  img.alt = "";
  el.replaceChildren(img);
}

async function main(): Promise<void> {
  if (!hasWebGL()) {
    showFallback();
    return;
  }
  try {
    const { createRobot } = await import("@/shared/robot/logo-robot");
    createRobot(el);
  } catch {
    showFallback();
  }
}

void main();
