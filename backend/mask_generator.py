"""
Masks for the learned inpainting engine.

Every other engine here is handed the selection as four numbers and paints
inside it directly. ProPainter is a separate program: it takes a directory of
frames and a mask on disk, and it decides what to repaint from the white
pixels in that mask. This module is the translation between the two.

The selection this app produces is a rectangle that does not move — the user
drags one box over a station logo and it stays there for the whole video — so
one PNG describes every frame of the job, and ProPainter accepts exactly that:
a single mask file is broadcast over the sequence. The per-frame writer below
exists for the case a future selection *does* move (a tracked mark, a
sub-clip), and because ProPainter's own frame-count check is easier to satisfy
with a sequence when a caller wants to be explicit.

The mask is written slightly larger than the selection. A watermark almost
always has a soft edge — anti-aliased type, a drop shadow, a semi-transparent
plate — and pixels of it survive a box drawn exactly on the visible boundary.
Those survivors are then the strongest signal in the border ProPainter
reconstructs from, and it faithfully paints the ghost back in.
"""
from __future__ import annotations

import os

import cv2
import numpy as np

from image_core import clamp_roi

# How far outside the selection the mask reaches, as a fraction of the shorter
# side, and at least this many pixels. Small: it is there to swallow a soft
# edge, and every pixel of it is background the engine has to invent rather
# than keep.
MASK_GROW_RATIO = 0.02
MASK_GROW_MIN = 2


def grow_pixels(w: int, h: int) -> int:
    """How many pixels the mask reaches beyond the selection on each side."""
    return int(max(MASK_GROW_MIN, MASK_GROW_RATIO * min(w, h)))


def mask_rect(
    width: int, height: int, x: int, y: int, w: int, h: int, grow: int | None = None,
) -> tuple[int, int, int, int]:
    """
    The rectangle actually painted white, as (x, y, w, h): the selection grown
    by `grow` pixels and clipped to the frame.
    """
    x, y, w, h = clamp_roi(width, height, x, y, w, h)
    pad = grow_pixels(w, h) if grow is None else grow
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(width, x + w + pad)
    y1 = min(height, y + h + pad)
    return x0, y0, x1 - x0, y1 - y0


def build_mask(
    width: int, height: int, x: int, y: int, w: int, h: int, grow: int | None = None,
) -> np.ndarray:
    """A single-channel uint8 mask: 255 over the grown selection, 0 elsewhere."""
    mx, my, mw, mh = mask_rect(width, height, x, y, w, h, grow)
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[my:my + mh, mx:mx + mw] = 255
    return mask


def write_static_mask(
    path: str, width: int, height: int, roi: dict, grow: int | None = None,
) -> str:
    """
    Write the one mask that describes the whole job, and return its path.

    A single file rather than a copy per frame: identical bytes repeated three
    thousand times is three thousand writes and an extra pass over the disk
    for a program that reads them all into the same array anyway.
    """
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    mask = build_mask(width, height, roi['x'], roi['y'], roi['w'], roi['h'], grow)
    if not cv2.imwrite(path, mask):
        raise IOError(f'Could not write mask: {path}')
    return path


def write_mask_sequence(
    directory: str, count: int, width: int, height: int, roi: dict,
    grow: int | None = None,
) -> list[str]:
    """
    Write one mask per frame, named so they sort into frame order, and return
    the paths. Same rectangle on every frame; see the module docstring for why
    this is the exception rather than the rule.
    """
    if count < 0:
        raise ValueError(f'frame count cannot be negative: {count}')
    os.makedirs(directory, exist_ok=True)
    mask = build_mask(width, height, roi['x'], roi['y'], roi['w'], roi['h'], grow)

    paths = []
    for index in range(count):
        path = os.path.join(directory, f'mask_{index:06d}.png')
        if not cv2.imwrite(path, mask):
            raise IOError(f'Could not write mask: {path}')
        paths.append(path)
    return paths
