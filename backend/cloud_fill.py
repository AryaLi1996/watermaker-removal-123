"""
Handing the mark's opaque pixels to a service that can afford a learned filler.

`dewatermark` recovers most of the picture by arithmetic, on any machine, in
milliseconds. The few percent the mark covered opaquely have to be invented,
and what invents them decides whether the result still reads as a watermark.
A diffusion filler leaves 0.081 of the mark's own shape behind where the
untouched input reads 0.866; a learned one leaves -0.001 +- 0.071, which is
nothing. It costs about a second a frame on four cores, so it runs elsewhere.

This module is the client half. It is deliberately three separable pieces:

  * what crosses the wire, as pure functions over arrays and bytes, so the
    format can be tested without a socket;
  * the request, so a caller can be tested with a stub in place of a network;
  * the decision to use either, which always has an answer that does not need
    the network — a service that is slow, down, or refused is a fallback to
    the local filler and a note saying so, never a failed export.

Only the mark's bounding box leaves the machine. On the clip this was built
for that is 119x68 pixels of a 320x568 frame: the service cannot see the rest
of the picture, and 2.7 KB a frame in WebP is less traffic than sending the
video would have been.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np

# Frames per request. Large enough that the per-request overhead disappears
# against the inference, small enough that a dropped connection costs a few
# seconds of video rather than the export.
FRAMES_PER_REQUEST = 240

# Lossy for the picture, lossless for the mask. The patches are about to be
# re-encoded into H.264 regardless, and WebP at this quality measured 2.7 KB a
# frame against 11.1 for PNG. A mask that loses a pixel leaves a mark behind,
# so it does not get the same treatment.
PATCH_QUALITY = 90

# How long to wait before falling back. A service worth using answers a batch
# in a few seconds; one that does not is not worth holding an export for.
REQUEST_TIMEOUT_SECONDS = 120.0

# Clean picture to include around the mark, as a fraction of the box's longer
# side and at least this many pixels.
#
# Worth a little, and only a little. Measured end to end, the mark's own shape
# survives at 0.004 with no margin at all and -0.017 with this one, both of
# which are nothing against the 0.866 of the untouched input; it costs 11% more
# traffic. Widening it further changes neither.
#
# It is not what makes the filler work, though the first version of this said
# so: sending the bare bounding box did measure badly, but the cause was the
# service scaling the patch to less than its model's input, not the crop.
MARGIN_RATIO = 0.15
MARGIN_MIN = 8


@dataclass(frozen=True)
class Parcel:
    """The part of the selection that actually has to travel."""

    box: tuple[int, int, int, int]   # x, y, w, h within the selection
    mask: np.ndarray                 # uint8, 1 where the mark is, box-sized

    @property
    def pixels(self) -> int:
        return int(self.mask.size)


def parcel_for(mark: np.ndarray) -> Parcel | None:
    """
    The box around the mark, with enough clean picture around it to fill from.

    `mark` is uint8, non-zero where the filler must repaint. Returns None when
    there is nothing to send, which is a perfectly ordinary answer: a selection
    the user drew over something the solve found no mark in.
    """
    ys, xs = np.nonzero(mark)
    if len(ys) == 0:
        return None
    height, width = mark.shape
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1

    margin = max(MARGIN_MIN, int(MARGIN_RATIO * max(x1 - x0, y1 - y0)))
    x0, y0 = max(0, x0 - margin), max(0, y0 - margin)
    x1, y1 = min(width, x1 + margin), min(height, y1 + margin)

    return Parcel(box=(x0, y0, x1 - x0, y1 - y0),
                  mask=(mark[y0:y1, x0:x1] > 0).astype(np.uint8))


def encode_patch(patch: np.ndarray) -> str:
    """One frame's box, as the service expects it."""
    ok, buf = cv2.imencode('.webp', patch, [cv2.IMWRITE_WEBP_QUALITY, PATCH_QUALITY])
    if not ok:
        raise ValueError('could not encode a patch')
    return base64.b64encode(buf.tobytes()).decode('ascii')


def encode_mask(mask: np.ndarray) -> str:
    """The mask, once per job, losslessly."""
    ok, buf = cv2.imencode('.png', (mask > 0).astype(np.uint8) * 255)
    if not ok:
        raise ValueError('could not encode the mask')
    return base64.b64encode(buf.tobytes()).decode('ascii')


def decode_patch(blob: str, shape: tuple[int, int]) -> np.ndarray:
    """One frame back from the service, checked against what we asked for."""
    raw = base64.b64decode(blob, validate=True)
    patch = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if patch is None:
        raise ValueError('the service returned something that is not an image')
    if patch.shape[:2] != shape:
        raise ValueError(
            f'the service returned a {patch.shape[1]}x{patch.shape[0]} patch '
            f'where {shape[1]}x{shape[0]} was sent')
    return patch


def request_body(parcel: Parcel, patches: list[np.ndarray]) -> bytes:
    """A whole request, ready to post. Pure, so the format has a test."""
    return json.dumps({
        'mask_png': encode_mask(parcel.mask),
        'frames_webp': [encode_patch(p) for p in patches],
    }).encode('utf-8')


def read_reply(body: bytes, parcel: Parcel, expected: int) -> list[np.ndarray]:
    """The service's answer, or an exception naming what was wrong with it."""
    payload = json.loads(body.decode('utf-8'))
    frames = payload.get('frames_webp')
    if not isinstance(frames, list):
        raise ValueError('the service did not return a list of frames')
    if len(frames) != expected:
        raise ValueError(f'asked for {expected} frames, got {len(frames)}')
    shape = (parcel.box[3], parcel.box[2])
    return [decode_patch(blob, shape) for blob in frames]


def batches(count: int, size: int = FRAMES_PER_REQUEST):
    """The frame ranges a clip is split into."""
    for start in range(0, count, size):
        yield start, min(start + size, count)


# Hosts the frames may travel to over plain HTTP. Only the loopback ones, so a
# stub service in a test does not need a certificate — and nothing else does,
# because everything that leaves this machine is part of the user's picture and
# they were asked before it went.
LOCAL_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1', '[::1]'})


def check_endpoint(url: str) -> None:
    """
    Refuse an endpoint that would send the picture in the clear.

    Raised rather than warned: the consent the user gave was to one named
    service over a link nobody else can read, and quietly settling for less
    than that is the one failure they cannot see happening.
    """
    parsed = urlparse(url)
    if parsed.scheme == 'https':
        return
    if parsed.scheme == 'http' and parsed.hostname in LOCAL_HOSTS:
        return
    raise ValueError(
        f'the fill service must be reached over https, not {parsed.scheme!r}')


def post(url: str, body: bytes, token: str | None = None,
         timeout: float = REQUEST_TIMEOUT_SECONDS) -> bytes:
    """
    One request to the fill service.

    Separated from `fill` so the rest of this file can be tested without a
    socket, and so there is exactly one place that knows how the service is
    addressed.
    """
    check_endpoint(url)
    request = Request(url, data=body, method='POST')
    request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('Authorization', f'Bearer {token}')
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 — scheme checked above
        return response.read()


def fill(parcel: Parcel, patches: list[np.ndarray], url: str,
         token: str | None = None, timeout: float = REQUEST_TIMEOUT_SECONDS,
         transport=None) -> list[np.ndarray]:
    """
    Every frame's box, filled by the service, in the order they were given.

    Raises on anything at all — a refusal, a timeout, an answer that is not the
    shape that was asked for. That is deliberate: the caller's job is to fall
    back to the local filler and say so, and it can only do that if this does
    not quietly hand back something half-right.
    """
    # Looked up now rather than bound as a default, so that a test can put a
    # stub service in `post` and have this find it.
    send = transport or post
    filled: list[np.ndarray] = []
    for start, end in batches(len(patches)):
        reply = send(url, request_body(parcel, patches[start:end]), token, timeout)
        filled.extend(read_reply(reply, parcel, end - start))
    return filled
