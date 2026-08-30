"""
Temporal (flow-guided) inpainting.

Every other engine in `image_core` sees one frame at a time, so the only
pixels it can reason about are the ones surrounding the mark *now*. On a
moving background that is not enough: the reconstruction is invented rather
than recovered, and it neither matches the motion nor holds still between
frames — the blur and the crawling edges users report.

The background hidden behind a watermark is, however, almost always visible
in another frame: the camera or the subject moved, the mark did not. This
module recovers it.

For each frame:

  1. The frames either side are walked outwards a frame at a time. Dense
     optical flow is computed between each pair of *adjacent* frames, over a
     crop around the selection rather than the whole picture, and the models
     are composed as the walk goes. Asking the flow for the displacement to a
     frame forty frames away directly does not work — it is far outside what
     any of these estimators can track — but forty small steps compose into
     it exactly.
  2. The flow *inside* the selection is worthless — the static mark reads as
     "nothing moved here" — so it is discarded and replaced by an affine
     model fitted to the flow in the ring of clean pixels around it. That
     covers pans, zooms and rotations, which is what real footage does over
     the span this looks at.
  3. The model is checked before it is trusted: the neighbour is warped by it
     and compared with the frame over that same ring of clean pixels. A
     neighbour too far away for the flow to track, or on the far side of a
     cut, fails here and is dropped — an unchecked one lands plausible-looking
     pixels from the wrong place, which is worse than the blur being fixed.
  4. Each surviving neighbour is sampled through its model, keeping only
     pixels that came from outside the neighbour's own (identically placed)
     mark and from inside the frame.
  5. The walk stops as soon as every pixel has enough samples, so a fast pan
     costs a couple of frames and only a hard shot walks the full distance.
  6. The candidates are fused per pixel — median for the slower settings, a
     weighted mean for the fast one.
  7. Anything left uncovered falls back to single-frame `process_inpaint`,
     and the whole patch is feathered into a band just outside the selection
     so the seam lands on reconstructed background instead of on the edge of
     the mark.

This is the optical-flow tier of the feature. A learned video-inpainting
engine (ProPainter and friends) would do better on the hardest shots — a
locked-off camera over a still background, where no frame ever shows what is
behind the mark — at the cost of a multi-gigabyte model download. The seam
for it is `process_temporal`, which such an engine would replace rather than
complicate.
"""
from __future__ import annotations

import sys
import warnings
from collections.abc import Callable
from dataclasses import dataclass

import cv2
import numpy as np

# Imported for the fallback fill. image_core does *not* import this module at
# import time (see the `temporal` branch of apply_removal), so there is no cycle.
from image_core import process_inpaint


@dataclass(frozen=True)
class TemporalSettings:
    """One point on the speed/quality dial."""

    name: str
    #: How many frames the walk may travel in each direction. A mark is only
    #: uncovered once the picture has moved further than the mark is wide,
    #: which at a gentle pan takes tens of frames.
    max_links: int
    #: Samples wanted per pixel before a pixel counts as done. More than one
    #: is what lets the median throw away a bad sample.
    min_samples: int
    #: Flow is computed at this fraction of full resolution.
    flow_scale: float
    #: cv2 attribute name of the DIS preset to use when DIS is available.
    dis_preset: str
    #: Farneback parameters, used where the build has no DIS implementation.
    farneback_levels: int
    farneback_winsize: int
    farneback_iterations: int
    #: How candidates are combined: 'median' rejects outliers, 'mean' is cheaper.
    fuse: str
    #: Width in pixels of the soft edge around the reconstructed rectangle.
    feather: int

    @property
    def reach(self) -> int:
        """How many frames either side this setting can ask for."""
        return self.max_links


# The three settings the UI offers. The reach costs nothing on footage that
# moves quickly, because the walk stops as soon as the selection is covered:
# what the setting really buys is patience with footage that does not.
QUALITY_PRESETS: dict[str, TemporalSettings] = {
    'fast': TemporalSettings(
        name='fast',
        max_links=6,
        min_samples=1,
        flow_scale=0.75, dis_preset='DISOPTICAL_FLOW_PRESET_ULTRAFAST',
        farneback_levels=2, farneback_winsize=15, farneback_iterations=2,
        fuse='mean', feather=4,
    ),
    'balanced': TemporalSettings(
        name='balanced',
        max_links=8,
        min_samples=2,
        flow_scale=0.75, dis_preset='DISOPTICAL_FLOW_PRESET_FAST',
        farneback_levels=3, farneback_winsize=21, farneback_iterations=3,
        fuse='median', feather=6,
    ),
    'high': TemporalSettings(
        name='high',
        max_links=16,
        min_samples=3,
        flow_scale=1.0, dis_preset='DISOPTICAL_FLOW_PRESET_MEDIUM',
        farneback_levels=4, farneback_winsize=25, farneback_iterations=5,
        fuse='median', feather=8,
    ),
}

DEFAULT_QUALITY = 'balanced'

# Watermarks are anti-aliased against the picture, so the pixels immediately
# around the selection are part-mark. They are excluded from both the flow fit
# and the candidate pixels.
WATERMARK_SAFETY = 2

# How much clean picture around the selection the flow gets to see. It has to
# be wider than the mark, or a displacement large enough to uncover the mark
# is a displacement the flow cannot measure — but every pixel of it is paid
# for on every neighbour of every frame.
FLOW_MARGIN_MIN = 32
FLOW_MARGIN_RATIO = 1.5

# Neighbours that add no newly covered pixel after this many tries in a row
# end the walk. A locked-off camera over a still background never uncovers
# anything, and would otherwise pay the full reach to learn it.
NO_GAIN_PATIENCE = 3

# The affine fit reads at most this many ring pixels — beyond it the estimate
# stops improving and only the least-squares solve gets slower.
MAX_FIT_POINTS = 20000
# Below this many the fit is not worth trusting; a median translation is.
MIN_FIT_POINTS = 64

# How far the ring may disagree after warping before the motion estimate is
# thrown away, as a fraction of the ring's own contrast. Normalising by
# contrast is what makes one threshold work for both a busy street and a
# gradient sky. Measured on synthetic pans, a correct estimate scores under
# 0.2 and a wrong one over 1.3, so the line between them is not delicate.
FLOW_RESIDUAL_LIMIT = 0.5
# Too small a ring to check is a check worth nothing.
MIN_VERIFY_POINTS = 500

# A sample is kept only if it came entirely from clean, in-frame pixels.
# Bilinear sampling means a value just under 1 has a masked pixel in its
# footprint.
VALID_THRESHOLD = 0.999

#: What `process_temporal` is handed to fetch a neighbour: given a signed
#: frame offset it returns that frame, or None where there is no such frame.
#: It is called lazily and only as far along the ladder as the walk gets.
NeighborSource = Callable[[int], 'np.ndarray | None']

#: How `process_temporal` reports that a frame could not be rebuilt from its
#: neighbours and was filled from itself instead. Called at most once per
#: frame, with a short reason, and only when a *failure* caused it: a shot
#: that simply never uncovers the mark is the engine working as designed and
#: says nothing.
DegradeReport = Callable[[str], None]

#: The message an out-of-memory failure carries out of here. The renderer
#: matches "out of memory" and shows its own translated sentence, so the
#: wording that survives into a bug report is the useful half: which dial the
#: user can turn.
OUT_OF_MEMORY_MESSAGE = (
    'Out of memory during temporal reconstruction. Try a lower temporal '
    'quality, a smaller selection, or a shorter clip.'
)


def warn_degraded(message: str) -> None:
    """
    Report a degraded reconstruction without failing the job.

    This runs inside a pool worker, whose stdout is the job protocol Electron
    parses line by line — a stray line there would be read as a stage or a
    progress report. stderr is logged instead, which is where the diagnostic
    belongs: the frame still comes out, just filled the single-frame way.
    """
    print(f'WARNING: {message}', file=sys.stderr, flush=True)


def report_degraded(on_degraded: 'DegradeReport | None', reason: str) -> None:
    """
    Log that this frame fell back, and tell the caller so it can be counted.

    The log line is for whoever is debugging one frame; the callback is for
    the user, who wants one number at the end rather than three thousand
    lines they will never see.
    """
    warn_degraded(f'{reason} for this frame')
    if on_degraded is not None:
        on_degraded(reason)


def quality_settings(name: str) -> TemporalSettings:
    """The settings for a quality name, as the job config spells it."""
    try:
        return QUALITY_PRESETS[name]
    except KeyError:
        raise ValueError(
            f"Unknown temporal quality {name!r}; expected one of "
            f"{', '.join(sorted(QUALITY_PRESETS))}."
        ) from None


def flow_estimator(settings: TemporalSettings):
    """
    A callable `(prev_gray, next_gray) -> flow`, using the best method the
    installed OpenCV has.

    The returned field follows OpenCV's convention: `prev(p)` corresponds to
    `next(p + flow(p))`, which is exactly what `cv2.remap` wants.

    DIS is both faster and more accurate than Farneback at every preset, but
    it lives in a module a cut-down OpenCV build may not carry, so Farneback
    stays as the fallback rather than as a second-class option.
    """
    create = getattr(cv2, 'DISOpticalFlow_create', None)
    preset = getattr(cv2, settings.dis_preset, None)
    if create is not None and preset is not None:
        dis = create(preset)
        # DIS asserts on a non-contiguous input rather than copying it.
        return lambda prev, nxt: dis.calc(
            np.ascontiguousarray(prev), np.ascontiguousarray(nxt), None)

    return lambda prev, nxt: cv2.calcOpticalFlowFarneback(
        np.ascontiguousarray(prev), np.ascontiguousarray(nxt), None,
        0.5, settings.farneback_levels, settings.farneback_winsize,
        settings.farneback_iterations, 5, 1.2, 0,
    )


def flow_margin(w: int, h: int) -> int:
    """How far outside the selection the flow crop reaches."""
    return int(max(FLOW_MARGIN_MIN, FLOW_MARGIN_RATIO * max(w, h)))


def fit_affine_flow(flow: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """
    Fit `flow` over the pixels `ring` marks, as an affine function of position.

    Returns a 2x3 matrix A with [u, v] = A @ [x, y, 1] — translation, zoom,
    rotation and shear, which is what a camera does over a few frames. A
    per-pixel field would be no better here: it is being *extrapolated* into a
    region where nothing was measured, and the fit is what makes that
    extrapolation behave.

    Falls back to the median translation when there is too little ring to fit
    (a mark against the edge of the frame) or the solve is degenerate.
    """
    ys, xs = np.nonzero(ring)
    count = len(xs)
    if count == 0:
        return np.zeros((2, 3), dtype=np.float64)

    if count > MAX_FIT_POINTS:
        keep = np.linspace(0, count - 1, MAX_FIT_POINTS).astype(np.intp)
        ys, xs = ys[keep], xs[keep]

    u = flow[ys, xs, 0].astype(np.float64)
    v = flow[ys, xs, 1].astype(np.float64)

    def translation() -> np.ndarray:
        return np.array([[0.0, 0.0, float(np.median(u))],
                         [0.0, 0.0, float(np.median(v))]])

    if len(xs) < MIN_FIT_POINTS:
        return translation()

    design = np.stack(
        [xs.astype(np.float64), ys.astype(np.float64), np.ones(len(xs))], axis=1)
    try:
        coeffs, *_ = np.linalg.lstsq(design, np.stack([u, v], axis=1), rcond=None)
    except np.linalg.LinAlgError:
        return translation()

    matrix = coeffs.T  # (2, 3): rows u and v, columns x, y, 1
    if not np.all(np.isfinite(matrix)):
        return translation()
    return matrix


def as_transform(displacement: np.ndarray) -> np.ndarray:
    """
    The 3x3 mapping a displacement model describes: p -> p + A @ [x, y, 1].

    Working in mapping form is what makes composition a matrix product, which
    is how a walk of small, measurable steps becomes one large displacement no
    estimator could have measured directly.
    """
    transform = np.eye(3, dtype=np.float64)
    transform[:2, :] += displacement
    return transform


def as_displacement(transform: np.ndarray) -> np.ndarray:
    """The inverse of `as_transform`: back to the 2x3 the sampler wants."""
    return transform[:2, :] - np.eye(3, dtype=np.float64)[:2, :]


def compose(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    """
    The displacement model of `first` followed by `second`.

    Composing the frame-to-frame steps, rather than re-measuring from the
    frame being reconstructed, is what keeps every measurement small.
    """
    return as_displacement(as_transform(second) @ as_transform(first))


def sample_grid(
    matrix: np.ndarray,
    x0: int, y0: int, x1: int, y1: int,
    origin_x: int, origin_y: int,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Where each pixel of the rectangle [x0,x1) x [y0,y1) is to be read from in
    a neighbouring frame, given a flow model fitted in crop coordinates whose
    origin sits at (origin_x, origin_y). Returns cv2.remap's (map_x, map_y).
    """
    ys, xs = np.mgrid[y0:y1, x0:x1]
    xs = xs.astype(np.float32)
    ys = ys.astype(np.float32)
    local_x = xs - origin_x
    local_y = ys - origin_y
    u = matrix[0, 0] * local_x + matrix[0, 1] * local_y + matrix[0, 2]
    v = matrix[1, 0] * local_x + matrix[1, 1] * local_y + matrix[1, 2]
    return (xs + u).astype(np.float32), (ys + v).astype(np.float32)


def feather_alpha(
    width: int, height: int,
    left: int, right: int, top: int, bottom: int,
) -> np.ndarray:
    """
    Opacity for the reconstructed rectangle: 1 over the selection, ramping to
    0 across whatever band of clean pixels surrounds it.

    Each side ramps independently because the bands are not equal: a mark in
    the corner of the frame has no band on two of its sides, and ramping there
    would leave a strip of the mark showing.
    """
    ax = np.ones(width, dtype=np.float32)
    if left > 0:
        ax[:left] = (np.arange(left, dtype=np.float32) + 0.5) / left
    if right > 0:
        ax[width - right:] = (np.arange(right, 0, -1, dtype=np.float32) - 0.5) / right

    ay = np.ones(height, dtype=np.float32)
    if top > 0:
        ay[:top] = (np.arange(top, dtype=np.float32) + 0.5) / top
    if bottom > 0:
        ay[height - bottom:] = (np.arange(bottom, 0, -1, dtype=np.float32) - 0.5) / bottom

    return np.minimum(ax[None, :], ay[:, None])


def fuse_candidates(
    candidates: list[np.ndarray],
    weights: list[float],
    how: str,
) -> np.ndarray:
    """
    Combine the warped candidates into one patch, NaN where none was valid.

    The median throws away a neighbour whose sample landed on something that
    was not there in this frame — a passer-by, a cut — which a mean would
    smear across the result instead.
    """
    stack = np.stack(candidates, axis=0)
    # A pixel no neighbour could cover comes back as NaN by design; numpy warns
    # about the all-NaN slice, which is not news to the caller.
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', category=RuntimeWarning)
        if how == 'median':
            return np.nanmedian(stack, axis=0)

        w = np.array(weights, dtype=np.float32).reshape(-1, 1, 1, 1)
        valid = ~np.isnan(stack)
        total = np.nansum(np.where(valid, stack, 0.0) * w, axis=0)
        norm = np.sum(valid * w, axis=0)
        return np.where(norm > 0, total / np.maximum(norm, 1e-6), np.nan)


def flow_residual(
    target_gray: np.ndarray,
    neighbor_gray: np.ndarray,
    matrix: np.ndarray,
    ring: np.ndarray,
    contrast: float,
) -> float:
    """
    How badly a motion estimate describes what actually happened, as the mean
    absolute error over the clean ring after warping, divided by the ring's
    contrast.

    The ring is the only place the answer is known: the selection itself is
    covered in both frames. If the model cannot reproduce the pixels around
    the mark it will not reproduce the ones behind it either.

    Returns `inf` where there is too little ring left to judge, which counts
    as a failure — an unverifiable estimate is not a usable one.
    """
    height, width = target_gray.shape
    ys, xs = np.mgrid[0:height, 0:width]
    xs = xs.astype(np.float32)
    ys = ys.astype(np.float32)
    map_x = xs + (matrix[0, 0] * xs + matrix[0, 1] * ys + matrix[0, 2])
    map_y = ys + (matrix[1, 0] * xs + matrix[1, 1] * ys + matrix[1, 2])

    warped = cv2.remap(neighbor_gray, map_x.astype(np.float32), map_y.astype(np.float32),
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    # Only where the sample came from inside the crop: elsewhere the border
    # colour would be compared against real pixels.
    inside = ring & (map_x >= 0) & (map_x <= width - 1) & (map_y >= 0) & (map_y <= height - 1)
    if np.count_nonzero(inside) < MIN_VERIFY_POINTS:
        return float('inf')

    error = np.abs(warped[inside].astype(np.float32) - target_gray[inside].astype(np.float32))
    return float(error.mean()) / max(contrast, 1.0)


def ring_contrast(gray: np.ndarray, ring: np.ndarray) -> float:
    """Mean absolute deviation of the clean ring — how much there is to match."""
    values = gray[ring].astype(np.float32)
    if values.size == 0:
        return 0.0
    return float(np.mean(np.abs(values - values.mean())))


def process_temporal(
    frame: np.ndarray,
    mask: np.ndarray,
    roi: tuple[int, int, int, int],
    neighbor_at: NeighborSource,
    quality: str = DEFAULT_QUALITY,
    fallback_radius: int = 3,
    on_degraded: DegradeReport | None = None,
) -> np.ndarray:
    """
    Reconstruct the ROI of `frame` from the frames around it.

    :param frame: BGR uint8 frame to reconstruct.
    :param mask: Binary ROI mask, as `image_core.create_mask` builds it.
    :param roi: The already-clamped (x, y, w, h) selection.
    :param neighbor_at: Called with a signed frame offset; returns that frame
        or None where there is none. Returning None is not an error — the
        first frame of a video has nothing before it — and it is called only
        as far out as the reconstruction needs to walk.
    :param quality: A key of `QUALITY_PRESETS`.
    :param fallback_radius: Inpaint radius for pixels no neighbour covered.
    :param on_degraded: Called with a short reason if a failure forced this
        frame back to the single-frame fill. Not called when the shot itself
        offers nothing to rebuild from — that is the engine working, not
        failing, and the caller counts these to tell the user.
    """
    settings = quality_settings(quality)
    x, y, w, h = roi
    height, width = frame.shape[:2]

    # Every pixel the flow cannot reach comes from here, so it is computed
    # whether or not any neighbour turns up.
    baseline = process_inpaint(frame, mask, radius=fallback_radius, roi=roi)

    # The rectangle actually painted: the selection plus the band the result
    # is feathered across.
    feather = settings.feather
    ox0, oy0 = max(0, x - feather), max(0, y - feather)
    ox1, oy1 = min(width, x + w + feather), min(height, y + h + feather)

    # The crop the flow is computed over, and the ring of clean pixels in it
    # the motion is fitted to.
    margin = flow_margin(w, h)
    cx0, cy0 = max(0, x - margin), max(0, y - margin)
    cx1, cy1 = min(width, x + w + margin), min(height, y + h + margin)

    ring = np.ones((cy1 - cy0, cx1 - cx0), dtype=bool)
    ring[
        max(0, y - WATERMARK_SAFETY - cy0):max(0, y + h + WATERMARK_SAFETY - cy0),
        max(0, x - WATERMARK_SAFETY - cx0):max(0, x + w + WATERMARK_SAFETY - cx0),
    ] = False

    target_gray = cv2.cvtColor(frame[cy0:cy1, cx0:cx1], cv2.COLOR_BGR2GRAY)
    scale = settings.flow_scale
    small_target = (
        cv2.resize(target_gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        if scale < 1.0 else target_gray
    )

    # Pixels a neighbour may be read from: all of it except its own mark,
    # which sits in the same place in every frame.
    clean = np.ones((height, width), dtype=np.float32)
    clean[
        max(0, y - WATERMARK_SAFETY):y + h + WATERMARK_SAFETY,
        max(0, x - WATERMARK_SAFETY):x + w + WATERMARK_SAFETY,
    ] = 0.0

    estimate_flow = flow_estimator(settings)
    contrast = ring_contrast(target_gray, ring)

    def gray_crop(image: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(image[cy0:cy1, cx0:cx1], cv2.COLOR_BGR2GRAY)

    def scaled(gray: np.ndarray) -> np.ndarray:
        if scale >= 1.0:
            return gray
        return cv2.resize(gray, small_target.shape[::-1], interpolation=cv2.INTER_AREA)

    def step_displacement(previous: np.ndarray, current: np.ndarray) -> np.ndarray:
        """
        The affine displacement from one frame's crop to the next one's, both
        already at flow resolution.
        """
        flow = estimate_flow(previous, current)
        if scale < 1.0:
            # Back to full resolution: both the field and the vectors in it.
            flow = cv2.resize(flow, (cx1 - cx0, cy1 - cy0),
                              interpolation=cv2.INTER_LINEAR) / scale
        return fit_affine_flow(flow, ring)

    candidates: list[np.ndarray] = []
    weights: list[float] = []
    counts = np.zeros((oy1 - oy0, ox1 - ox0), dtype=np.int16)
    barren = 0
    # Whether anything was lost to a failure rather than to the shot itself.
    # A walk that stops because the footage is locked off is the engine
    # working; one that stops because a call raised is worth a line in the log.
    degraded = False

    # One walk per direction, each remembering where it has got to: the last
    # frame it reached (at flow resolution, ready to be the next step's
    # starting point) and the composed displacement from this frame to it.
    walks = {
        +1: {'small': small_target, 'model': np.zeros((2, 3)), 'alive': True},
        -1: {'small': small_target, 'model': np.zeros((2, 3)), 'alive': True},
    }

    # Alternating sides, a frame at a time: the nearest frames are the most
    # likely to still show the same scene, and the walk usually ends in the
    # first few steps.
    ladder = [step * side for step in range(1, settings.max_links + 1) for side in (1, -1)]

    for offset in ladder:  # 1, -1, 2, -2, …
        if not any(w['alive'] for w in walks.values()):
            break  # both directions are finished; the rest of the ladder is a no-op
        side = 1 if offset > 0 else -1
        walk = walks[side]
        if not walk['alive']:
            continue

        neighbor = neighbor_at(offset)
        if neighbor is None or neighbor.shape != frame.shape:
            # The end of the video, or a frame of a different size — which
            # cannot be sampled with this frame's coordinates. Either way this
            # direction is finished: the walk cannot step over a missing frame.
            walk['alive'] = False
            continue

        try:
            neighbor_gray = gray_crop(neighbor)
            small_neighbor = scaled(neighbor_gray)
            model = compose(
                walk['model'], step_displacement(walk['small'], small_neighbor))
        except MemoryError:
            raise MemoryError(OUT_OF_MEMORY_MESSAGE) from None
        except (cv2.error, np.linalg.LinAlgError) as exc:
            # A frame the estimator would not take: a decode that came back
            # the wrong depth, a crop OpenCV rejects, a solve that would not
            # converge. One neighbour failing is not the job failing — but the
            # next step in this direction starts from this one, so there is
            # nowhere left to walk on this side.
            warn_degraded(f'optical flow failed at offset {offset:+d} '
                 f'({type(exc).__name__}), ending that direction: {exc}')
            walk['alive'] = False
            degraded = True
            continue

        walk['small'] = small_neighbor
        walk['model'] = model

        if flow_residual(target_gray, neighbor_gray, model, ring, contrast) > FLOW_RESIDUAL_LIMIT:
            # The model does not even reproduce the pixels it was fitted to —
            # a cut, something crossing the shot, or a step the estimator lost
            # track of. Whatever it would put behind the mark is not the
            # background, and every further step in this direction is built on
            # it, so the direction ends here.
            walk['alive'] = False
            barren += 1
            if barren >= NO_GAIN_PATIENCE:
                break
            continue

        try:
            map_x, map_y = sample_grid(model, ox0, oy0, ox1, oy1, cx0, cy0)

            sample = cv2.remap(neighbor, map_x, map_y, cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            coverage = cv2.remap(clean, map_x, map_y, cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        except MemoryError:
            raise MemoryError(OUT_OF_MEMORY_MESSAGE) from None
        except cv2.error as exc:
            # The model verified, so the walk itself is sound and may carry on
            # from here; only this neighbour's sample is lost.
            warn_degraded(f'sampling neighbour {offset:+d} failed, skipping it: {exc}')
            degraded = True
            continue

        valid = coverage >= VALID_THRESHOLD

        patch = sample.astype(np.float32)
        patch[~valid] = np.nan
        candidates.append(patch)
        # The nearest frame is the most likely to still show the same thing.
        weights.append(1.0 / (1.0 + abs(offset)))

        wanted = counts < settings.min_samples
        gained = np.count_nonzero(valid & wanted)
        counts += valid
        barren = 0 if gained else barren + 1

        if not np.any(counts < settings.min_samples):
            break  # every pixel has all the samples it was going to get
        if barren >= NO_GAIN_PATIENCE:
            break  # nothing is moving; walking further would say so too

    if not candidates:
        if degraded:
            report_degraded(
                on_degraded,
                'no neighbour survived; falling back to single-frame fill')
        return baseline

    try:
        fused = fuse_candidates(candidates, weights, settings.fuse)
    except MemoryError:
        # The stack of candidates is the largest allocation here, and it is
        # proportional to the selection and to how far the walk went. The
        # baseline fill is already computed and costs nothing to return.
        report_degraded(
            on_degraded,
            'out of memory fusing candidates; falling back to single-frame fill')
        return baseline

    filled = np.where(np.isnan(fused),
                      baseline[oy0:oy1, ox0:ox1].astype(np.float32), fused)

    alpha = feather_alpha(
        ox1 - ox0, oy1 - oy0,
        left=x - ox0, right=ox1 - (x + w),
        top=y - oy0, bottom=oy1 - (y + h),
    )[:, :, None]

    result = frame.copy()
    region = frame[oy0:oy1, ox0:ox1].astype(np.float32)
    blended = region * (1.0 - alpha) + filled * alpha
    result[oy0:oy1, ox0:ox1] = np.rint(np.clip(blended, 0, 255)).astype(np.uint8)
    return result
