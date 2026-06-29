/**
 * The Divinci mascot — a faithful VANILLA Three.js port of the web app's
 * `RobotAvatar`/`LogoRobot` (which is React-Three-Fiber). Same procedural
 * geometry (no GLB), same idle animation feel, but imperative Three.js + one
 * requestAnimationFrame loop, so it carries NO React.
 *
 * Rendered inside a dedicated extension-page iframe (entrypoints/robot) so
 * `three` is loaded lazily, only when the iframe mounts — never in the base
 * content-script bundle. `createRobot(container)` builds the scene and returns a
 * disposer; the page-wide gaze / keystroke reactivity of the web version is
 * dropped in favour of a self-contained idle loop (gentle bob, auto-rotate,
 * antenna sway, blink, heart color-phase + light periodic fidgets).
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const { damp } = THREE.MathUtils;
const BASE_BODY_YAW = 0.08;

export interface RobotColors {
  body: string;
  eye: string;
  trim: string;
}

const DEFAULT_COLORS: RobotColors = {
  body: "#b4c4c4", // silvery grey-green plastic (matches the SDK hero)
  eye: "#2f3e48",
  trim: "#8aa0a6",
};

// ---- geometry helpers (ported verbatim from LogoRobot.tsx) ------------------

function roundedRectGeometry(w: number, h: number, depth: number, r: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x, y);
  s.lineTo(x + w, y);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.26, bevelSize: 0.3, bevelSegments: 10, curveSegments: 24 });
  geo.center();
  return geo;
}

function roundedAllGeometry(w: number, h: number, depth: number, r: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 10 });
  geo.center();
  return geo;
}

function footShapeGeometry(w: number, h: number, depth: number, r: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x, y);
  s.lineTo(x + w, y);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x, y + h);
  s.lineTo(x, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 4, curveSegments: 14 });
  geo.center();
  return geo;
}

function makeNoiseNormalMap(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 128 + Math.round((Math.random() * 2 - 1) * 14);
    data[i * 4 + 1] = 128 + Math.round((Math.random() * 2 - 1) * 14);
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.needsUpdate = true;
  return tex;
}

function taperedStemGeometry(topW: number, botW: number, h: number, depth: number): THREE.ExtrudeGeometry {
  const ht = topW / 2;
  const hb = botW / 2;
  const top = h / 2;
  const bot = -h / 2;
  const hipHi = 0.0;
  const hipLo = -0.16;
  const s = new THREE.Shape();
  s.moveTo(-hb, bot);
  s.lineTo(hb, bot);
  s.lineTo(hb, hipLo);
  s.lineTo(ht, hipHi);
  s.lineTo(ht, top);
  s.lineTo(-ht, top);
  s.lineTo(-ht, hipHi);
  s.lineTo(-hb, hipLo);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, curveSegments: 8 });
  geo.center();
  return geo;
}

function handFilletGeometry(cx: number, cy: number, rIn: number, aStart: number, aEnd: number): THREE.ExtrudeGeometry {
  const rOut = rIn + 0.08;
  const s = new THREE.Shape();
  s.moveTo(cx + Math.cos(aStart) * rOut, cy + Math.sin(aStart) * rOut);
  for (let a = aStart; a <= aEnd; a += 0.1) s.lineTo(cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut);
  for (let a = aEnd; a >= aStart; a -= 0.1) s.lineTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 6 });
  geo.translate(0, 0, -0.18);
  return geo;
}

function makeHeartGeometry(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.3);
  s.bezierCurveTo(0, 0.3, -0.2, 0, -0.5, 0);
  s.bezierCurveTo(-0.95, 0, -0.95, 0.5, -0.95, 0.5);
  s.bezierCurveTo(-0.95, 0.78, -0.6, 1.05, 0, 1.35);
  s.bezierCurveTo(0.6, 1.05, 0.95, 0.78, 0.95, 0.5);
  s.bezierCurveTo(0.95, 0.5, 0.95, 0, 0.5, 0);
  s.bezierCurveTo(0.2, 0, 0, 0.3, 0, 0.3);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.55, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.14, bevelSegments: 5, curveSegments: 28 });
  geo.center();
  geo.rotateZ(Math.PI);
  return geo;
}

// ---- scene build + animation ------------------------------------------------

export interface RobotHandle {
  dispose: () => void;
}

export function createRobot(container: HTMLElement, colors: Partial<RobotColors> = {}): RobotHandle {
  const col = { ...DEFAULT_COLORS, ...colors };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const sizeOf = () => ({ w: container.clientWidth || 140, h: container.clientHeight || 140 });
  let { w, h } = sizeOf();
  renderer.setSize(w, h, false);
  // Ensure the canvas always fills the container (setSize updateStyle=false
  // leaves no CSS size; without this the canvas can render at the wrong box).
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 100);
  camera.position.set(0, 0, 6.4);

  // Procedural studio environment (no HDR download) → soft plastic reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(new THREE.Color(col.trim), 0.35);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const normalMap = makeNoiseNormalMap();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(col.body),
    roughness: 0.34,
    metalness: 0.06,
    normalMap,
    normalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 0.85,
  });
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(col.eye), roughness: 0.25, metalness: 0.2 });

  const geos: THREE.BufferGeometry[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };

  // --- build the rig ---
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(0.92);
  inner.position.set(0, -0.78, 0);
  root.add(inner);

  // Head
  const head = new THREE.Group();
  head.position.set(0, 1.37, 0);
  head.scale.setScalar(0.85);
  inner.add(head);
  head.add(new THREE.Mesh(track(roundedRectGeometry(1.28, 0.71, 0.64, 0.34)), bodyMaterial));
  const eyeGeo = track(roundedAllGeometry(0.19, 0.3, 0.08, 0.06));
  const eyeL = new THREE.Mesh(eyeGeo, eyeMaterial);
  eyeL.position.set(-0.27, 0, 0.7);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMaterial);
  eyeR.position.set(0.27, 0, 0.7);
  head.add(eyeL, eyeR);

  // Antennae (group per side, animated)
  const antennae: { grp: THREE.Group; side: number }[] = [];
  for (const side of [-1, 1] as const) {
    const grp = new THREE.Group();
    grp.position.set(side * 0.82, 0.49, 0);
    const stalk = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 12)), bodyMaterial);
    stalk.position.set(0, 0.25, 0);
    const ball = new THREE.Mesh(track(new THREE.SphereGeometry(0.17, 18, 18)), bodyMaterial);
    ball.position.set(0, 0.54, 0);
    grp.add(stalk, ball);
    head.add(grp);
    antennae.push({ grp, side });
  }

  // "4" limbs (arm group swings; foot taps) — shared geometries per side shape
  const footGeo = track(footShapeGeometry(0.42, 0.26, 0.6, 0.13));
  const rightBarGeo = track(taperedStemGeometry(0.23, 0.23, 0.96, 0.32));
  const prongGeo = track(taperedStemGeometry(0.2, 0.2, 0.46, 0.28));
  const crossGeo = track(roundedAllGeometry(0.68, 0.26, 0.32, 0.06));
  const filletGeo = track(handFilletGeometry(-0.115, -0.359, 0.18, -0.1, Math.PI / 2 + 0.15));
  const handGeo = track(new THREE.SphereGeometry(0.17, 20, 20));
  const limbs: { arm: THREE.Group; foot: THREE.Mesh; side: number }[] = [];
  for (const side of [-1, 1] as const) {
    const limb = new THREE.Group();
    limb.position.set(side * 0.97, 0.05, 0);
    limb.scale.set(-side, 1, 1);
    const arm = new THREE.Group();
    arm.position.set(0, 0.45, 0);
    const rest = new THREE.Group();
    rest.position.set(0, -0.45, 0);
    arm.add(rest);
    const rb = new THREE.Mesh(rightBarGeo, bodyMaterial);
    rb.position.set(0.21, -0.02, 0);
    const cb = new THREE.Mesh(crossGeo, bodyMaterial);
    cb.position.set(0.01, -0.05, 0);
    const pr = new THREE.Mesh(prongGeo, bodyMaterial);
    pr.position.set(-0.19, 0.23, 0);
    const fi = new THREE.Mesh(filletGeo, bodyMaterial);
    const hand = new THREE.Mesh(handGeo, bodyMaterial);
    hand.position.set(-0.2, -0.48, 0);
    rest.add(rb, cb, pr, fi, hand);
    limb.add(arm);
    const foot = new THREE.Mesh(footGeo, bodyMaterial);
    foot.position.set(0.3, -0.92, 0.04);
    limb.add(foot);
    inner.add(limb);
    limbs.push({ arm, foot, side });
  }

  // Heart
  const heartGeo = track(makeHeartGeometry());
  const heartMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.8, roughness: 0.2, metalness: 0, emissiveIntensity: 0.35, depthWrite: false });
  const heart = new THREE.Mesh(heartGeo, heartMat);
  const heartScale = 0.45;
  const heartStretchY = 1.18;
  heart.position.set(0, -0.06, 0.2);
  inner.add(heart);

  scene.add(root);

  // --- interaction signals (ported from useRobotSignals) ---
  // The robot can't observe the parent page's pointer/keys from inside this
  // iframe, so the content script FORWARDS them as window messages
  // ({__divinciRobot, kind:'gaze'|'react'|'focus'|'blur', x, y}); we resolve
  // them into the same gaze/react/fidget signals the SDK robot uses.
  const sig = { lookX: 0, lookY: 0, reactUntil: 0, reactSeed: 0, fidgetUntil: 0, fidgetSeed: 0 };
  const mouse = { x: 0, y: 0, at: -10 };
  const focus = { x: 0, y: 0, active: false };
  let nextFidget = 5;
  const heartColor = new THREE.Color();
  const clamp1 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

  function onSignal(e: MessageEvent): void {
    const d = e.data as { __divinciRobot?: boolean; kind?: string; x?: number; y?: number };
    if (!d || d.__divinciRobot !== true) return;
    const nowS = performance.now() / 1000;
    switch (d.kind) {
      case "gaze":
        mouse.x = clamp1(d.x);
        mouse.y = clamp1(d.y);
        mouse.at = nowS;
        break;
      case "react":
        sig.reactUntil = nowS + 0.5 + Math.random() * 0.3;
        sig.reactSeed = Math.random();
        break;
      case "focus":
        focus.x = clamp1(d.x);
        focus.y = clamp1(d.y);
        focus.active = true;
        break;
      case "blur":
        focus.active = false;
        break;
    }
  }
  window.addEventListener("message", onSignal);

  let raf = 0;
  function tick(): void {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const t = now / 1000;
    const dt = 0.016;

    // Resolve attention target by recency: recent mouse > focused field > user.
    let tx = 0;
    let ty = 0;
    if (t - mouse.at < 2.5) {
      tx = mouse.x;
      ty = mouse.y;
    } else if (focus.active) {
      tx = focus.x;
      ty = focus.y;
    }
    sig.lookX += (tx - sig.lookX) * 0.08;
    sig.lookY += (ty - sig.lookY) * 0.08;
    // Idle fidget scheduling (~every 6–14s when not reacting), fresh seed each.
    if (t > nextFidget && t > sig.reactUntil) {
      sig.fidgetUntil = t + 1.4 + Math.random() * 0.8;
      sig.fidgetSeed = Math.random();
      nextFidget = t + 6 + Math.random() * 8;
    }

    const reacting = t < sig.reactUntil;
    const fidgeting = t < sig.fidgetUntil;
    const rs = sig.reactSeed;
    const fs = sig.fidgetSeed;
    const reactStyle = Math.floor(rs * 3); // 0 arm-heavy, 1 foot-heavy, 2 full
    const fidgetStyle = Math.floor(fs * 4); // 0 glance, 1 antenna, 2 foot, 3 arm

    // Root: bob + body-lean toward the gaze + springy react scale + playful tilt.
    const bobSpeed = reacting ? 9 : 1.6;
    const bobAmp = reacting ? 0.13 : fidgeting ? 0.07 : 0.035;
    root.position.y = Math.sin(t * bobSpeed) * bobAmp;
    const targetScale = reacting ? 1 + Math.abs(Math.sin(t * 8)) * 0.05 : 1;
    root.scale.setScalar(damp(root.scale.x, targetScale, 7, dt));
    root.rotation.y = damp(root.rotation.y, BASE_BODY_YAW + sig.lookX * 0.1, 5, dt);
    const tilt = reacting ? Math.sin(t * 9) * 0.12 : fidgeting ? Math.sin(t * 2.5) * 0.06 : 0;
    root.rotation.z = damp(root.rotation.z, tilt, 6, dt);

    // Head: leads the gaze + nods; eyes dart + blink.
    const glance = fidgeting && fidgetStyle === 0 ? (fs - 0.5) * 0.2 * Math.sin(t * 1.4) : 0;
    const gaze = Math.max(-0.6, Math.min(0.6, sig.lookX)) * 0.34;
    head.rotation.y = damp(head.rotation.y, -BASE_BODY_YAW + gaze + glance, 6, dt);
    head.rotation.x = damp(head.rotation.x, 0.09 - sig.lookY * 0.24, 6, dt);
    const bt = t % 3.6;
    const blink = bt < 0.13 ? 1 - Math.sin((bt / 0.13) * Math.PI) * 0.92 : 1;
    const dartX = sig.lookX * 0.045;
    const dartY = -sig.lookY * 0.03;
    eyeL.position.x = -0.27 + dartX;
    eyeL.position.y = dartY;
    eyeL.scale.y = blink;
    eyeR.position.x = 0.27 + dartX;
    eyeR.position.y = dartY;
    eyeR.scale.y = blink;

    // Antennae: pendulum sway, bigger on react / antenna-fidget.
    for (const { grp, side } of antennae) {
      const amp = reacting
        ? 0.32 + rs * 0.3
        : fidgeting
          ? (fidgetStyle === 1 ? 0.3 : 0.12) + fs * 0.08
          : 0.13;
      const spd = 2.2 + (reacting ? rs * 3 : 0);
      const phase = side + (reacting ? rs * 6 : 0);
      grp.rotation.z = Math.sin(t * spd + phase) * amp;
    }

    // Arms swing from the shoulder; feet tap-dance — seed-/style-weighted.
    for (const { arm, foot, side } of limbs) {
      let armTarget = Math.sin(t * 1.4 + side) * 0.05;
      if (reacting) {
        const wgt = reactStyle === 0 ? 1.3 : reactStyle === 1 ? 0.4 : 0.95;
        armTarget = Math.sin(t * (8 + rs * 5) + rs * 7 + side) * (0.3 + rs * 0.25) * wgt;
      } else if (fidgeting) {
        const wgt = fidgetStyle === 3 ? 1 : 0.3;
        armTarget = Math.sin(t * (2.4 + fs * 2) + fs * 6 + side) * (0.12 + fs * 0.15) * wgt;
      }
      arm.rotation.z = damp(arm.rotation.z, armTarget, 9, dt);

      const fphase = side > 0 ? 0 : Math.PI;
      let tap = 0;
      if (reacting) {
        const wgt = reactStyle === 1 ? 1.4 : reactStyle === 0 ? 0.4 : 0.95;
        tap = Math.max(0, Math.sin(t * (9 + rs * 5) + fphase + rs * 4)) * (0.1 + rs * 0.08) * wgt;
      } else if (fidgeting) {
        const wgt = fidgetStyle === 2 ? 1 : 0.25;
        tap = Math.max(0, Math.sin(t * (3.5 + fs * 2) + fphase)) * (0.06 + fs * 0.05) * wgt;
      }
      foot.position.y = -0.92 + tap;
      foot.rotation.x = -tap * 1.2;
    }

    // Heart: brand color phase + pulse + bounce on reactions.
    const phase = Math.sin((t * 2 * Math.PI) / 6);
    heartColor.setHSL((0.89 + 0.11 * phase) % 1, 0.7, 0.56);
    heartMat.color.copy(heartColor);
    heartMat.emissive.copy(heartColor);
    const pulse = 1 + (reacting ? 0.2 : 0.05) * Math.sin(t * (reacting ? 9 : 2.4));
    heart.scale.set(heartScale * pulse, heartScale * heartStretchY * pulse, heartScale * pulse);
    heart.position.y = -0.06 + (reacting ? Math.abs(Math.sin(t * 9)) * 0.06 : 0);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  function onResize(): void {
    const next = sizeOf();
    if (next.w === w && next.h === h) return;
    ({ w, h } = next);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("message", onSignal);
      ro.disconnect();
      geos.forEach((g) => g.dispose());
      bodyMaterial.dispose();
      eyeMaterial.dispose();
      heartMat.dispose();
      normalMap.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
