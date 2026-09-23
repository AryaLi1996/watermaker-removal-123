"""
Finding the mark, over time, so nobody has to draw a box around it.

`dewatermark` solves a mark given where it sits. That leaves two things it
cannot answer on its own, and both of them decide whether the result is any
good on real footage:

**Where.** A box drawn by hand is a box drawn around what the user can see. A
platform mark has a soft rim and a drop shadow that reach further than the eye
puts the edge, and solving a box that clips them leaves a ring of untouched
mark behind — the thin bright outline that reads as "something was done here".
The mark's own persistence finds the true extent: it is the only detail that
holds still while the picture behind it does not.

**When.** Douyin moves its mark. On the clip this was built against it sits
top-left for the first five seconds and bottom-right for the remaining
hundred-odd — one box cannot describe that, and a model fitted across the move
describes neither position. So the timeline is cut into windows, each window is
asked where the mark is, and windows that agree are merged back into a
placement: a box plus the span of frames it holds for.

Two things about that search were settled by measurement rather than taste, and
both cost a version of this file that did not work:

*A fixed threshold on the persistence map finds nothing.* The map's scale
depends entirely on the footage. Over a busy scene the mark stands at 46 while
the picture's own detail sits at 4; over a near-static one the picture reaches
133 and the mark 127. At `dewatermark`'s own floor of 1.5, more than half of
every frame came back "persistent" and the mark dissolved into one component
the size of the picture. The scan therefore judges each window's map against
itself, at several percentiles — a mark that hides at one of them shows at
another, and the extra candidates cost nothing because they still have to look
like the mark.

*The mark's shape is not what identifies it.* The obvious test — take the
user's mark as a template and correlate it against everything else — fails on
the very case it exists for. Douyin does not merely move the mark, it re-lays
it out: the top-left version is left-aligned and the bottom-right version is
right-aligned, and the two correlate at 0.32, no better than the same clip's
subtitles at 0.30. What does survive the move is its *size* (125x71 against
126x73) and the fact that it then holds that position, to the pixel, for
window after window. So a candidate is taken for the mark when it matches the
seed's dimensions and recurs in the same place — which is a fair description of
what a watermark is, and not one of a passing scene element.

What this does *not* do yet is tell a watermark from a subtitle or a sticker.
It looks for one mark — the one under the user's box — and follows that mark
wherever it goes. Anything else that holds still is left alone, which is the
conservative failure: a subtitle that survives is a subtitle the user can see
was not touched, where a subtitle silently dissolved is data loss.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass

import cv2
import numpy as np

import dewatermark

# How many frames one scan window covers. Two seconds of 30fps footage: long
# enough that a mark standing still over it is distinguishable from a picture
# that happens to be static, short enough that a mark which moves is caught
# within a window or two of moving.
SCAN_WINDOW_FRAMES = 60

# Frames actually decoded per window. `persistence` takes every fourth of what
# it is given, so sixteen is four high-pass maps to take a median of — enough
# for a median to mean anything, and eight reads per second of video.
SCAN_WINDOW_SAMPLES = 16

# The longest side the scan works at. The mark shrinks with the picture, so
# what the scan is looking for is unchanged, while the cost and the memory of
# holding a window of frames stop depending on whether the video is 480p or 4K.
SCAN_MAX_SIDE = 960

# Frames used to fit one placement's model. The solve wants variety behind the
# mark more than it wants quantity: these are spread across the placement's
# whole span rather than taken consecutively, so they see different scenes.
FIT_SAMPLES = 24

# Where each window's map is cut, as percentiles of its own magnitude. Several
# because the right one depends on how much of the picture holds still, which
# is a property of the footage and not knowable in advance — on the clip this
# was built against the mark showed at the 94th in one window and only at the
# 98th in the next. The highest cut earns its place on busy footage, where at
# the lower ones the mark joins the texture around it into one component too
# big to be a mark and is thrown out with it.
SCAN_PERCENTILES = (94.0, 96.0, 97.0, 98.0, 99.0)

# A floor under those percentiles, in levels. On footage that is genuinely
# still — a locked-off shot of a wall — the 98th percentile of the map is
# noise, and thresholding at it turns noise into candidates.
MIN_THRESHOLD = 1.5

# Strokes this far apart (in scan pixels) are taken to be one mark. A logo is
# glyphs and gaps; without this every stroke is its own detection.
MERGE_RADIUS = 9

# Bounds on a candidate, as scan pixels, as a fraction of the scanned frame's
# area, and as a fraction of each of its sides. Below the floor it is noise
# that survived the median; above either ceiling it is not a mark but the
# picture, and solving the picture as a mark would subtract it from itself.
MIN_MARK_AREA = 60
MAX_MARK_FRACTION = 0.25
MAX_MARK_SIDE_FRACTION = 0.6

# Overlap at which two candidates are the same detection (when deduplicating
# one window's percentiles) or the same placement (when following the mark
# across windows).
DEDUPE_IOU = 0.6
SAME_PLACE_IOU = 0.3

# How far a candidate may differ from the seed in each dimension to be taken
# for the same mark somewhere else. Tight, because after the move this is the
# only evidence left: the measured difference across the move was 2%.
SIZE_TOLERANCE = 0.25

# Windows a placement must be seen in before it is believed. One window of a
# mark-sized thing holding still is a scene; several in the same place, to the
# pixel, is a watermark. Waived where the whole clip is shorter than that.
MIN_PLACEMENT_WINDOWS = 2

# How much of a placement the solve must find a mark in for the placement to
# be believed. The scan can only see that something holds still; the solve is
# what knows whether it is alpha-composited onto the picture or part of it.
# Measured on the clip this was built against: the two real marks came back at
# 0.29 and 0.27, and a static shot of a document that the scan had taken for a
# third mark came back at 0.027, with a peak opacity of zero. Three times clear
# of either.
MIN_MODEL_COVERAGE = 0.08

# Scan pixels of margin added around a detection before it is solved. The rim
# and shadow the eye does not place are exactly what a clipped box leaves
# behind, and the solve costs nothing extra for pixels where the opacity comes
# back as zero.
BOX_PAD = 3

# Windows of nothing that are still counted as the mark continuing. A window
# straddling a move sees the mark in two places and may match neither; without
# this the frames either side of every move keep their watermark.
GAP_WINDOWS = 2


@dataclass(frozen=True)
class Placement:
    """A box the mark holds, and the frames it holds it for (end exclusive)."""

    start: int
    end: int
    box: tuple[int, int, int, int]

    @property
    def frames(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class Candidate:
    """Something mark-shaped in one window, and how strongly it stands out."""

    box: tuple[int, int, int, int]
    strength: float


def sample_indices(start: int, end: int, count: int) -> list[int]:
    """`count` frame indices spread evenly over [start, end), ends included."""
    span = end - start
    if span <= 0:
        return []
    if span <= count:
        return list(range(start, end))
    return [start + int(round(i * (span - 1) / (count - 1))) for i in range(count)]


def windows(total: int, size: int = SCAN_WINDOW_FRAMES) -> list[tuple[int, int]]:
    """
    The timeline cut into windows of `size`, with the last one absorbing the
    remainder rather than being a stub: a five-frame window has nothing to take
    a median over, and a placement boundary is only ever as precise as a window
    anyway.
    """
    if total <= 0:
        return []
    if total <= size:
        return [(0, total)]
    count = total // size
    bounds = [(i * size, (i + 1) * size) for i in range(count)]
    start, _ = bounds[-1]
    bounds[-1] = (start, total)
    return bounds


def _scale_for(width: int, height: int) -> float:
    """The factor the scan works at: 1.0, or enough to fit `SCAN_MAX_SIDE`."""
    longest = max(width, height)
    if longest <= SCAN_MAX_SIDE:
        return 1.0
    return SCAN_MAX_SIDE / longest


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if right <= left or bottom <= top:
        return 0.0
    overlap = (right - left) * (bottom - top)
    return overlap / float(aw * ah + bw * bh - overlap)


def _similar_size(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    _, _, aw, ah = a
    _, _, bw, bh = b
    return (abs(aw - bw) <= SIZE_TOLERANCE * max(aw, bw)
            and abs(ah - bh) <= SIZE_TOLERANCE * max(ah, bh))


def _union(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    left, top = min(ax, bx), min(ay, by)
    right, bottom = max(ax + aw, bx + bw), max(ay + ah, by + bh)
    return (left, top, right - left, bottom - top)


def clamp_box(box: tuple[int, int, int, int], width: int, height: int,
              pad: int = 0) -> tuple[int, int, int, int]:
    """`box` grown by `pad` and confined to the frame."""
    x, y, w, h = box
    left = max(0, x - pad)
    top = max(0, y - pad)
    right = min(width, x + w + pad)
    bottom = min(height, y + h + pad)
    return (left, top, max(1, right - left), max(1, bottom - top))


def _rescale(box: tuple[int, int, int, int], scale: float) -> tuple[int, int, int, int]:
    """A box measured in scan pixels, expressed in the video's own pixels."""
    if scale == 1.0:
        return box
    x, y, w, h = box
    left, top = int(np.floor(x / scale)), int(np.floor(y / scale))
    right, bottom = int(np.ceil((x + w) / scale)), int(np.ceil((y + h) / scale))
    return (left, top, right - left, bottom - top)


def _blobs_at(magnitude: np.ndarray, threshold: float) -> list[Candidate]:
    """
    Mark-shaped things in a persistence map cut at one threshold.

    The mask is dilated before components are taken so that the strokes of one
    logo join into one blob; the box is then trimmed back to the undilated
    pixels inside that component, so the dilation decides what is joined and
    not how big the answer comes out.
    """
    mask = cv2.dilate((magnitude > threshold).astype(np.uint8),
                      np.ones((3, 3), np.uint8), iterations=2)
    if not mask.any():
        return []

    joined = cv2.dilate(mask, np.ones((MERGE_RADIUS, MERGE_RADIUS), np.uint8),
                        iterations=1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, 8)

    height, width = mask.shape
    frame_area = float(height * width)
    found: list[Candidate] = []
    # Label 0 is the background.
    for label in range(1, count):
        x, y, w, h, _ = stats[label]
        inside = mask[y:y + h, x:x + w] & (labels[y:y + h, x:x + w] == label)
        area = int(inside.sum())
        if area < MIN_MARK_AREA or area > frame_area * MAX_MARK_FRACTION:
            continue
        if w > MAX_MARK_SIDE_FRACTION * width or h > MAX_MARK_SIDE_FRACTION * height:
            continue
        rows = np.flatnonzero(inside.any(axis=1))
        cols = np.flatnonzero(inside.any(axis=0))
        box = (int(x) + int(cols[0]), int(y) + int(rows[0]),
               int(cols[-1] - cols[0]) + 1, int(rows[-1] - rows[0]) + 1)
        bx, by, bw, bh = box
        found.append(Candidate(box, float(magnitude[by:by + bh, bx:bx + bw].mean())))

    return found


def candidates(magnitude: np.ndarray) -> list[Candidate]:
    """
    Every mark-shaped thing in one window's map, over all the cuts, strongest
    first and with near-duplicates from neighbouring percentiles collapsed.
    """
    found: list[Candidate] = []
    for percentile in SCAN_PERCENTILES:
        threshold = max(MIN_THRESHOLD, float(np.percentile(magnitude, percentile)))
        found.extend(_blobs_at(magnitude, threshold))

    # Near-duplicates are merged into their union, not resolved in favour of
    # the strongest. A higher cut finds the same mark with its rim shaved off,
    # and it is the rim — the soft edge the eye does not place — that a box has
    # to include: keeping the tighter of the two is how a solve ends up leaving
    # an outline exactly where the user was looking.
    found.sort(key=lambda candidate: candidate.strength, reverse=True)
    unique: list[Candidate] = []
    for candidate in found:
        for index, kept in enumerate(unique):
            if _iou(candidate.box, kept.box) >= DEDUPE_IOU:
                unique[index] = Candidate(_union(kept.box, candidate.box),
                                          max(kept.strength, candidate.strength))
                break
        else:
            unique.append(candidate)
    return unique


def _window_magnitude(read, start: int, end: int, scale: float) -> np.ndarray | None:
    """How persistent each pixel of one window is, at the scan's scale."""
    frames = []
    for index in sample_indices(start, end, SCAN_WINDOW_SAMPLES):
        frame = read(index)
        if frame is None:
            continue
        if scale != 1.0:
            frame = cv2.resize(frame, None, fx=scale, fy=scale,
                               interpolation=cv2.INTER_AREA)
        frames.append(frame)
    # Fewer than this and the median across frames is not a median of anything:
    # a picture that merely happens to hold still reads as a mark.
    if len(frames) < 4:
        return None
    return np.abs(dewatermark.persistence(np.stack(frames)))


def close_gaps(placements: list[Placement], total: int,
               window: int = SCAN_WINDOW_FRAMES) -> list[Placement]:
    """
    Give the frames between two placements to their neighbours, where the gap
    is short enough to be the scan blinking rather than the mark leaving.

    A window that straddles a move sees the mark in two places and may match
    neither, so a move can leave a hole of about one window. Those are exactly
    the frames the user would see the watermark in, and they are the frames a
    literal reading of the scan skips.
    """
    if not placements:
        return []

    reach = GAP_WINDOWS * window
    closed = list(placements)

    if closed[0].start <= reach:
        closed[0] = dataclasses.replace(closed[0], start=0)
    if total - closed[-1].end <= reach:
        closed[-1] = dataclasses.replace(closed[-1], end=total)

    for i in range(len(closed) - 1):
        gap = closed[i + 1].start - closed[i].end
        if 0 < gap <= reach:
            midpoint = closed[i].end + gap // 2
            closed[i] = dataclasses.replace(closed[i], end=midpoint)
            closed[i + 1] = dataclasses.replace(closed[i + 1], start=midpoint)
    return closed


def _cluster(seen: list[tuple[tuple[int, int], Candidate]],
             window_count: int) -> list[Placement]:
    """
    Turn per-window detections into placements: detections in the same place
    belong to the same one, and a place that only ever showed up once was a
    scene, not a mark.
    """
    # Membership is judged against the box the cluster started with, never
    # against a running union of them. A union drifts: each new member widens
    # what the next one is compared to, and a chain of slight overlaps ends up
    # a box nothing in it would have matched.
    clusters: list[dict] = []
    for span, candidate in seen:
        for cluster in clusters:
            if _iou(cluster['seed'], candidate.box) >= SAME_PLACE_IOU:
                cluster['members'].append((span, candidate.box))
                break
        else:
            clusters.append({'seed': candidate.box, 'members': [(span, candidate.box)]})

    minimum = min(MIN_PLACEMENT_WINDOWS, window_count)
    placements: list[Placement] = []
    for cluster in clusters:
        by_span: dict[tuple[int, int], tuple[int, int, int, int]] = {}
        for span, box in cluster['members']:
            by_span[span] = _union(by_span[span], box) if span in by_span else box
        if len(by_span) < minimum:
            continue

        # Consecutive windows are one placement; a gap means the mark was away
        # and came back, which close_gaps decides what to do about. Each run
        # takes the union of only its own windows.
        spans = sorted(by_span)
        run = [spans[0]]
        for span in spans[1:]:
            if span[0] == run[-1][1]:
                run.append(span)
                continue
            placements.append(_run_placement(run, by_span))
            run = [span]
        placements.append(_run_placement(run, by_span))

    placements.sort(key=lambda placement: placement.start)
    return placements


def _run_placement(run: list[tuple[int, int]], boxes: dict) -> Placement:
    box = boxes[run[0]]
    for span in run[1:]:
        box = _union(box, boxes[span])
    return Placement(run[0][0], run[-1][1], box)


def scan(read, total: int, roi: tuple[int, int, int, int],
         width: int, height: int) -> list[Placement]:
    """
    Where the mark under `roi` sits, over the whole sequence.

    `read(index)` returns frame `index` as a full-size BGR array, or None where
    it cannot be read. `roi` is the user's box: a hint about which of the things
    that hold still is the one they want gone, not a limit on where the answer
    may lie — the mark is followed wherever it moves to.

    Returns placements in frame order, possibly overlapping in time where the
    mark is in two places at once during a move, or an empty list where nothing
    mark-shaped was found under the box. The caller decides what to do with
    that; this function does not invent a placement it did not find.

    The gaps between them are left open here. Closing one means deciding which
    neighbour the frames in it belong to, and that decision is only sound once
    the proposals that turn out to hold no mark have been dropped — see
    `locate`, which does both in that order.
    """
    if total <= 0:
        return []

    scale = _scale_for(width, height)
    scan_roi = (int(roi[0] * scale), int(roi[1] * scale),
                max(1, int(roi[2] * scale)), max(1, int(roi[3] * scale)))

    seen: list[tuple[tuple[int, int], list[Candidate]]] = []
    for start, end in windows(total):
        magnitude = _window_magnitude(read, start, end, scale)
        if magnitude is None:
            continue
        seen.append(((start, end), candidates(magnitude)))

    # The seed is whichever detection the user's box agrees with most. Overlap
    # rather than containment: the box they drew is around what they can see,
    # and the detection reaches further than that by design.
    seed = None
    best_overlap = 0.0
    for _, found in seen:
        for candidate in found:
            overlap = _iou(candidate.box, scan_roi)
            if overlap > best_overlap:
                best_overlap = overlap
                seed = candidate
    if seed is None:
        return []

    # Every detection the right size, not just the strongest: the window a move
    # happens in holds the mark in both places at once, and keeping only one of
    # them leaves the other's frames with their watermark on. That is a whole
    # second of visible mark at every move, and it is what an earlier version of
    # this line did. What keeps the extra candidates honest is the clustering
    # below, which throws away any place the mark was not seen in twice.
    matched: list[tuple[tuple[int, int], Candidate]] = []
    for span, found in seen:
        for candidate in found:
            # Either the size or the place. Size is what survives a move and is
            # the only evidence there; but how much of the mark's rim a window
            # picks up varies with what is behind it, and where the user
            # pointed, a detection that sits on the seed is the same mark
            # whatever its measured height came out as. Requiring size alone
            # dropped the seed's own mark in two windows out of three.
            if (_similar_size(candidate.box, seed.box)
                    or _iou(candidate.box, seed.box) >= SAME_PLACE_IOU):
                matched.append((span, candidate))

    return [
        dataclasses.replace(
            placement,
            box=clamp_box(_rescale(placement.box, scale), width, height,
                          pad=max(1, int(round(BOX_PAD / scale)))),
        )
        for placement in _cluster(matched, len(seen))
    ]


def fit_placement(read, placement: Placement,
                  samples: int = FIT_SAMPLES) -> dewatermark.WatermarkModel:
    """
    Solve the mark for one placement.

    The frames are cropped to the placement as they are read rather than after:
    the solve only ever looks inside the box, and holding two dozen 4K frames
    in memory to use a few thousand pixels of each of them is the difference
    between a job that runs and one that is killed for it.
    """
    x, y, w, h = placement.box
    crops = []
    for index in sample_indices(placement.start, placement.end, samples):
        frame = read(index)
        if frame is not None:
            crops.append(frame[y:y + h, x:x + w])
    if not crops:
        raise IOError(f"No frames could be read for placement {placement}")
    model = dewatermark.fit(np.stack(crops), (0, 0, w, h))
    return dataclasses.replace(model, roi=placement.box)


def schedule(placements: list[Placement], models: list, total: int) -> list[tuple[int, int, tuple]]:
    """
    Runs of consecutive frames that need the same set of models, as
    (start, end, models).

    Placements can overlap in time, and two workers repainting the same frame
    file at the same time would race. Grouping by which models a frame needs
    makes that impossible rather than unlikely: every frame appears in exactly
    one run, and a run carries all of its work.
    """
    if not placements:
        return []

    boundaries = sorted({0, total}
                        | {p.start for p in placements}
                        | {p.end for p in placements})
    runs: list[tuple[int, int, tuple]] = []
    for start, end in zip(boundaries, boundaries[1:]):
        if start >= end:
            continue
        needed = tuple(model for placement, model in zip(placements, models)
                       if placement.start <= start and placement.end >= end)
        if needed:
            runs.append((start, end, needed))
    return runs


def believable(model: dewatermark.WatermarkModel) -> bool:
    """
    Whether a solved placement is a mark at all.

    The scan finds things that hold still, which a watermark is and a locked-off
    shot of a wall also is. Only the solve can tell them apart, because only the
    solve asks the question that distinguishes them: is there an opacity and a
    colour that explain this region as something composited *over* the picture?
    Where there is not, the fit comes back with almost no coverage and a peak
    opacity of nothing — it has been asked to find a mark in a picture, and has
    correctly failed.

    Dropping a placement is always safe: those frames are written out as they
    were decoded. Keeping a false one is not — it would run the divide over
    pixels that are the picture.
    """
    return model.coverage >= MIN_MODEL_COVERAGE


def locate(read, total: int, roi: tuple[int, int, int, int],
           width: int, height: int, on_progress=None) -> list[tuple[Placement, object]]:
    """
    Where the mark is and what it is, ready to be undone.

    The scan and the solve are two halves of one answer and neither is usable
    alone, so they are composed here rather than at the call site. The scan
    proposes — it can only see that something holds still, and on textured
    footage it will propose things that merely do — and the solve disposes,
    because it is the only step that can ask whether a region is composited
    over the picture or part of it.

    `on_progress(done, total)` is called as each placement is solved, which is
    the slow half. Returns the placements that survived, with their models, in
    frame order; an empty list means there was nothing here to remove, which is
    a real answer and not a failure.
    """
    found = scan(read, total, roi, width, height)
    solved: list[tuple[Placement, object]] = []
    for done, placement in enumerate(found, start=1):
        model = fit_placement(read, placement)
        if believable(model):
            solved.append((placement, model))
        if on_progress:
            on_progress(done, len(found))
    if not solved:
        return []

    # Only now are the gaps worth closing. A proposal that held no mark still
    # sits in the timeline until the solve has looked at it, and closing around
    # one hands it frames that belong to the real mark either side of it — a
    # hole in the middle of a mark that never moved.
    placements = close_gaps([placement for placement, _ in solved], total)
    return list(zip(placements, [model for _, model in solved]))
