/**
 * Wake-host — runs the always-on wake-word loop inside the offscreen document
 * (Phase B0). The offscreen doc persists across tabs and already hosts WebGPU,
 * so it's the right home. Mic permission must already be granted (the popup does
 * that — getUserMedia can't prompt from an offscreen doc). On detection it asks
 * the background to open the Divinci panel via the existing `internal:open-overlay`.
 *
 * B0 ships the stock `hey_jarvis` head to prove the runtime; B1 swaps in
 * `hey_divinci`. ort runs on the WASM backend (asyncify wasm already in /ort/,
 * copied from onnxruntime-web by wxt.config) to avoid WebGPU contention with Gemma.
 */
import * as ort from "onnxruntime-web";
import {
  WakeWordEngine,
  type WakeDetection,
  type InferenceSessionLike,
} from "@/shared/wake/wake-engine";
import { wakeWorkletUrl } from "@/shared/wake/worklet-source";
import { log } from "@/shared/logger";

const MODELS_BASE = "/models/wake";
const STOCK_KEYWORD = { name: "hey_jarvis", model: `${MODELS_BASE}/hey_jarvis_v0.1.onnx` };

let running = false;
let audioContext: AudioContext | null = null;
let stream: MediaStream | null = null;
let workletUrl: string | null = null;
let engine: WakeWordEngine | null = null;

function configureOrt(): void {
  // The only wasm variant bundled is the simd-threaded asyncify build (/ort/),
  // copied from onnxruntime-web at build time. Single-thread keeps it simple and
  // avoids needing cross-origin-isolation headers in the offscreen doc.
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = 1;
}

export function isWakeRunning(): boolean {
  return running;
}

export async function startWakeWord(): Promise<void> {
  if (running) return;
  configureOrt();

  engine = new WakeWordEngine({
    tensor: (data, dims) => new ort.Tensor("float32", data, dims),
    onDetect: (d: WakeDetection) => {
      log.info("[wake] detected", d.keyword, d.score.toFixed(3));
      // Open the Divinci panel — same action as the user clicking "Ask Divinci".
      chrome.runtime.sendMessage({ type: "internal:open-overlay" }).catch(() => {});
      chrome.runtime
        .sendMessage({ type: "internal:wake-detected", keyword: d.keyword, score: d.score })
        .catch(() => {});
    },
  });

  await engine.load(
    // ort's InferenceSession is structurally compatible with our minimal
    // InferenceSessionLike (run/inputNames/outputNames); cast at the boundary.
    async (p) =>
      (await ort.InferenceSession.create(p, {
        executionProviders: ["wasm"],
      })) as unknown as InferenceSessionLike,
    { melspectrogram: `${MODELS_BASE}/melspectrogram.onnx`, embedding: `${MODELS_BASE}/embedding_model.onnx` },
    [STOCK_KEYWORD],
  );

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  // Forcing the context to 16kHz resamples the mic stream for us; the worklet
  // then emits 1280-sample (80ms) frames at exactly the rate the models expect.
  audioContext = new AudioContext({ sampleRate: 16000 });
  workletUrl = wakeWorkletUrl();
  await audioContext.audioWorklet.addModule(workletUrl);
  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, "wake-audio-processor");
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    void engine?.processChunk(e.data).catch((err) => log.error("[wake] processChunk", err));
  };
  source.connect(node);
  // Keep the worklet pulling without routing mic audio to the speakers.
  node.connect(audioContext.destination);

  running = true;
  log.info("[wake] started (hey_jarvis, B0)");
}

export async function stopWakeWord(): Promise<void> {
  running = false;
  try {
    stream?.getTracks().forEach((t) => t.stop());
    await audioContext?.close();
  } catch (e) {
    log.debug("[wake] stop cleanup", e);
  }
  if (workletUrl) URL.revokeObjectURL(workletUrl);
  stream = null;
  audioContext = null;
  workletUrl = null;
  engine = null;
  log.info("[wake] stopped");
}
