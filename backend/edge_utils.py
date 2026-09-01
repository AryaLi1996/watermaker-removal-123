"""
Edge-aware helpers for temporal fill.

Temporal fill recovers the background behind a mark by sampling it out of the
frames around this one, through a motion model fitted to the clean ring of
pixels surrounding the selection. That model is affine and global: it is right
about where the picture as a whole went and, at the scale of a single pixel,
slightly wrong everywhere. On a flat wall a sub-pixel error costs nothing. On
a hard edge — the boundary of a caption, a black-on-white letter, the rim of a
logo — it costs everything: sample a black pixel where a white one belonged and
combine several such samples, and the edge comes back a soft grey ramp. That is
the blur users describe as "you can see where the watermark was".

Every function here exists to keep those edges sharp, and each is a different
answer to the same problem:

  * `edge_strength` says where the edges are, so the rest can treat them
    differently from the flat regions that make up most of a frame.
  * `select_nearest` turns a fused pixel back into a *sampled* pixel: the
    candidate closest to the robust estimate rather than an average of several,
    so the output keeps the frequency content the source had.
  * `sharpen_alpha` narrows the feather where an edge crosses the seam, so the
    band does not smear a boundary that the reconstruction got right.

Two more operations were written, measured and removed, because a module of
plausible-looking image tools nobody can tell apart is how this gets slow for
nothing. A 5x5 median over the flow field, to drop the wild vectors an
estimator produces at a brightness discontinuity, changed the reconstruction
by less than a hundredth of a pixel value and cost 11.6ms a frame — the robust
re-fit in `temporal_core.fit_affine_flow` was already rejecting those vectors,
more cheaply and at the only point where they matter. A guided filter, to put
a sharp fusion's structure onto a smooth one, made things actively worse
(0.95 to 2.68 mean error): with `select_nearest` in front of it the two images
are nearly identical, and a guided filter whose guide is its own source is
just a smoother.

Nothing here knows about optical flow or about frames: these are image
operations, and `temporal_core` is where they are composed into a policy.
"""
from __future__ import annotations

import cv2
import numpy as np

#: The Sobel magnitude that counts as a full-strength edge, as a percentile of
#: the crop being measured. A fixed threshold cannot work across both a
#: high-contrast caption and a hazy landscape; a percentile adapts to the
#: picture, which is what makes one setting behave on both.
EDGE_PERCENTILE = 98.0

#: The smallest magnitude that percentile is allowed to be. Without it, a crop
#: with no edges at all — a clear sky — divides its own sensor noise by itself
#: and reports edges everywhere. Calibrated against flat frames carrying
#: gaussian noise: at this floor sigma-2 noise reads as 0.13 and sigma-3 as
#: 0.19, where a real boundary reads near 1. It binds only on a crop whose
#: strongest gradients are below it, which is to say one with no edges in it.
EDGE_FLOOR = 32.0

#: The percentile is read from every nth pixel in each direction. Sorting the
#: whole crop is the expensive half of this function and the answer moves in
#: the third decimal place.
EDGE_SAMPLE_STRIDE = 2


def edge_strength(image: np.ndarray, smooth: int = 3) -> np.ndarray:
    """
    Where `image` has edges, as a float32 map from 0 (flat) to 1 (strong).

    Sobel rather than Canny: the callers all want *how much* of an edge a pixel
    sits on, to weight something by, and Canny answers a yes/no question. Its
    thin one-pixel contours would also miss the pixels either side of a
    boundary, which are exactly the ones a slightly wrong motion model lands in
    the wrong place.

    The small blur first is what stops single-pixel noise reading as structure;
    it costs a little localisation, which none of the callers need.
    """
    gray = (cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image)
    gray = gray.astype(np.float32)
    if smooth >= 3:
        odd = smooth | 1
        gray = cv2.GaussianBlur(gray, (odd, odd), 0)

    magnitude = cv2.magnitude(
        cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3),
    )
    sampled = magnitude[::EDGE_SAMPLE_STRIDE, ::EDGE_SAMPLE_STRIDE]
    scale = float(np.percentile(sampled, EDGE_PERCENTILE)) if sampled.size else 0.0
    return np.clip(magnitude / max(scale, EDGE_FLOOR), 0.0, 1.0)


def select_nearest(
    stack: np.ndarray,
    reference: np.ndarray,
    weights: np.ndarray | None = None,
) -> np.ndarray:
    """
    Per pixel, the candidate closest to `reference`, rather than a blend.

    This is the whole answer to "the repaired region is smoother than what
    surrounds it". A median over an even number of candidates averages the
    middle two; a mean averages all of them; either way the output pixel is a
    value that appeared in no source frame, and a region built from such values
    has less high-frequency content than the picture around it. Choosing the
    nearest actual sample keeps the robustness — the reference is still the
    median, so an outlier is still never chosen — and returns a pixel that was
    really photographed.

    All three channels come from one candidate, so a colour boundary stays a
    colour boundary instead of picking up a fringe from mixed sources.

    :param stack: (N, H, W, C) float32 candidates, NaN where a candidate has
        nothing valid for that pixel.
    :param reference: (H, W, C) robust estimate to measure closeness against.
    :param weights: Optional (N, H, W) confidences, larger being better. A
        low-confidence candidate has to agree far more closely to be chosen.
    :returns: (H, W, C), NaN wherever every candidate was NaN.
    """
    with np.errstate(invalid='ignore'):
        cost = np.abs(stack - reference[None]).mean(axis=-1)
    if weights is not None:
        cost = cost / np.maximum(weights, 1e-6)

    # An invalid candidate must never win; a pixel no candidate covered comes
    # back NaN, which is how the caller knows to fall back for it.
    cost = np.where(np.isfinite(cost), cost, np.inf)
    chosen = np.argmin(cost, axis=0)
    return np.take_along_axis(stack, chosen[None, :, :, None], axis=0)[0]


def sharpen_alpha(
    alpha: np.ndarray,
    edge: np.ndarray,
    strength: float,
) -> np.ndarray:
    """
    Narrow the feather ramp wherever an edge runs through it.

    The feather exists so the boundary of the repaired rectangle does not read
    as a rectangle, and across flat background a wide soft ramp is exactly
    right. Across a hard edge it is the opposite: the band mixes reconstructed
    and original pixels either side of a boundary that both of them agree
    about, and turns a crisp line into a gradient several pixels wide — a
    visible smudge precisely where the eye is looking.

    So the ramp is steepened in proportion to the edge under it, about its own
    midpoint: the seam still lands in the same place and still crosses from 0
    to 1, but over fewer pixels. `strength` 0 leaves the ramp alone.
    """
    if strength <= 0:
        return alpha
    gain = 1.0 + strength * edge
    return np.clip((alpha - 0.5) * gain + 0.5, 0.0, 1.0).astype(np.float32)
