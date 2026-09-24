"""
Telling a watermark from a subtitle, a sticker and the picture itself.

`recover` follows one mark, the one the user pointed at. That is the right
thing to do when they have pointed at something, and no use at all when the
answer is supposed to be "here is what is on your video, which of it do you
want gone". This module asks the open question: find everything that holds
still, and say what each of them is.

Nothing here classifies by appearance, which is what the obvious approach
would be and what does not work — a platform mark and a burnt-in subtitle are
both white type with a soft shadow. What separates them is how they behave, and
four measurements taken on the reported clip say so plainly:

                            windows  stability  coverage  peak α  aspect  edge
    Douyin mark, bottom-right     8      0.964     0.272    0.80    1.79  0.02
    Douyin mark, top-left         4      0.940     0.215    0.13    0.03  0.03
    burnt-in subtitle             5      0.275     0.492    1.00    6.28  0.23

- **Stability** is the correlation of a region's detail with *itself* one window
  later. A mark is the same pixels for as long as it is there, so it comes back
  at 0.94 and up. A subtitle holds still within a window and then says something
  else, so it comes back at 0.28 — as unlike itself as two unrelated regions.
  This is the measurement that does the work; the rest keep it honest.

- **Peak opacity** is what the solve found. A mark is composited *into* the
  picture and has an opacity below one; a subtitle is painted over it and has an
  opacity of exactly one. That also says which of them this app can recover the
  picture from, and which it can only paint over.

- **Edge distance** is how close the region sits to the side of the frame.
  Platform marks are anchored to a corner because that is what a platform
  renderer does. It is what rules out the things in the middle of the picture
  that happen to hold still for a few seconds.

- **Aspect** separates a subtitle from a sticker among what is left: a line of
  type is six times wider than it is tall.

Everything that survives the solve is reported, whatever it turns out to be.
Only the marks are proposed for removal, because only the marks are what the
user came here for, and silently dissolving a subtitle is data loss dressed up
as a feature.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

import dewatermark
import recover

# Windows a region must be seen in before it can be reported at all, and the
# larger number everything the app is not proposing to remove has to clear.
#
# Two windows is one stability comparison, which is a weak measurement — but a
# mark that is only on screen for five seconds has nothing more to offer, and
# on the reported clip the top-left one is exactly that. Dropping it for want
# of a third window means the app misses half of what the user asked about, so
# two is allowed, and what a two-window region has to clear instead is the same
# stability bar as everything else.
#
# A finding that is merely being *listed* has no such excuse. It is not being
# proposed, nobody is waiting on it, and at two windows the list fills with
# stretches of picture that happen to hold still — fifteen rows where four
# would do. Those wait for a third.
MIN_WINDOWS = 2
MIN_WINDOWS_TO_LIST = 3

# How much of a finding has to lie inside a larger one, whose time overlaps it,
# for the two to be the same thing found twice. A mark's glyph and its line of
# type are both mark-shaped on their own, and reporting them as three findings
# asks the user to make the same decision three times.
CONTAINED_FRACTION = 0.7

# Stability at or above which a region is the same thing it was a window ago.
# Measured 0.94 and 0.96 for the two marks, 0.28 for the subtitle — the gap is
# wide enough that where the threshold sits inside it hardly matters.
STABLE_CONTENT = 0.80

# Peak opacity at or above which a region is painted over the picture rather
# than blended into it. Nothing this app does can recover what is under an
# opaque region, so calling one a watermark would promise what it cannot do.
OPAQUE_ALPHA = 0.95

# How close to the side of the frame a region must sit to be a platform mark,
# as a fraction of the frame. The two marks measured 0.02 and 0.03; the
# subtitle, which is inset from every side, measured 0.23.
EDGE_FRACTION = 0.08

# Width-to-height above which a region is a line of type rather than a badge.
SUBTITLE_ASPECT = 3.0

# How badly the blend may fit, in levels, for a region to be a platform mark.
#
# This is the premise of the whole engine used as a test: a platform mark *is*
# an alpha composite of a fixed shape, so the model explains it almost exactly.
# The things that look like marks and are not — a creator's caption with an
# outline, a title card that animates in — are not one fixed blend, and the fit
# says so. Measured on the reported clip: the two Douyin marks came back at
# 11.5 and 14.2 levels, its "副驾驶安全拍摄" caption at 39.9, its "彩蛋" title
# card at 18.4 and its subtitles at 45.3.
#
# The margin between 14.2 and 18.4 is thin, and it is allowed to be, because
# this decides a checkbox and not an outcome: a mark ruled out is still on the
# list to be ticked, and a caption let through is pre-ticked and unticked. That
# confirmation step is exactly what a 30% margin is not good enough without.
MAX_RESIDUAL = 16.0

# How strongly the mark's own shape has to show through in a window for the
# mark to be counted as present in it. The detected range is where the scan
# happened to see something, which is not the same as where the mark is: on the
# reported clip the top-left mark was found from two seconds in, and the two
# seconds before that are two seconds of watermark the export would have left
# alone. Measured on that clip, a window with the mark in it scores around 0.76
# and clean footage around zero, so the bar sits well clear of both.
PRESENT_SCORE = 0.30

# Frames sampled per window when testing presence. Three, because the question
# is only whether the mark is there, and it either is for the whole window or
# is not.
PRESENCE_SAMPLES = 3

# The patch size regions are resampled to before being correlated, so that two
# of them can be compared whatever their pixel dimensions.
SIGNATURE_SIZE = (48, 48)

WATERMARK = 'watermark'
SUBTITLE = 'subtitle'
OTHER = 'other'


@dataclass(frozen=True)
class Finding:
    """One thing that holds still, what it is, and where and when."""

    box: tuple[int, int, int, int]
    start: int
    end: int
    kind: str
    coverage: float
    stability: float
    peak_alpha: float
    windows: int

    @property
    def proposed(self) -> bool:
        """Whether this is offered for removal without being asked for."""
        return self.kind == WATERMARK


def _signature(magnitude: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = box
    patch = cv2.resize(magnitude[y:y + h, x:x + w].astype(np.float32),
                       SIGNATURE_SIZE, interpolation=cv2.INTER_AREA)
    centred = patch - patch.mean()
    norm = float(np.linalg.norm(centred))
    return centred / norm if norm > 1e-6 else centred


def stability(maps: list[np.ndarray], box: tuple[int, int, int, int]) -> float:
    """
    How much a region looks like itself one window later, over the windows it
    was seen in.

    Always measured on the *same* box rather than each window's own detection,
    so that what is being compared is the content and not the framing.

    A low percentile rather than the median or the mean, because the claim
    being tested is "this never changes". A subtitle that holds a line for two
    windows and then says something else agrees with itself half the time, and
    a median reads that as stability; what gives it away is that it sometimes
    does not. A mark has no such moments — on the reported clip every
    consecutive pair of its windows came back above 0.95 — so taking the worst
    quarter costs it nothing and costs the subtitle everything.
    """
    if len(maps) < 2:
        return float('nan')
    signatures = [_signature(m, box) for m in maps]
    scores = [float((a * b).sum()) for a, b in zip(signatures, signatures[1:])]
    return float(np.percentile(scores, 25))


def edge_distance(box: tuple[int, int, int, int], width: int, height: int) -> float:
    """
    How far a box sits from the nearest side of the frame, as a fraction of the
    frame, taking the closer of the two axes.

    Zero means it touches a side. A platform mark is anchored to a corner, so
    both of its axes are near zero; the number below is the larger claim — that
    it is near a side at all — which is what the things in the middle of the
    picture fail.
    """
    x, y, w, h = box
    horizontal = min(x, width - (x + w)) / max(width, 1)
    vertical = min(y, height - (y + h)) / max(height, 1)
    return float(min(horizontal, vertical))


def could_be_a_mark(box: tuple[int, int, int, int], stable: float,
                    width: int, height: int) -> bool:
    """
    Whether a region could be a watermark, from the two tests that cost
    nothing: does it hold its content, and is it against the side of the frame.

    This exists to avoid solving. The solve is where nearly all of a survey's
    time goes — 140 of 151 seconds on the reported clip, over 173 candidate
    stretches that produced twelve findings — and a stretch seen in only two
    windows is never reported unless it turns out to be a mark. Both of the
    mark tests that do not need a model can therefore be asked first, and a
    stretch that fails either one is one the solve would only have confirmed we
    had nothing to say about.

    It is a necessary condition, not the classification: everything that gets
    past here is still solved and still has to pass `classify`.
    """
    return (stable >= STABLE_CONTENT
            and edge_distance(box, width, height) <= EDGE_FRACTION)


def classify(box: tuple[int, int, int, int], model, stable: float,
             width: int, height: int) -> str:
    """What a region is, from how it behaves rather than how it looks."""
    x, y, w, h = box
    peak = float(np.percentile(model.alpha, 95))

    if (stable >= STABLE_CONTENT
            and peak < OPAQUE_ALPHA
            and model.residual <= MAX_RESIDUAL
            and edge_distance(box, width, height) <= EDGE_FRACTION):
        return WATERMARK

    # Not a mark. A line of type says something else every few seconds, which
    # is exactly what failing the stability test looks like, and it is wide.
    if stable < STABLE_CONTENT and w >= SUBTITLE_ASPECT * h:
        return SUBTITLE

    return OTHER


def legibility(read, box: tuple[int, int, int, int], alpha: np.ndarray,
               indices: list[int]) -> float:
    """
    How much of the mark's own shape is visible in these frames.

    The same question the app is ultimately judged on — can you still see it —
    asked of the input rather than the output, and against the solved opacity
    rather than a guess at the shape.
    """
    x, y, w, h = box
    shape = alpha - alpha.mean()
    shape_norm = float(np.linalg.norm(shape))
    if shape_norm <= 1e-6:
        return 0.0

    scores = []
    for index in indices:
        frame = read(index)
        if frame is None:
            continue
        patch = cv2.cvtColor(frame[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY).astype(np.float32)
        detail = patch - cv2.medianBlur(patch.astype(np.uint8), 21).astype(np.float32)
        detail -= detail.mean()
        norm = float(np.linalg.norm(detail))
        if norm > 1e-6:
            scores.append(float((detail * shape).sum() / (norm * shape_norm)))
    return float(np.mean(scores)) if scores else 0.0


def extent(read, box: tuple[int, int, int, int], alpha: np.ndarray,
           core: tuple[int, int], total: int, window: int) -> tuple[int, int]:
    """
    The stretch of frames the mark is actually on screen for, found by looking.

    The scan's answer is where it happened to notice the mark, which is neither
    where the mark starts nor where it ends: a busy window finds it late, and a
    window after it has gone can still cluster with the ones before. Both cost
    the user the same thing — frames that keep their watermark, or frames whose
    picture is divided by an opacity that is not there.

    So the range is grown and trimmed against the mark itself, one window at a
    time outward from where the scan was confident, and stops at the first
    window the mark cannot be seen in.
    """
    def present(start: int) -> bool:
        end = min(start + window, total)
        if end <= start:
            return False
        step = max(1, (end - start) // PRESENCE_SAMPLES)
        frames = list(range(start, end, step))[:PRESENCE_SAMPLES]
        return legibility(read, box, alpha, frames) >= PRESENT_SCORE

    first, last = core
    while first - window >= 0 and present(first - window):
        first -= window
    while last + window <= total and present(last):
        last += window
    # Trim from the front only as far as the core, never past it: the scan was
    # confident there, and a presence test that disagrees with it over the
    # whole finding means the finding was wrong, not that it is empty.
    return max(0, first), min(total, last)


def typical_box(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    """
    One box for a run of detections of the same thing.

    Neither the first of them nor the union of all of them. The first is
    whatever that window happened to pick up, and on a long video that can be
    half a mark — half a box is half a mark removed, with the rest still on
    screen. The union is worse in the other direction: over a hundred windows
    it swallows everything that ever clustered in, and on the reported clip it
    turned a 126x73 mark into a 176x109 box with the picture inside it.

    So each side is taken at a quartile: far enough out to cover the rim that
    only some windows saw, not so far that one window's stray detection decides
    where the mark ends.
    """
    lefts = [b[0] for b in boxes]
    tops = [b[1] for b in boxes]
    rights = [b[0] + b[2] for b in boxes]
    bottoms = [b[1] + b[3] for b in boxes]
    left = int(np.percentile(lefts, 25))
    top = int(np.percentile(tops, 25))
    right = int(np.percentile(rights, 75))
    bottom = int(np.percentile(bottoms, 75))
    return (left, top, max(1, right - left), max(1, bottom - top))


def _clusters(seen: list[tuple[tuple[int, int], np.ndarray, list]]) -> list[dict]:
    """
    Group detections in the same place across windows, keeping each window's
    map so the content can be compared later.

    Membership is judged against the box the cluster started with, for the same
    reason `recover` does it: a running union drifts until it is a box nothing
    in it would have matched.
    """
    clusters: list[dict] = []
    for span, magnitude, candidates in seen:
        for candidate in candidates:
            for cluster in clusters:
                if recover._iou(cluster['seed'], candidate.box) >= recover.SAME_PLACE_IOU:
                    held = cluster['windows'].get(span)
                    cluster['windows'][span] = (
                        recover._union(held[0], candidate.box) if held else candidate.box,
                        magnitude,
                    )
                    break
            else:
                clusters.append({'seed': candidate.box,
                                 'windows': {span: (candidate.box, magnitude)}})
    return clusters


def _runs(windows: dict, window: int) -> list[list[tuple[int, int]]]:
    """
    A cluster's windows split into the stretches it was actually present for.

    A mark in one corner for the first five seconds, and something unrelated
    detected in the same corner a minute later, is one cluster and two very
    different answers. Reporting it as one stretch would hand the export a
    model to apply over the whole minute between them — over frames the mark is
    not in, where undoing a blend that is not there is damage.

    Short gaps are kept inside a run for the same reason `recover.close_gaps`
    exists: a window straddling a move, or one busy scene, can lose a mark that
    never went anywhere.
    """
    runs: list[list[tuple[int, int]]] = []
    for span in sorted(windows):
        if runs and span[0] - runs[-1][-1][1] <= recover.GAP_WINDOWS * window:
            runs[-1].append(span)
        else:
            runs.append([span])
    return runs


def survey(read, total: int, width: int, height: int,
           window: int = recover.SCAN_WINDOW_FRAMES,
           on_progress=None, fit_all=None, scan_all=None,
           gather_all=None) -> list[Finding]:
    """
    Everything on this video that holds still, and what each of them is.

    `read(index)` returns frame `index` as a full-size BGR array, or None. The
    sequence does not have to be every frame of the video — this is meant to be
    run over a sampled decode — but `window` has to be the number of *those*
    frames that covers the couple of seconds a window is supposed to be.

    Returns findings in frame order of the sequence it was given. Converting
    those indices to times is the caller's job, because only the caller knows
    what it sampled at.

    `gather_all(boxes, lengths, wanted)` is the third of these and the same
    idea: decoding each frame once for every placement that wants it is a list
    of independent jobs too, and it is the one phase that was still serial.

    `scan_all(spans, scale)` returns each window's persistence map, in order,
    or None for a window too short to have one. Same seam and same reason as
    `fit_all`: the windows are independent, and a window is sixteen decodes
    and a median, so this is where a detect's *decoding* goes parallel too.

    `fit_all(jobs, on_progress)` solves every `(crops, placement)` and returns
    a model per job, or None where there was nothing to solve. It is used only
    when the crops were gathered up front; a placement that has to read its own
    frames is solved here, because a pool in another process cannot carry a
    reader. It is a seam so
    that *how* the solves are run — here, or spread over a pool — is the
    caller's decision and not this module's: the placements are independent
    and the solve is the largest cost in a detect, but multiprocessing belongs
    with the code that already owns a pool and knows how to cancel it. The
    default runs them here, one at a time.
    """
    if total <= 0:
        return []

    scale = recover._scale_for(width, height)
    spans = list(recover.windows(total, window))
    magnitudes = (scan_all(spans, scale) if scan_all
                  else [recover.window_magnitude(read, start, end, scale)
                        for start, end in spans])
    seen = []
    for span, magnitude in zip(spans, magnitudes):
        if magnitude is not None:
            seen.append((span, magnitude, recover.candidates(magnitude)))

    stretches = []
    for cluster in _clusters(seen):
        for run in _runs(cluster['windows'], window):
            if len(run) < MIN_WINDOWS:
                continue
            stretches.append((
                typical_box([cluster['windows'][span][0] for span in run]),
                run,
                [cluster['windows'][span][1] for span in run],
            ))

    scan_width, scan_height = int(width * scale), int(height * scale)

    # Everything that survives the free tests, with the placement it will be
    # solved at. Gathered before anything is solved so the frames can be read
    # once for all of them — see `_crops_for`.
    planned: list[tuple] = []
    for seed, run, maps in stretches:
        # Both free tests first, and for a stretch that would only ever be
        # reported as a mark, they decide it on their own.
        stable = stability(maps, seed)
        if (len(run) < MIN_WINDOWS_TO_LIST
                and not could_be_a_mark(seed, stable, scan_width, scan_height)):
            continue
        box = recover.clamp_box(
            recover._rescale(seed, scale), width, height,
            pad=max(1, int(round(recover.BOX_PAD / scale))))
        planned.append((seed, run, stable,
                        recover.Placement(run[0][0], run[-1][1], box)))

    # None when there was too much to hold at once; each placement then reads
    # its own frames, as it used to.
    crops = _crops_for(read, [plan[3] for plan in planned], gather_all)

    if crops is None:
        # Too much to gather at once, so each placement reads its own frames —
        # which a pool in another process cannot do, because what it would
        # have to carry across is the reader.
        models = _fit_here([(None, plan[3]) for plan in planned], read, on_progress)
    else:
        jobs = [(crops[index], plan[3]) for index, plan in enumerate(planned)]
        models = (fit_all(jobs, on_progress) if fit_all
                  else _fit_here(jobs, read, on_progress))

    findings: list[Finding] = []
    for (seed, run, stable, placement), model in zip(planned, models):
        box = placement.box
        # None where there was nothing to solve — a stretch the decode could
        # not serve. One of those is not the survey failing.
        if model is None or not recover.believable(model):
            # Nothing the solve can find is nothing to report either. The
            # picture holding still is not a finding, it is the video.
            continue

        start, end = extent(read, box, model.alpha,
                            (placement.start, placement.end), total, window)
        findings.append(Finding(
            box=box,
            start=start,
            end=end,
            kind=classify(seed, model, stable, scan_width, scan_height),
            coverage=model.coverage,
            stability=stable,
            peak_alpha=float(np.percentile(model.alpha, 95)),
            windows=len(run),
        ))

    return _merged(findings)


def _fit_here(jobs: list[tuple], read, on_progress=None) -> list:
    """Solve every placement in this process, which is what it always did."""
    models = []
    for done, (crops, placement) in enumerate(jobs, start=1):
        if on_progress:
            on_progress(done, len(jobs))
        try:
            models.append(recover.fit_crops(crops, placement) if crops is not None
                          else recover.fit_placement(read, placement))
        except IOError:
            models.append(None)
    return models


# How much cropped picture to gather in one pass, in bytes.
#
# The crops are small — they are the size of the things found, not of the
# video — and on the clip this was measured against all 188 placements came to
# 39 MB together. The cap is for the pathological case: a video where the scan
# proposes hundreds of large stretches. Past it the frames are read per
# placement as they used to be, which is slower and bounded.
CROP_BUDGET_BYTES = 512 * 1024 * 1024


def _crops_for(read, placements: list, gather_all=None) -> 'list[list] | None':
    """
    Every placement's frames, cropped, reading each frame once.

    The placements overlap — they are stretches of one video — so solving them
    one at a time means decoding the same frame once per placement that wants
    it. On a two-minute clip that was 4565 decodes of 961 frames, and decoding
    was the largest single cost in the pass.

    Ordering is what makes this identical rather than merely similar: each
    placement's crops come back in the order `sample_indices` asked for them,
    which is the order `fit_placement` would have produced, and a frame that
    cannot be read is skipped in exactly the same way.

    Returns None when the crops would not fit in `CROP_BUDGET_BYTES`, which
    tells the caller to read per placement instead.
    """
    wanted: dict[int, list[tuple[int, int]]] = {}
    lengths = []
    budget = 0
    for slot, placement in enumerate(placements):
        indices = recover.sample_indices(placement.start, placement.end,
                                         recover.FIT_SAMPLES)
        lengths.append(len(indices))
        _, _, w, h = placement.box
        budget += w * h * 3 * len(indices)
        for position, index in enumerate(indices):
            wanted.setdefault(index, []).append((slot, position))

    if budget > CROP_BUDGET_BYTES:
        # Too much to hold at once. The caller falls back to reading per
        # placement, which is what this replaced: slower, and the memory is one
        # placement's worth.
        return None

    if gather_all is not None:
        return gather_all([placement.box for placement in placements],
                          lengths, wanted)

    gathered: list[list] = [[None] * length for length in lengths]
    for index in sorted(wanted):
        frame = read(index)
        if frame is None:
            continue
        for slot, position in wanted[index]:
            x, y, w, h = placements[slot].box
            # Copied, because the frame it came from is about to be dropped —
            # and under a caching reader it may be handed out again.
            gathered[slot][position] = frame[y:y + h, x:x + w].copy()
    return [[crop for crop in one if crop is not None] for one in gathered]


def _covered(inner: tuple[int, int, int, int], outer: tuple[int, int, int, int]) -> float:
    """How much of `inner`'s area lies inside `outer`."""
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    left, top = max(ix, ox), max(iy, oy)
    right, bottom = min(ix + iw, ox + ow), min(iy + ih, oy + oh)
    if right <= left or bottom <= top:
        return 0.0
    return (right - left) * (bottom - top) / float(max(iw * ih, 1))


def _merged(findings: list[Finding]) -> list[Finding]:
    """
    One thing, reported once, and the weak evidence dropped.

    A mark is glyphs and lines with gaps between them, and at a fine enough
    window each piece is its own detection — on the reported clip the
    bottom-right mark came back as itself plus two of its own lines, all three
    classified as watermarks and all three asking the user the same question.
    The largest one wins: a box that contains the pieces contains the mark.
    """
    kept: list[Finding] = []
    for finding in sorted(findings, key=lambda f: -f.box[2] * f.box[3]):
        # A mark is never swallowed by something that is not one. The largest
        # box wins among equals, but a stretch of picture that happens to hold
        # still is often larger than the mark sitting inside it, and letting it
        # win would take the one row the user came for off the list entirely.
        if any(_covered(finding.box, other.box) >= CONTAINED_FRACTION
               and finding.start < other.end and other.start < finding.end
               and (other.proposed or not finding.proposed)
               for other in kept):
            continue
        if not finding.proposed and finding.windows < MIN_WINDOWS_TO_LIST:
            continue
        kept.append(finding)

    kept.sort(key=lambda f: (not f.proposed, f.start, f.box[1], f.box[0]))
    return kept
