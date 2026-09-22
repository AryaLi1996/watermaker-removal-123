"""
The HTTP face of the inpainting service.

One route. A job is a mask and a run of frames, and the reply is those frames
with the mark's pixels repainted — so the client can hand over as much or as
little of a clip as its own batching decides, and a dropped request costs that
batch rather than the export.

Everything is WebP: the patches are small and lossy is fine for pixels that
are about to be re-encoded into an H.264 stream anyway, and it measured 2.7 KB
a frame against 11.1 for PNG on the clip this was built for. The mask is PNG,
because a mask that loses a pixel is a mask that leaves a mark behind, and it
is sent once per job rather than once per frame.
"""
from __future__ import annotations

import base64
import io

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import inpaint

# A job is bounded so one client cannot hold the whole service. The client
# splits a clip into runs of this size; the reported clip is 3457 frames, so
# it arrives as a few dozen requests rather than one.
MAX_FRAMES_PER_JOB = 240

api = FastAPI(title='cloud-inpaint', version='1')


class Job(BaseModel):
    """A mask, and the frames to apply it to."""

    mask_png: str = Field(description='base64 PNG, non-zero where the mark is')
    frames_webp: list[str] = Field(description='base64 WebP, RGB, all the mask\'s size')


class Filled(BaseModel):
    frames_webp: list[str]


def _decode(blob: str, flags: int) -> np.ndarray:
    try:
        raw = base64.b64decode(blob, validate=True)
    except Exception as exc:  # noqa: BLE001 - the client gets one answer either way
        raise HTTPException(400, 'a field was not valid base64') from exc
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), flags)
    if image is None:
        raise HTTPException(400, 'a field was not a decodable image')
    return image


@api.get('/health')
def health() -> dict:
    """Whether this process can answer, which means whether the model loaded."""
    try:
        inpaint.session()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f'model unavailable: {exc}') from exc
    return {'ok': True, 'max_frames_per_job': MAX_FRAMES_PER_JOB}


@api.post('/inpaint', response_model=Filled)
def run(job: Job) -> Filled:
    if not job.frames_webp:
        raise HTTPException(400, 'a job needs at least one frame')
    if len(job.frames_webp) > MAX_FRAMES_PER_JOB:
        raise HTTPException(413, f'at most {MAX_FRAMES_PER_JOB} frames a job')

    mask = _decode(job.mask_png, cv2.IMREAD_GRAYSCALE)
    mask = (mask > 127).astype(np.uint8)

    patches = []
    for blob in job.frames_webp:
        patch = _decode(blob, cv2.IMREAD_COLOR)
        if patch.shape[:2] != mask.shape:
            raise HTTPException(400, 'a frame was not the size of the mask')
        patches.append(cv2.cvtColor(patch, cv2.COLOR_BGR2RGB))

    try:
        filled = inpaint.fill(patches, mask)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    out = []
    for picture in filled:
        ok, buf = cv2.imencode('.webp', cv2.cvtColor(picture, cv2.COLOR_RGB2BGR),
                               [cv2.IMWRITE_WEBP_QUALITY, 95])
        if not ok:
            raise HTTPException(500, 'could not encode a reply frame')
        out.append(base64.b64encode(buf.tobytes()).decode('ascii'))
    return Filled(frames_webp=out)
