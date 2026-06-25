import { describe, it, expect, vi } from "vitest";
import {
  WakeWordEngine,
  type InferenceSessionLike,
  type OrtTensorLike,
} from "./wake-engine";

// Identity tensor factory — fakes don't use real ort tensors.
const tensor = (data: Float32Array) => ({ data });

function fakeSession(
  outName: string,
  produce: (feeds: Record<string, unknown>) => Float32Array,
  opts: { windowSize?: number } = {},
): InferenceSessionLike & { calls: number } {
  const s = {
    inputNames: ["in"],
    outputNames: [outName],
    calls: 0,
    inputMetadata: opts.windowSize
      ? { in: { isTensor: true, shape: [1, opts.windowSize, 96] } }
      : undefined,
    async run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>> {
      s.calls++;
      return { [outName]: { data: produce(feeds) } };
    },
  };
  return s;
}

function build(scoreSeq: number[]) {
  const mel = fakeSession("mel", () => new Float32Array(5 * 32).fill(1)); // 5 frames/chunk
  const embed = fakeSession("emb", () => new Float32Array(96).fill(0.1));
  let i = 0;
  const head = fakeSession(
    "score",
    () => new Float32Array([scoreSeq[Math.min(i++, scoreSeq.length - 1)]]),
    { windowSize: 16 },
  );
  return { mel, embed, head };
}

async function load(engine: WakeWordEngine, f: ReturnType<typeof build>) {
  const map: Record<string, InferenceSessionLike> = {
    mel: f.mel,
    embed: f.embed,
    head: f.head,
  };
  await engine.load(
    async (p) => map[p],
    { melspectrogram: "mel", embedding: "embed" },
    [{ name: "hey_jarvis", model: "head" }],
  );
}

describe("WakeWordEngine cadence", () => {
  it("runs no embedding until the mel buffer reaches 76 frames, then drains", async () => {
    const f = build([0]);
    const engine = new WakeWordEngine({ tensor });
    await load(engine, f);

    const chunk = new Float32Array(1280);
    // 5 frames/chunk → 15 chunks = 75 frames (<76): no embedding yet.
    for (let n = 0; n < 15; n++) await engine.processChunk(chunk);
    expect(f.embed.calls).toBe(0);

    // 16th chunk → 80 frames ≥76 → exactly one embedding pass (then splice 8).
    await engine.processChunk(chunk);
    expect(f.embed.calls).toBe(1);
    expect(f.head.calls).toBe(1);
  });

  it("fires onDetect once over threshold and respects the cooldown", async () => {
    vi.useFakeTimers();
    const onDetect = vi.fn();
    // Score stays high so every head run would exceed threshold.
    const f = build([0.9]);
    const engine = new WakeWordEngine({
      tensor,
      onDetect,
      config: { detectionThreshold: 0.5, cooldownMs: 1000 },
      now: () => 0,
    });
    await load(engine, f);

    const chunk = new Float32Array(1280);
    for (let n = 0; n < 20; n++) await engine.processChunk(chunk);

    // Multiple head runs cleared threshold, but cooldown gates to a single emit.
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(onDetect.mock.calls[0][0]).toMatchObject({ keyword: "hey_jarvis" });

    vi.advanceTimersByTime(1001); // cooldown elapses
    for (let n = 0; n < 5; n++) await engine.processChunk(chunk);
    expect(onDetect).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stays silent below threshold", async () => {
    const onDetect = vi.fn();
    const f = build([0.2]);
    const engine = new WakeWordEngine({ tensor, onDetect, config: { detectionThreshold: 0.5 } });
    await load(engine, f);
    const chunk = new Float32Array(1280);
    for (let n = 0; n < 20; n++) await engine.processChunk(chunk);
    expect(onDetect).not.toHaveBeenCalled();
  });
});
