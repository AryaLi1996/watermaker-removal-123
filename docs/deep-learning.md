# Deep learning enhancement (ProPainter)

Temporal Fill has two engines behind one method. The default one follows the
motion between frames with optical flow and recovers the background behind a
watermark from a frame that actually shows it. That works whenever the picture
moves — and does nothing at all when it does not: a locked-off camera over a
still background never uncovers the pixels the mark is sitting on, and no
amount of flow will find what was never recorded.

The second engine is [ProPainter](https://github.com/sczhou/ProPainter)
(ICCV 2023), a learned video-inpainting model. It propagates what does exist
along the flow and invents the rest with a transformer, which is the only way
to get a plausible result on that kind of shot.

It is **optional and not bundled**. It needs PyTorch, CUDA and about 200 MB of
model weights — well over a gigabyte of install for a feature most users of
this app will never turn on, and none of it can be frozen into the installer.
Without it, the app behaves exactly as it did before: the switch is greyed out
with the reason, and Temporal Fill runs its optical-flow engine.

## Requirements

- An NVIDIA GPU with **at least 4 GB** of video memory (see the presets below)
- A CUDA-capable PyTorch build
- Roughly 2 GB of disk for the checkout, its dependencies and the weights

There is no CPU mode. ProPainter on a CPU is hours per minute of video, which
is not a feature, and the optical-flow engine is the answer on those machines.

## Install

```bash
# 1. Clone it next to the backend (or anywhere — see WATERMARK_PROPAINTER_HOME)
git clone https://github.com/sczhou/ProPainter.git backend/ProPainter

# 2. Give it an interpreter of its own. The app's own virtualenv deliberately
#    does not carry PyTorch: it is frozen into the shipped binary, and the
#    wheels are larger than the whole rest of the app.
python -m venv backend/ProPainter/.venv
backend/ProPainter/.venv/bin/python -m pip install \
  torch torchvision --index-url https://download.pytorch.org/whl/cu121
backend/ProPainter/.venv/bin/python -m pip install -r backend/ProPainter/requirements.txt
```

The weights are **not** part of this step. They are downloaded into
`backend/ProPainter/weights/` the first time a job actually uses the engine,
with progress reported as they come down — see `backend/propainter_weights.py`
for the three files and where they come from.

## Environment variables

| Variable | What it does |
|---|---|
| `WATERMARK_PROPAINTER_HOME` | Where the checkout lives. Default: `backend/ProPainter` |
| `WATERMARK_PROPAINTER_PYTHON` | The interpreter that can import torch. Default: `<home>/.venv`, then `python3` |
| `WATERMARK_PROPAINTER_WEIGHTS` | A directory of already-downloaded weights, copied into place instead of fetched. The offline install, and how CI would get the models without half a gigabyte of traffic per job |
| `WATERMARK_FORCE_NO_GPU=1` | Report no GPU whatever the machine has. How the fallback path is exercised on a machine that has one |

## Presets

The quality dial means something different here than it does for the
optical-flow engine: it picks the resolution the *model* runs at, which is what
decides whether a run fits in video memory. The repainted rectangle is scaled
back to the video's own resolution on the way out, and only that rectangle is
pasted over the frame — everything outside the selection keeps the pixels
ffmpeg extracted, at full resolution.

| Preset | Model resolution | Precision | Chunk | Needs |
|---|---|---|---|---|
| Fast | 576×320 | fp16 | 40 frames | 4 GB |
| Balanced | 720×480 | fp16 | 60 frames | 8 GB |
| High | 1280×720 | fp16 | 50 frames | 20 GB |

A card too small for the preset chosen **steps down** rather than refusing, and
the sidebar says which preset will actually run before the job starts. Video
length does not enter into it: the chunk size caps what is on the GPU at once,
so a ten-minute video costs time, not memory.

Previews always run the Fast preset, whatever the dial says. On this engine
the difference between presets is not a few seconds but a resolution the card
may not have the memory for, and a preview that dies of an allocation the
export would have survived is the worst possible way to find out.

## When it cannot run

Every failure is a fallback, never a lost export: the optical-flow engine
finishes the job and the app says what happened and why, in the same place it
reports frames that could not be rebuilt. That covers a missing checkout, a
missing GPU, a card too small, a failed download, and the model running out of
memory mid-run.

What it never does is fall back silently. An export that quietly used a
different engine than the one selected is an export nobody can reason about.
