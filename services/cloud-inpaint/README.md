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

## Where it runs

AWS, `us-east-1`. Which is a deployment detail everywhere except in the app,
where it is the thing that decides what the user has to be told: for a user in
China, every export through this service is a cross-border transfer of personal
information, and PIPL article 39 asks for the overseas recipient by name, the
purpose and method, the categories, and how to exercise rights against that
recipient — with consent to that specifically, separately from anything else
they have agreed to. `renderer/src/cloud.ts` and `CloudConsentDialog.tsx` are
where that lives; moving the service into China would let both be shorter, and
moving it anywhere else changes neither.

The account the stack belongs to is not recorded here. It is deployment
configuration, it identifies a real account, and nothing in this repository
needs it to build or to run.

## Metering

The app asks before every export that would use this service, and tells it
afterwards what was used. Both routes live beside the licence ones on the
shared service (one base URL, dispatched by path suffix — see
`electron/license-config.js`), because who is entitled to what is a question
about an account, and that is where accounts already are.

**`POST fill/quota`** — may this export use the service?

    → { appId, deviceId, userId }
    ← { allowed:      true,
        limit:        100,              // included this period
        used:         12,
        remaining:    88,
        periodEnds:   "2026-10-01T00:00:00Z",
        overagePrice: "¥0.30",          // formatted by the service
        endpoint:     { url: "https://…/inpaint", token: "…" },
        reason:       null }            // a key the app has a sentence for,
                                        // when allowed is false

**`POST fill/consume`** — one export used it.

    → { appId, deviceId, userId, units }
    ← the same shape, with the new count

Two things about that shape are deliberate, and are the reason it is not three
constants in the app:

**Every number is the service's.** The allowance, the price beyond it, what
counts as one unit, when the period rolls over. Going from a hundred a month to
two hundred, changing the price, or charging per minute of video instead of per
export, is a change here and not a release everybody has to install. The app
renders what it is told and has no opinion.

**The endpoint comes back with the answer.** The app never holds a URL for this
service; it is given one per export, by the thing that just decided the export
was allowed. Turning the service off for everyone, or moving it, needs nothing
from the client.

The count is told after the fact rather than reserved before it, so what a user
is charged for is what they actually received: an export that fell back to the
local filler for every frame is not one of their hundred. And a service that
cannot be reached means the export is filled on the user's own machine — a
local count of something that costs money is a count that can be edited, and an
export that spends against a guess cannot be taken back.
