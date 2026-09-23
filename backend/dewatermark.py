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
# accept.
#
# Two measurements set it, and they are not the same question. Against frames
# whose true values are known, a filled pixel costs about 12 levels and a
# divided one above 0.75 opacity about 24, which moved this down from 0.88 and
# roughly halved the error. But that test composites the mark from this
# module's own solved model, so it cannot see a mismatch between that model and
# however the platform really rendered the mark — and such a mismatch is the
# same on every frame, which makes it a *standing* pattern, the thing an eye
# picks out of moving footage immediately.
#
# Measured that second way — the strength of whatever holds still across the
# real clip — the filled pixels turn out to be the clean ones (98.6% of the
# mark gone, worst pixel 8 levels) and the divided ones carry three quarters of
# what is left (worst pixel 23). So the dial wants to be lower than the first
# test alone would put it. At 0.40 the worst standing pixel halves, 23 -> 11,
# and the 99th percentile falls 13.2 -> 6.0, for 0.23 levels on the first
# measurement. Below 0.40 neither improves and the first one starts to suffer.
ALPHA_CEILING = 0.40

# Width of the ramp below the ceiling over which divided and filled pixels are
# mixed, so the handover leaves no edge of its own. Never wider than the
# ceiling: a band that reaches past zero opacity turns the fill loose on the
# whole selection, which is the rectangle-shaped smear this module exists to
# avoid, and measured 40 levels against 6.
ALPHA_RAMP = 0.30

# Fraction of frames in which a pixel has to clip at white before it is called
# unrecoverable. One clipped frame says nothing; a fifth of them says the mark
# is bright enough there to have taken the background with it.
SATURATION_LIMIT = 0.15
SATURATION_LEVEL = 254

# Radius handed to the filler for what is left. Wide enough to span the strokes
# and reach real background; wider than that measurably hurts, since Telea
# averages over everything inside the radius.
FILL_RADIUS = 3

# Opacity below which a pixel's own colour cannot be told apart from its
# background's, so the global colour is kept instead of dividing by nearly
# nothing.
COLOUR_FLOOR = 0.08

# How many flat colours a mark is assumed to be drawn in. Few, because the
# point of a palette is that it cannot absorb the background the way a free
# per-pixel colour can.
PALETTE_SIZE = 3

# Which pixels get a vote on what those colours are: the worst-explained of the
# marked ones, above this percentile.
PALETTE_PERCENTILE = 75

# How many times the palette and the opacity are re-solved against each other.
PALETTE_ROUNDS = 4
PALETTE_MIN_PIXELS = 40

# The mask the background estimate is taken from is grown by this much while
# solving, to keep a mark's anti-aliased rim from leaking into its own
# reference. It is *not* grown when restoring: measured against the residue
# score, dilating there only destroys pixels the solve had recovered correctly.
SOLVE_GROW = 1

# The seed the palette's k-means starts from.
#
# OpenCV's k-means++ draws its initial centres from OpenCV's global RNG, which
# nothing seeds, so the same frames solved twice do not give the same answer.
# Measured on one region of the reported clip over four runs: coverage 0.123 to
# 0.139 and residual 14.75 to 16.11 — and 16.0 is where `survey` stops calling
# something a watermark. A user who scanned the same video twice could be shown
# a different list, which is not a rounding error but a different answer to the
# question they asked.
#
# Seeding at the top of every solve rather than once at import also makes the
# answer independent of how many solves ran before it, so a region's result
# does not depend on its position in the survey.
SOLVE_SEED = 20260923


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


def persistence(frames: np.ndarray) -> np.ndarray:
    """
    How much of the detail at each pixel is in the same place in every frame.

    A high-pass isolates detail; the median of that across frames keeps what
    recurs and discards what moved. Returned as the signed float map rather
    than a mask, because what counts as "enough" depends on the caller: the
    solve knows where the mark is and wants a fixed, generous floor, while a
    scan that is still looking for it has to judge the map against itself.
    """
    highpass = []
    for frame in frames[::4]:
        grey = cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_BGR2GRAY)
        highpass.append(grey.astype(np.float32) - cv2.medianBlur(grey, 21).astype(np.float32))
    return np.median(np.stack(highpass), axis=0)


def persistent_strokes(frames: np.ndarray, threshold: float = 1.5) -> np.ndarray:
    """
    A first guess at where the mark is, from the one thing that sets it apart:
    it is the only detail that is in the same place in every frame.

    Returns a uint8 mask.
    """
    return _grow((np.abs(persistence(frames)) > threshold).astype(np.uint8), iterations=2)


def _background_estimate(frames: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Each frame with the masked pixels replaced from outside the mask."""
    return np.stack([
        cv2.inpaint(frame.astype(np.uint8), mask, FILL_RADIUS, cv2.INPAINT_TELEA).astype(np.float32)
        for frame in frames
    ])


def _alpha_against(frames: np.ndarray, background: np.ndarray, colour) -> np.ndarray:
    """Least-squares opacity at every pixel, for one assumed mark colour."""
    delta = np.asarray(colour, np.float32) - background
    return np.clip(
        ((frames - background) * delta).sum(axis=(0, 3))
        / (np.square(delta).sum(axis=(0, 3)) + 1e-6),
        0.0, 0.995,
    )


def _misfit(frames: np.ndarray, background: np.ndarray,
            alpha: np.ndarray, colour) -> np.ndarray:
    """How badly one (alpha, colour) pair explains each pixel, in levels."""
    a3 = alpha[..., None]
    modelled = (1 - a3)[None] * background + a3[None] * np.asarray(colour, np.float32)
    return np.abs(frames - modelled).mean(axis=(0, 3))


def _palette(frames: np.ndarray, background: np.ndarray,
             alpha: np.ndarray, global_colour: np.ndarray) -> np.ndarray:
    """
    The few flat colours the mark is drawn in.

    Taken by clustering what the *badly explained* pixels imply their colour to
    be — not the most opaque ones. Opacity is the wrong selector here and the
    reason an earlier attempt at this found nothing: a tinted pixel's opacity
    is precisely what the white-only fit got wrong, so selecting on it excludes
    the pixels the palette exists to describe. Misfit selects them by the thing
    that is actually true of them, which is that white does not account for
    them.
    """
    marked = alpha > ALPHA_FLOOR
    if marked.sum() < PALETTE_MIN_PIXELS:
        return global_colour[None]

    error = _misfit(frames, background, alpha, global_colour)
    cut = np.percentile(error[marked], PALETTE_PERCENTILE)
    solid = marked & (error >= cut)
    if solid.sum() < PALETTE_MIN_PIXELS:
        return global_colour[None]

    a3 = alpha[..., None]
    implied = np.median(
        (frames - (1 - a3)[None] * background) / np.maximum(a3, COLOUR_FLOOR)[None], axis=0,
    )
    samples = np.clip(implied[solid], 0.0, 255.0).astype(np.float32)

    clusters = min(PALETTE_SIZE, len(samples))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, _, centres = cv2.kmeans(
        samples, clusters, None, criteria, 3, cv2.KMEANS_PP_CENTERS,
    )
    return np.vstack([global_colour[None], centres.astype(np.float32)])


def _alpha_against_palette(frames: np.ndarray, background: np.ndarray,
                           palette: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Solve the opacity against every palette entry; keep the best per pixel."""
    best_alpha = None
    best_misfit = None
    best_index = None
    for index, colour in enumerate(palette):
        candidate = _alpha_against(frames, background, colour)
        error = _misfit(frames, background, candidate, colour)
        if best_alpha is None:
            best_alpha, best_misfit = candidate, error
            best_index = np.zeros_like(error, np.int32)
            continue
        better = error < best_misfit
        best_alpha = np.where(better, candidate, best_alpha)
        best_misfit = np.where(better, error, best_misfit)
        best_index = np.where(better, index, best_index)
    return best_alpha, palette[best_index]


def solve(frames: np.ndarray, iterations: int = 6) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """
    Solve the blend for a stack of identically-cropped frames.

    `frames` is (n, h, w, 3) float32 BGR, all showing the mark in the same
    place. Returns (alpha, colour, unrecoverable, residual).
    """
    if frames.ndim != 4 or frames.shape[0] < 2:
        raise ValueError('solving a blend needs a stack of at least two frames')
    # See SOLVE_SEED: without this the same frames give a different answer each
    # time, and near a threshold that is a different classification.
    cv2.setRNGSeed(SOLVE_SEED)
    _, height, width, _ = frames.shape

    mask = persistent_strokes(frames)
    global_colour = np.array([255.0, 255.0, 255.0], np.float32)
    alpha = np.zeros((height, width), np.float32)

    # Alpha, against one global colour, to get a first reading of the mark.
    for _ in range(iterations):
        background = _background_estimate(frames, mask)
        alpha = _alpha_against(frames, background, global_colour)
        a4 = alpha[None, ..., None]
        global_colour = np.clip(
            (a4 * (frames - (1 - a4) * background)).sum(axis=(0, 1, 2))
            / (np.square(a4).sum(axis=(0, 1, 2)) + 1e-6),
            0.0, 255.0,
        )
        mask = _grow((alpha > ALPHA_FLOOR).astype(np.uint8), SOLVE_GROW)

    background = _background_estimate(frames, mask)

    # One colour is not enough. Most of these marks carry a tinted logo glyph,
    # and a white-only model does not report it as coloured — it reports it as
    # *more transparent*, because a lower opacity is the only way white can be
    # made to look like a tint. That is the worst of the possible errors: the
    # glyph then sits below the ceiling, so it is neither divided out correctly
    # nor handed over to be filled, and what is left is the half-subtracted
    # ghost this module exists to avoid.
    #
    # The fix is not to let every pixel pick its own colour while alpha is
    # being solved — with that much freedom the colour fits the background's
    # structure as readily as the mark's, which on the sample video took the
    # residue from 0.058 to 0.129 and tipped the result into over-subtraction.
    # A mark is rendered artwork: it is made of a handful of flat colours. So
    # alpha is solved against a handful, and each pixel takes whichever of them
    # explains it best.
    # Palette and opacity are chicken-and-egg: the colours are clustered from
    # what each pixel implies, which is divided by the very opacity the
    # white-only fit got wrong. One pass is a large step in the right direction
    # and not the whole way, so this alternates. The palette stays small
    # throughout, which is what keeps the alternation from wandering the way a
    # free per-pixel colour does.
    colour = np.broadcast_to(global_colour, (height, width, 3)).copy()
    for _ in range(PALETTE_ROUNDS):
        palette = _palette(frames, background, alpha, global_colour)
        alpha, colour = _alpha_against_palette(frames, background, palette)
        mask = _grow((alpha > ALPHA_FLOOR).astype(np.uint8), SOLVE_GROW)
        background = _background_estimate(frames, mask)

    # Finally a colour free to vary per pixel, taken once and never fed back
    # into alpha. What the restore subtracts is the product ``a * W``, so
    # letting ``W`` carry the anti-aliased rims that no flat colour describes
    # makes that product more accurate without giving the fit room to wander.
    a3 = alpha[..., None]
    per_pixel = np.median(
        (frames - (1 - a3)[None] * background) / np.maximum(a3, COLOUR_FLOOR)[None], axis=0,
    )
    colour = np.where(
        (alpha > COLOUR_FLOOR)[..., None], np.clip(per_pixel, 0.0, 255.0), colour,
    ).astype(np.float32)

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


def reachable_mask(model: WatermarkModel) -> np.ndarray:
    """
    The pixels a filler has to repaint: the ones beyond recovery, plus the
    ramp band that blends towards them.

    A property of the model rather than of any one frame, which is what lets a
    filler be asked about a whole placement once instead of per frame.

    The ramp band is in here, not just the pixels that need it outright,
    because a fill masked to the unrecoverable set alone gives the ramp nothing
    to blend towards: the weighted sum in `compose` then reduces to the divided
    result at every pixel and the ramp does nothing at all, which is what it
    did until this was noticed.
    """
    return np.maximum(
        model.unrecoverable,
        (model.alpha >= _ramp_floor()).astype(np.uint8),
    )


def _ramp_floor() -> float:
    return max(ALPHA_CEILING - ALPHA_RAMP, ALPHA_FLOOR)


def unblend(frame: np.ndarray, model: WatermarkModel) -> np.ndarray:
    """
    The mark's region with the blend divided out, as float32.

    Everything the arithmetic can recover, and nothing invented. Where the
    opacity approaches one this is noise — `reachable_mask` says where — and
    somebody else has to paint those pixels.
    """
    x, y, w, h = model.roi
    patch = frame[y:y + h, x:x + w].astype(np.float32)
    keep = np.clip(1.0 - model.alpha, 1.0 - ALPHA_CEILING, 1.0)[..., None]
    return np.clip((patch - model.alpha[..., None] * model.colour) / keep, 0, 255)


def local_fill(recovered: np.ndarray, model: WatermarkModel) -> np.ndarray:
    """Telea over the reachable pixels: the filler that needs nothing."""
    return cv2.inpaint(
        recovered.astype(np.uint8), reachable_mask(model), FILL_RADIUS,
        cv2.INPAINT_TELEA,
    ).astype(np.float32)


def compose(frame: np.ndarray, model: WatermarkModel, recovered: np.ndarray,
            filled: np.ndarray) -> np.ndarray:
    """
    One frame with the mark's region replaced: what was recovered, ramping to
    what was filled where the recovery cannot be trusted.

    `filled` only has to be right inside `reachable_mask`. Outside it the ramp
    is zero and this never reads it, which is what lets a filler that works on
    a crop hand back a crop.
    """
    ramp_floor = _ramp_floor()
    ramp = np.maximum(
        np.clip((model.alpha - ramp_floor) / max(ALPHA_CEILING - ramp_floor, 1e-6), 0.0, 1.0),
        model.unrecoverable.astype(np.float32),
    )[..., None]

    x, y, w, h = model.roi
    result = frame.copy()
    result[y:y + h, x:x + w] = np.clip(
        recovered * (1 - ramp) + filled * ramp, 0, 255).astype(np.uint8)
    return result


def restore(frame: np.ndarray, model: WatermarkModel) -> np.ndarray:
    """
    Undo the blend on one frame with the filler that needs nothing but this
    machine. `frame` is a full uint8 BGR frame; the result is a copy with the
    mark's region replaced.
    """
    recovered = unblend(frame, model)
    return compose(frame, model, recovered, local_fill(recovered, model))
