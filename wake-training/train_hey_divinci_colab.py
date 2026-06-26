#!/usr/bin/env python3
"""
One-shot "Hey Divinci" wake-word training for Google Colab (T4 GPU).

This bakes in every fix discovered driving the openWakeWord auto-trainer on
current Colab (Python 3.12 / torch 2.11 / piper-tts 1.3) — the official notebook
is bit-rotted against all of these. Proven to reach training end-to-end; the only
reason it wasn't finished live was the FREE Colab runtime idle-preempting.

HOW TO RUN (reliably):
  - Use Colab Pro OR keep the Colab tab FOREGROUNDED the whole time (free runtimes
    idle-preempt when the tab is backgrounded, which wipes everything mid-run).
  - New notebook → Runtime ▸ Change runtime type ▸ T4 GPU.
  - Paste this whole file into ONE cell and run it (or: upload + `!python train_hey_divinci_colab.py`).
  - It's idempotent: if the runtime resets, just re-run — finished stages are skipped.
  - At the end it base64-prints `hey_divinci.onnx` (also saves the raw file). Copy
    the model out, or mount Drive and copy there.

Fixes baked in (each was a hard failure on stock Colab):
  1. piper-phonemize is dead on py3.12 → use piper-tts 1.3 via the new
     piper-sample-generator, bridged by a `generate_samples.py` shim.
  2. The new libritts model emits 22050 Hz → shim resamples to 16 kHz
     (train.py reads clips with scipy.wavfile and assumes 16 kHz).
  3. AudioSet HF tar is gated/empty → use ESC-50 for background noise.
  4. torchaudio 2.x removed set_audio_backend/get_audio_backend → restored as no-ops.
  5. torchaudio 2.x removed torchaudio.info → soundfile-backed shim.
  6. PyTorch 2.6 defaults weights_only=True → patch deep-phonemizer's torch.load.
"""
import os, sys, subprocess, glob, importlib
os.chdir("/content")

def sh(c):
    subprocess.run(c, shell=True, check=False)

def have(m):
    try:
        importlib.import_module(m); return True
    except Exception:
        return False

# ---- 1. Clone + install ----------------------------------------------------
if not os.path.exists("piper-sample-generator"):
    sh("git clone -q https://github.com/rhasspy/piper-sample-generator")
    sh("wget -q -O piper-sample-generator/models/en_US-libritts_r-medium.pt "
       "'https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt'")
if not os.path.exists("openwakeword"):
    sh("git clone -q https://github.com/dscripka/openwakeword")

sh("apt-get -qq install -y espeak-ng >/dev/null 2>&1")
if not have("openwakeword"):
    sh(f"{sys.executable} -m pip install -q -e ./openwakeword")
if not have("piper_sample_generator"):
    # Editable install of the clone (provides piper-tts 1.3 + the package).
    sh(f"{sys.executable} -m pip install -q -e ./piper-sample-generator")
for mod, pip in [("mutagen","mutagen==1.47.0"),("torchinfo","torchinfo==1.8.0"),
                 ("torchmetrics","torchmetrics==1.2.0"),("speechbrain","speechbrain==0.5.14"),
                 ("audiomentations","audiomentations==0.33.0"),
                 ("torch_audiomentations","torch-audiomentations==0.11.0"),
                 ("acoustics","acoustics==0.2.6"),("pronouncing","pronouncing==0.2.0"),
                 ("datasets","datasets==2.14.6"),("dp","deep-phonemizer==0.0.19")]:
    # torch_audiomentations can't import until torchaudio is patched (below); check by path.
    if mod == "torch_audiomentations":
        try:
            import torch_audiomentations  # noqa
        except AttributeError:
            pass  # installed but torchaudio-incompat — patched next
        except ModuleNotFoundError:
            sh(f"{sys.executable} -m pip install -q {pip}")
        continue
    if not have(mod):
        sh(f"{sys.executable} -m pip install -q {pip}")
os.makedirs("openwakeword/openwakeword/resources/models", exist_ok=True)
for m in ["embedding_model.onnx", "melspectrogram.onnx"]:
    p = f"openwakeword/openwakeword/resources/models/{m}"
    if not os.path.exists(p):
        sh(f"wget -q https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/{m} -O {p}")
print("[1] install done")

# ---- 2. Staleness patches (fixes 4,5,6) ------------------------------------
import torchaudio
ta = os.path.join(os.path.dirname(torchaudio.__file__), "__init__.py"); s = open(ta).read()
if "compat_audio_backend_shim" not in s:
    s += ("\n# compat_audio_backend_shim\n"
          "def set_audio_backend(*a, **k):\n return None\n"
          "def get_audio_backend(*a, **k):\n return 'soundfile'\n"
          "def list_audio_backends(*a, **k):\n return ['soundfile']\n")
if "compat_info_shim" not in s:
    s += ("\n# compat_info_shim\n"
          "def info(fp, *a, **k):\n"
          " import soundfile as _sf\n _i = _sf.info(str(fp))\n"
          " class _M: pass\n m = _M(); m.num_frames=_i.frames; m.sample_rate=_i.samplerate\n"
          " m.num_channels=_i.channels; m.bits_per_sample=16; m.encoding='PCM_S'; return m\n")
open(ta, "w").write(s)
import dp
dpm = os.path.join(os.path.dirname(dp.__file__), "model", "model.py"); ds = open(dpm).read()
if "weights_only=False" not in ds:
    open(dpm, "w").write(ds.replace(
        "torch.load(checkpoint_path, map_location=device)",
        "torch.load(checkpoint_path, map_location=device, weights_only=False)"))
print("[2] patches done")

# ---- 3. generate_samples shim (fixes 1,2) ----------------------------------
open("piper-sample-generator/generate_samples.py", "w").write('''import os, glob, uuid, tempfile, shutil
import numpy as np, librosa, scipy.io.wavfile
from piper_sample_generator.__main__ import generate_samples as _gen
_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "en_US-libritts_r-medium.pt")
def generate_samples(text, output_dir, max_samples=None, model=None, file_names=None, **kw):
    kw.pop("auto_reduce_batch_size", None)
    tmp = tempfile.mkdtemp()
    _gen(text=text, output_dir=tmp, model=model or _MODEL, max_samples=max_samples, **kw)
    os.makedirs(output_dir, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(tmp, "*.wav"))):
        y, _ = librosa.load(f, sr=16000, mono=True)
        scipy.io.wavfile.write(os.path.join(output_dir, uuid.uuid4().hex + ".wav"),
                               16000, (y * 32767).astype(np.int16))
    shutil.rmtree(tmp, ignore_errors=True)
''')
print("[3] shim done")

# ---- 4. Data: RIRs, ESC-50 background (fix 3), ACAV negatives, FP validation ----
import numpy as np, scipy.io.wavfile, datasets, librosa
from pathlib import Path
from tqdm import tqdm
os.makedirs("mit_rirs", exist_ok=True)
if len(os.listdir("mit_rirs")) < 10:
    for row in tqdm(datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses",
                                          split="train", streaming=True), desc="rirs"):
        scipy.io.wavfile.write(os.path.join("mit_rirs", row["audio"]["path"].split("/")[-1]),
                               16000, (row["audio"]["array"] * 32767).astype(np.int16))
if not os.path.exists("ESC-50-master"):
    sh("wget -q -O esc50.zip https://github.com/karoldvl/ESC-50/archive/master.zip && unzip -q -o esc50.zip")
os.makedirs("background_16k", exist_ok=True)
if len(os.listdir("background_16k")) < 100:
    for f in tqdm(sorted(glob.glob("ESC-50-master/audio/*.wav")), desc="esc50->16k"):
        y, _ = librosa.load(f, sr=16000, mono=True)
        scipy.io.wavfile.write(os.path.join("background_16k", os.path.basename(f)),
                               16000, (y * 32767).astype(np.int16))
for url in ["https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
            "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy"]:
    fn = url.split("/")[-1]
    if not os.path.exists(fn):
        sh(f'wget -q -O {fn} "{url}"')
print("[4] data ready")

# ---- 5. Config -------------------------------------------------------------
import yaml
config = yaml.load(open("openwakeword/examples/custom_model.yml").read(), yaml.Loader)
config["target_phrase"] = ["hey divinci", "hey da vinci", "hey davinchi"]
config["custom_negative_phrases"] = ["da vinci", "divinci", "hey vinny"]
config["model_name"] = "hey_divinci"
config["n_samples"] = 2000
config["n_samples_val"] = 500
config["steps"] = 15000
config["target_accuracy"] = 0.6
config["target_recall"] = 0.25
config["piper_sample_generator_path"] = "./piper-sample-generator"
config["output_dir"] = "./hey_divinci_model"
config["rir_paths"] = ["./mit_rirs"]
config["background_paths"] = ["./background_16k"]
config["background_paths_duplication_rate"] = [1]
config["false_positive_validation_data_path"] = "validation_set_features.npy"
config["feature_data_files"] = {"ACAV100M_sample": "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"}
yaml.dump(config, open("hey_divinci.yaml", "w"))
print("[5] config written")

# ---- 6/7/8. Generate → augment → train ------------------------------------
T = "openwakeword/openwakeword/train.py"
sh(f"{sys.executable} {T} --training_config hey_divinci.yaml --generate_clips")
sh(f"{sys.executable} {T} --training_config hey_divinci.yaml --augment_clips")
sh(f"{sys.executable} {T} --training_config hey_divinci.yaml --train_model")

# ---- 9. Export -------------------------------------------------------------
import base64
onnx = "hey_divinci_model/hey_divinci.onnx"
if os.path.exists(onnx):
    print(f"[9] hey_divinci.onnx = {os.path.getsize(onnx)} bytes")
    print("BEGIN_ONNX_B64")
    print(base64.b64encode(open(onnx, "rb").read()).decode())
    print("END_ONNX_B64")
else:
    print("[9] ERROR: hey_divinci.onnx not found — check the train step output above")
