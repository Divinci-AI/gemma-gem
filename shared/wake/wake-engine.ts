/**
 * WakeWordEngine — in-browser openWakeWord inference (Phase B0 of ambient voice).
 *
 * Faithful TS port of the streaming cadence from dnavarrom/openwakeword_wasm
 * (MIT) so detection actually fires (a subtle cadence bug = silent never-detect).
 * Pipeline per 1280-sample (80ms) 16kHz mono chunk:
 *   chunk → melspectrogram.onnx → 5 mel frames (x/10+2)
 *   while melBuffer ≥ 76 frames: first-76 → embedding_model.onnx → 96-d vector
 *     → per keyword: shift 16-history, push, run head → score; splice(0,8)
 * Threshold + cooldown gate the `onDetect` callback.
 *
 * ort sessions are injectable (createSession) so the cadence is unit-testable
 * without real ONNX. Defaults to onnxruntime-web. VAD is intentionally out of B0
 * (added in B2); isSpeechActive defaults true.
 */

export interface OrtTensorLike {
  data: Float32Array | Int8Array | Uint8Array | number[];
}
export interface InferenceSessionLike {
  inputNames: string[];
  outputNames: string[];
  inputMetadata?: unknown;
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
}

/** Build an input tensor — injectable so tests don't need onnxruntime-web. */
export type TensorFactory = (data: Float32Array, dims: number[]) => unknown;
export type SessionFactory = (modelPath: string) => Promise<InferenceSessionLike>;

export interface WakeKeywordSpec {
  /** Stable id, e.g. "hey_jarvis". */
  name: string;
  /** Resolvable model path/URL for the keyword head. */
  model: string;
}

export interface WakeEngineConfig {
  frameSize: number; // samples per chunk (1280)
  embeddingWindowSize: number; // keyword head window in embeddings (16)
  detectionThreshold: number; // score > this → candidate detection
  cooldownMs: number; // refractory after a detection
}

export const DEFAULT_WAKE_CONFIG: WakeEngineConfig = {
  frameSize: 1280,
  embeddingWindowSize: 16,
  detectionThreshold: 0.5,
  cooldownMs: 2000,
};

const MEL_BINS = 32;
const MEL_FRAMES_PER_CHUNK = 5;
const MEL_WINDOW = 76;
const MEL_STEP = 8;
const EMBED_DIM = 96;

interface LoadedKeyword {
  name: string;
  session: InferenceSessionLike;
  windowSize: number;
  history: Float32Array[];
}

export interface WakeDetection {
  keyword: string;
  score: number;
  at: number;
}

/** Pull the head window size (dim[1]) from session metadata; fall back to cfg. */
function inferKeywordWindowSize(session: InferenceSessionLike, fallback: number): number {
  const meta = session.inputMetadata as
    | Record<string, { isTensor?: boolean; shape?: unknown[] }>
    | Array<{ name?: string; isTensor?: boolean; shape?: unknown[] }>
    | undefined;
  const name = session.inputNames?.[0];
  if (!meta || !name) return fallback;
  const m = Array.isArray(meta)
    ? meta.find((x) => x?.name === name) ?? meta[0]
    : meta[name];
  const dim = m?.isTensor && Array.isArray(m.shape) ? m.shape[1] : undefined;
  return typeof dim === "number" && Number.isFinite(dim) ? dim : fallback;
}

export class WakeWordEngine {
  private cfg: WakeEngineConfig;
  private tensor: TensorFactory;
  private melSession: InferenceSessionLike | null = null;
  private embeddingSession: InferenceSessionLike | null = null;
  private keywords: LoadedKeyword[] = [];
  private melBuffer: Float32Array[] = [];
  private cooling = false;
  private onDetect?: (d: WakeDetection) => void;
  /** Test/diagnostic hook: latest score per keyword. */
  lastScores: Record<string, number> = {};

  constructor(opts: {
    config?: Partial<WakeEngineConfig>;
    tensor: TensorFactory;
    onDetect?: (d: WakeDetection) => void;
    now?: () => number;
  }) {
    this.cfg = { ...DEFAULT_WAKE_CONFIG, ...opts.config };
    this.tensor = opts.tensor;
    this.onDetect = opts.onDetect;
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : 0));
  }

  private now: () => number;

  /** Load shared (mel, embedding) + keyword head sessions via the injected factory. */
  async load(
    createSession: SessionFactory,
    paths: { melspectrogram: string; embedding: string },
    keywords: WakeKeywordSpec[],
  ): Promise<void> {
    this.melSession = await createSession(paths.melspectrogram);
    this.embeddingSession = await createSession(paths.embedding);
    this.keywords = [];
    for (const kw of keywords) {
      const session = await createSession(kw.model);
      const windowSize = inferKeywordWindowSize(session, this.cfg.embeddingWindowSize);
      this.keywords.push({
        name: kw.name,
        session,
        windowSize,
        history: Array.from({ length: windowSize }, () => new Float32Array(EMBED_DIM)),
      });
    }
    this.melBuffer = [];
  }

  reset(): void {
    this.melBuffer = [];
    for (const kw of this.keywords) {
      kw.history = Array.from({ length: kw.windowSize }, () => new Float32Array(EMBED_DIM));
    }
    this.cooling = false;
  }

  /**
   * Feed one frameSize-sample chunk. Returns any detection emitted this call
   * (also delivered via onDetect). `isSpeechActive` lets a future VAD gate it.
   */
  async processChunk(chunk: Float32Array, isSpeechActive = true): Promise<WakeDetection | null> {
    if (!this.melSession || !this.embeddingSession) {
      throw new Error("WakeWordEngine.load() must be called before processChunk()");
    }
    const mel = this.melSession;
    const melOut = await mel.run({ [mel.inputNames[0]]: this.tensor(chunk, [1, this.cfg.frameSize]) });
    const melData = melOut[mel.outputNames[0]].data as Float32Array;
    // openWakeWord normalization + take exactly 5 frames of 32 mel bins.
    for (let j = 0; j < MEL_FRAMES_PER_CHUNK; j++) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) {
        frame[b] = (melData[j * MEL_BINS + b] as number) / 10.0 + 2.0;
      }
      this.melBuffer.push(frame);
    }

    let detection: WakeDetection | null = null;
    const embed = this.embeddingSession;
    while (this.melBuffer.length >= MEL_WINDOW) {
      const flatMel = new Float32Array(MEL_WINDOW * MEL_BINS);
      for (let f = 0; f < MEL_WINDOW; f++) flatMel.set(this.melBuffer[f], f * MEL_BINS);
      const embOut = await embed.run({
        [embed.inputNames[0]]: this.tensor(flatMel, [1, MEL_WINDOW, MEL_BINS, 1]),
      });
      const embVec = new Float32Array(embOut[embed.outputNames[0]].data as Float32Array);

      for (const kw of this.keywords) {
        kw.history.shift();
        kw.history.push(embVec);
        const flatEmb = new Float32Array(kw.windowSize * EMBED_DIM);
        for (let j = 0; j < kw.history.length; j++) flatEmb.set(kw.history[j], j * EMBED_DIM);
        const out = await kw.session.run({
          [kw.session.inputNames[0]]: this.tensor(flatEmb, [1, kw.windowSize, EMBED_DIM]),
        });
        const score = Number((out[kw.session.outputNames[0]].data as Float32Array)[0]);
        this.lastScores[kw.name] = score;
        if (
          score > this.cfg.detectionThreshold &&
          isSpeechActive &&
          !this.cooling
        ) {
          this.cooling = true;
          detection = { keyword: kw.name, score, at: this.now() };
          this.onDetect?.(detection);
          setTimeout(() => {
            this.cooling = false;
          }, this.cfg.cooldownMs);
        }
      }
      this.melBuffer.splice(0, MEL_STEP);
    }
    return detection;
  }
}
