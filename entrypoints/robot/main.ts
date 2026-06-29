/**
 * Robot iframe page — renders the vanilla-Three.js Divinci mascot full-bleed on
 * a transparent background. Embedded by the chat panel's empty state via
 * <iframe src="chrome-extension://…/robot.html">. Three.js is bundled into this
 * page's lazy chunk, so it only downloads when the iframe mounts.
 *
 * Strategy: show the static robot PNG IMMEDIATELY (so if this script runs at all
 * the user always sees the robot), then upgrade in place to the live 3D render
 * when WebGL + three.js are available. The PNG is also the permanent no-WebGL
 * fallback.
 */

const el = document.getElementById("robot") as HTMLElement;
// Breadcrumb so the iframe's own console confirms the script executed.
console.log("[divinci-robot] iframe script running");

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
  try {
    img.src = chrome.runtime.getURL("divinci-robot.png");
  } catch {
    img.src = "divinci-robot.png"; // same-origin relative fallback
  }
  img.alt = "";
  el.replaceChildren(img);
}

async function main(): Promise<void> {
  showFallback(); // base layer — always visible if this script ran
  if (!hasWebGL()) {
    console.warn("[divinci-robot] no WebGL — keeping PNG fallback");
    return;
  }
  try {
    const { createRobot } = await import("@/shared/robot/logo-robot");
    el.replaceChildren(); // clear PNG, hand off to the live canvas
    createRobot(el);
    console.log("[divinci-robot] 3D robot mounted");
  } catch (e) {
    console.error("[divinci-robot] 3D load failed, keeping PNG:", e);
    showFallback();
  }
}

void main();
