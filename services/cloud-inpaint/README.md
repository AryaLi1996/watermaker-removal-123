# Cloud inpainting service

The learned filler that `backend/dewatermark.py` cannot afford to run locally.

## Why it is here

Undoing the blend recovers most of the picture arithmetically, on any machine,
in milliseconds. What is left is the few percent of pixels the mark covered
opaquely, and filling those with a diffusion inpainter leaves a trace that is
still legible: measured against the mark's own shape, 0.081 where the untouched
input reads 0.866 and a clean region reads 0.

A learned filler takes that to -0.001 +- 0.071 — indistinguishable from no mark
at all — without being any less faithful to the true picture (6.65 levels of
error against known frames, against 6.79 for the local filler). It costs about
a second a frame on four CPU cores, which is an hour for a two-minute clip, so
it does not belong on the user's machine.

## What crosses the network

The marked rectangle only. On the clip this was developed against that is
119x68 pixels of a 320x568 frame — the service never receives the rest of the
picture, and cannot reconstruct it. The mask is one image for the whole job.

    WebP q90, 2.7 KB a frame:  9.5 MB up and the same down for a 2-minute clip
    the whole video file, for comparison:  11.9 MB

## Running it

    pip install -r requirements.txt
    LAMA_ONNX=/path/to/lama.onnx python -m uvicorn app:api --port 8000

The model is not vendored: it is a 208 MB file, and where it lives is a
deployment decision. `Carve/LaMa-ONNX` on Hugging Face is the one these numbers
were measured with.

## What it is not

Deployment, authentication and accounting are not here. The app already shares
a licence service, and whatever meters this should live alongside it rather
than being invented twice — at roughly $0.015 of GPU time per two-minute clip,
something has to.
