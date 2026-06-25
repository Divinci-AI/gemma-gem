# Training "Hey Divinci" (Phase B1)

B0 ships the stock `hey_jarvis` head to prove the runtime. B1 trains a custom
**"Hey Divinci"** head and swaps it in. Output is a ~200 KB ONNX model with input
`[1, 16, 96]` — exactly what `shared/wake/wake-engine.ts` expects, so it drops in
with no code change to the engine.

Auto-training needs **Linux + GPU + Piper TTS** (synthetic sample generation is
Linux-only). Easiest path is **Google Colab (GPU runtime)**.

## Option A — Colab (recommended)

1. Open openWakeWord's training notebook in Colab with a GPU runtime:
   https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb
2. Run the setup cells (they clone openWakeWord + `piper-sample-generator` and
   download the augmentation data: MIT RIRs, background clips, the ACAV100M
   feature `.npy`, and the false-positive validation set).
3. Replace the notebook's config with **`hey_divinci.yaml`** from this folder
   (upload it, or paste its contents into the config cell). Paths in the YAML
   (`./piper-sample-generator`, `./mit_rirs`, …) match what the notebook creates.
4. **Listen to a few generated positive clips** before the long training step.
   If Piper mispronounces "Divinci", edit `target_phrase` (add/prune variants)
   and re-run the sample-gen cell. This is the single biggest quality lever.
5. Run training to completion (~30–60 min on a Colab T4 at 50k steps).
6. Download the result: `hey_divinci_model/hey_divinci.onnx`.

## Option B — Linux + CUDA box

```bash
git clone https://github.com/dscripka/openWakeWord && cd openWakeWord
pip install -e .
git clone https://github.com/rhasspy/piper-sample-generator
# Download augmentation data per the notebook's setup cells (RIRs, background,
# ACAV100M features .npy, validation_set_features.npy), then:
python openwakeword/train.py --training_config /path/to/hey_divinci.yaml --generate_clips --augment_clips --train_model
```

## Install into the extension — pure drop-in (no code change)

1. Copy the trained model in:
   ```bash
   cp hey_divinci.onnx <repo>/public/models/wake/hey_divinci.onnx
   ```
   `offscreen/wake-host.ts` auto-prefers `hey_divinci.onnx` when present and
   falls back to the bundled `hey_jarvis` when it isn't — so no code edit is
   needed (mel + embedding models are shared and unchanged).
2. Rebuild + reload: `pnpm build`, reload the unpacked extension, popup → enable
   Wake word, say **"Hey Divinci"**. The offscreen console should log
   `[wake] keyword head: hey_divinci` then `[wake] detected hey_divinci <score>`.

## Tuning

- Too hard to trigger → lower `DEFAULT_WAKE_CONFIG.detectionThreshold`
  (wake-engine.ts) before retraining, or retrain with a higher
  `target_false_positives_per_hour`.
- Too many false wakes → raise the threshold, add observed confusables to
  `custom_negative_phrases`, and (B2) gate on the Silero VAD.
- Keep the stock `hey_jarvis` head bundled as a fallback/A-B reference until
  "Hey Divinci" is dialed in.
