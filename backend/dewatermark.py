"""
Recovering the picture underneath a semi-transparent watermark.

Every other engine here treats the mark as an opaque hole: the pixels under it
are gone, so something plausible has to be invented to fill the gap. That is
true of a station logo painted solidly over the picture. It is *not* true of
what the short-video platforms burn in. A Douyin, Kuaishou or Xiaohongshu mark
is alpha-composited:

    I = (1 - a) * B + a * W

where ``I`` is what we are given, ``B`` the picture that was really filmed,
``a`` the mark's per-pixel opacity and ``W`` its colour. The background never
left — it is still in every frame, scaled by ``1 - a`` and shifted by ``a * W``.
Invert the blend and the real pixels come back, exactly, with no invention and
therefore nothing to look wrong.

The catch is that ``a`` and ``W`` are not given to us. They are recoverable
because the mark holds still for hundreds of frames while the picture behind it
does not: that is a great many equations for the four unknowns at each pixel,
and the scene's own variety is what conditions them.

``a`` and ``W`` are solved together, by alternating least squares: fix one and
the other is a linear problem, so the solve goes back and forth until both
settle. The first pass has to start somewhere, and it starts from a single
global colour — these marks are rendered type and mostly white, so one colour
explains most of the picture and keeps that first estimate well conditioned.

Letting ``W`` vary per pixel afterwards is not a refinement but a necessity.
Most of these marks carry a tinted logo glyph, and a white-only model cannot
account for one: it explains the tint away by *lowering* ``a`` instead. On the
test scene here that put the glyph's opacity at 0.13 when the truth was 0.63 —
an error that no later stage can repair, because every stage after it takes
``a`` as given. Alternating fixes it at the source.

Both sides regress against a background estimated by inpainting the current
mask — pixels from *outside* the mark rather than a blur of it, which is the
difference between measuring the mark and measuring itself. That estimate is
deliberately kept independent of ``a``: feeding the module's own output back in
makes the mask grow without bound, since a mark already removed reads as more
mark to remove.

A final stage marks what is beyond recovery. Dividing by ``1 - a`` amplifies
every error by the same factor, so glyph cores where ``a`` approaches 1 come
back as noise; and where the composite clipped at white the information was
destroyed outright rather than merely mixed. Both are filled by other means
rather than divided.

What stage 3 hands on is small — on the sample this was developed against,
1.5% of the selection rather than 100% of it — and it is thin strokes with
genuine recovered background on every side, which is the easy case for any
filler. That ratio is the whole point: the visible block users complain about
is what you get when an engine invents a rectangle, and it goes away when there
is almost nothing left to invent.

Nothing here needs a GPU or a learned model; it is a linear solve over frames
the app has already decoded.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# Opacity below which a pixel is considered untouched by the mark. Set by the
# noise floor of the fit rather than by taste: under this the correction is
# smaller than the error on it.
ALPHA_FLOOR = 0.03

# Opacity above which division is abandoned. 1/(1 - a) is the factor every
# error is multiplied by, so this is a choice about how much amplification to
# accept: 0.88 is ~8x, and measured against the objective residue score it beat
# both the more timid and the more aggressive settings.
ALPHA_CEILING = 0.88

# Width of the ramp below the ceiling over which divided and filled pixels are
# mixed, so the handover leaves no edge of its own.
ALPHA_RAMP = 0.20

# Fraction of frames in which a pixel has to clip at white before it is called
# unrecoverable. One clipped frame says nothing; a fifth of them says the mark
# is bright enough there to have taken the background with it.
SATURATION_LIMIT = 0.15
SATURATION_LEVEL = 254

# Radius handed to the filler for what is left. Larger than the strokes it
# spans, so it reaches real background rather than more of the same estimate.
FILL_RADIUS = 6

# Opacity below which a pixel's own colour cannot be told apart from its
# background's, so the global colour is kept instead of dividing by nearly
# nothing.
COLOUR_FLOOR = 0.08

# How much better, in levels, a per-pixel colour has to explain a pixel before
# it is preferred to the mark's global colour. Shrinkage: without it the colour
# fits the background's structure as readily as the mark's.
COLOUR_MARGIN = 3.0

# The mask the background estimate is taken from is grown by this much while
# solving, to keep a mark's anti-aliased rim from leaking into its own
# reference. It is *not* grown when restoring: measured against the residue
# score, dilating there only destroys pixels the solve had recovered correctly.
SOLVE_GROW = 1


@dataclass(frozen=True)
class WatermarkModel:
    """A solved mark: where it sits, how opaque it is, and what colour."""

    roi: tuple[int, int, int, int]
    alpha: np.ndarray           # (h, w) float32 in [0, 1]
    colour: np.ndarray          # (h, w, 3) float32 BGR
    unrecoverable: np.ndarray   # (h, w) uint8, 1 where the blend cannot be undone
    frames_fitted: int
    residual: float             # mean |I - ((1-a)B + aW)| over the mark, in levels

    @property
    def coverage(self) -> float:
        """Fraction of the selection the mark actually touches."""
        return float((self.alpha > ALPHA_FLOOR).mean())

    @property
    def invented(self) -> float:
        """Fraction of the selection that has to be filled rather than recovered."""
        return float(self.unrecoverable.mean())


def _grow(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    if iterations <= 0:
        return mask
    return cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=iterations)


def persistent_strokes(frames: np.ndarray, threshold: float = 1.5) -> np.ndarray:
    """
    A first guess at where the mark is, from the one thing that sets it apart:
    it is the only detail that is in the same place in every frame.

    A high-pass isolates detail; the median of that across frames keeps what
    recurs and discards what moved. Returns a uint8 mask.
    """
    highpass = []
    for frame in frames[::4]:
        grey = cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_BGR2GRAY)
        highpass.append(grey.astype(np.float32) - cv2.medianBlur(grey, 21).astype(np.float32))
    template = np.median(np.stack(highpass), axis=0)
    return _grow((np.abs(template) > threshold).astype(np.uint8), iterations=2)


def _background_estimate(frames: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Each frame with the masked pixels replaced from outside the mask."""
    return np.stack([
        cv2.inpaint(frame.astype(np.uint8), mask, FILL_RADIUS, cv2.INPAINT_TELEA).astype(np.float32)
        for frame in frames
    ])


def solve(frames: np.ndarray, iterations: int = 6) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """
    Solve the blend for a stack of identically-cropped frames.

    `frames` is (n, h, w, 3) float32 BGR, all showing the mark in the same
    place. Returns (alpha, colour, unrecoverable, residual).
    """
    if frames.ndim != 4 or frames.shape[0] < 2:
        raise ValueError('solving a blend needs a stack of at least two frames')
    _, height, width, _ = frames.shape

    mask = persistent_strokes(frames)
    colour = np.full((height, width, 3), 255.0, np.float32)
    alpha = np.zeros((height, width), np.float32)

    for step in range(iterations):
        background = _background_estimate(frames, mask)

        # alpha, with the colour currently believed
        delta = colour[None] - background
        alpha = np.clip(
            ((frames - background) * delta).sum(axis=(0, 3))
            / (np.square(delta).sum(axis=(0, 3)) + 1e-6),
            0.0, 0.995,
        )

        # colour, with the alpha just solved
        a3 = alpha[..., None]
        uncovered = frames - (1 - a3)[None] * background
        a4 = a3[None]
        global_colour = np.clip(
            (a4 * uncovered).sum(axis=(0, 1, 2)) / (np.square(a4).sum(axis=(0, 1, 2)) + 1e-6),
            0.0, 255.0,
        )
        colour = np.broadcast_to(global_colour, (height, width, 3)).copy()

        if step > 0:
            # Most of one of these marks is a single colour, and letting every
            # pixel choose its own lets the colour absorb the background's
            # structure instead of the mark's: on the sample video that cost
            # more than the tinted glyph it was meant to win back. So a pixel
            # only departs from the global colour to the extent that doing so
            # genuinely explains it better.
            per_pixel = np.clip(
                np.median(uncovered / np.maximum(a3, COLOUR_FLOOR)[None], axis=0),
                0.0, 255.0,
            )
            def _misfit(candidate: np.ndarray) -> np.ndarray:
                modelled = (1 - a3)[None] * background + a3[None] * candidate[None]
                return np.abs(frames - modelled).mean(axis=(0, 3))
            gain = np.clip(
                (_misfit(colour) - _misfit(per_pixel) - COLOUR_MARGIN) / COLOUR_MARGIN,
                0.0, 1.0,
            )[..., None]
            colour = colour + (per_pixel - colour) * gain

        mask = _grow((alpha > ALPHA_FLOOR).astype(np.uint8), SOLVE_GROW)

    background = _background_estimate(frames, mask)
    a3 = alpha[..., None]

    # What cannot be divided back out.
    saturating = (frames >= SATURATION_LEVEL).all(axis=3).mean(axis=0)
    unrecoverable = ((alpha >= ALPHA_CEILING) | (saturating > SATURATION_LIMIT)).astype(np.uint8)

    modelled = (1 - a3)[None] * background + a3[None] * colour[None]
    inside = alpha > ALPHA_FLOOR
    residual = float(np.abs(frames - modelled).mean(axis=(0, 3))[inside].mean()) if inside.any() else 0.0

    return alpha, colour, unrecoverable, residual


def fit(frames: np.ndarray, roi: tuple[int, int, int, int], iterations: int = 6) -> WatermarkModel:
    """Solve the mark inside `roi` from full frames."""
    x, y, w, h = roi
    crops = np.ascontiguousarray(frames[:, y:y + h, x:x + w]).astype(np.float32)
    alpha, colour, unrecoverable, residual = solve(crops, iterations)
    return WatermarkModel(
        roi=roi,
        alpha=alpha,
        colour=colour,
        unrecoverable=unrecoverable,
        frames_fitted=int(frames.shape[0]),
        residual=residual,
    )


def restore(frame: np.ndarray, model: WatermarkModel) -> np.ndarray:
    """
    Undo the blend on one frame. `frame` is a full uint8 BGR frame; the result
    is a copy with the mark's region replaced.
    """
    x, y, w, h = model.roi
    patch = frame[y:y + h, x:x + w].astype(np.float32)

    keep = np.clip(1.0 - model.alpha, 1.0 - ALPHA_CEILING, 1.0)[..., None]
    recovered = np.clip((patch - model.alpha[..., None] * model.colour) / keep, 0, 255)

    filled = cv2.inpaint(
        recovered.astype(np.uint8), model.unrecoverable, FILL_RADIUS, cv2.INPAINT_TELEA,
    ).astype(np.float32)

    ramp = np.maximum(
        np.clip((model.alpha - (ALPHA_CEILING - ALPHA_RAMP)) / ALPHA_RAMP, 0.0, 1.0),
        model.unrecoverable.astype(np.float32),
    )[..., None]

    result = frame.copy()
    result[y:y + h, x:x + w] = np.clip(recovered * (1 - ramp) + filled * ramp, 0, 255).astype(np.uint8)
    return result
