/**
 * AudioWorklet source for wake-word capture (Phase B0). Inlined as a string and
 * loaded via a Blob URL (same approach as openwakeword_wasm) so we don't depend
 * on WXT/Vite worklet asset bundling. Accumulates the AudioContext's 16kHz mono
 * stream into 1280-sample (80ms) frames and posts each to the main thread.
 */
export const WAKE_WORKLET_SOURCE = `
class WakeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 1280;
    this._buffer = new Float32Array(this.bufferSize);
    this._pos = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this._buffer[this._pos++] = input[i];
        if (this._pos === this.bufferSize) {
          this.port.postMessage(this._buffer.slice(0));
          this._pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('wake-audio-processor', WakeAudioProcessor);
`;

/** Create a Blob URL for `audioWorklet.addModule()`. Caller revokes when done. */
export function wakeWorkletUrl(): string {
  const blob = new Blob([WAKE_WORKLET_SOURCE], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}
