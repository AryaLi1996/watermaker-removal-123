"""
Recognising a platform's mark instead of inferring one.

Everything else in this project finds marks by *behaviour*: the thing that
holds still while the picture moves. That premise fails completely on a
locked-off shot, where the scenery holds still too — measured on five clips
now, the survey calls between a fifth and two thirds of an ordinary room a
watermark, and `survey.crowded` has to decline the lot. Six attempts to tell
the two apart from the solve's own output have been measured and rejected
(see `survey.PROPOSAL_AREA_LIMIT` for the table).

This module does something different and much narrower: 抖音's mark is a
*known, fixed* graphic, so it can be recognised rather than deduced. That
makes no assumption about motion, which is exactly the assumption that breaks.

The template is the mark's alpha, recovered from real footage rather than
drawn: the same clip was shot on a stand, posted to 抖音 and downloaded back,
and with the clean version as the background `I = (1-a)B + aW` inverts
directly to `a = (I - B) / (W - B)` per pixel, no solving required. Only the
logo and wordmark are kept — the account number underneath varies per user.

Matching is on gradient magnitude, not pixels. The mark is alpha-blended, so
its colours are whatever is underneath; what survives the blend is a sharp,
bright edge in a fixed shape.
"""
from __future__ import annotations

import os

import cv2
import numpy as np

MARKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'marks')

# The template was cut from a 1080-wide video, so it is scaled by the frame's
# width against this before matching.
TEMPLATE_WIDTH_AT = 1080.0

# Sizes to try, as a multiple of the frame-relative size. A platform does not
# draw its mark at one exact fraction across every aspect ratio and every app
# version, and the cost of a few extra correlations is small — a detect looks
# at a dozen frames, not all of them.
#
# The range is measured, not guessed. Narrowing it to (0.85, 1.0, 1.18) costs
# real detections: on a 快手 clip downloaded from a different account at a
# different resolution the mark scored 0.642 with three steps and 0.886 with
# these six, while the highest score on footage carrying no 快手 mark stayed
# at 0.472 either way. Widening bought true positives and no false ones.
SCALES = (0.70, 0.85, 1.0, 1.18, 1.32, 1.45)

# Above this, the shape found is the mark. Chosen from measured separation
# rather than taste: across eight clips the highest score anywhere in footage
# without the mark was 0.431 (快手), and the lowest score on footage carrying
# it was 0.837. The midpoint of a gap that wide is not a fine judgement, and
# 0.60 keeps twice as much room on the false-positive side, which is the side
# that costs the user their own picture.
MATCH_THRESHOLD = 0.60

# The bar for a second sighting of a mark this video has *already* shown at
# full confidence. A platform draws one mark and moves it about — 抖音 swaps
# corners, 小红书 swaps the whole overlay between top and bottom — and the
# same badge scores differently depending on what is behind it: 小红书's pill
# reads 0.98 over a pale wall and 0.56 over dark wood, because a white badge's
# border is a strong edge against one and a weak one against the other.
#
# Once `MATCH_THRESHOLD` has established which platform this is, a weaker
# sighting of the same template is a different proposition from a first
# sighting, and holding it to the same bar loses half the video. This still
# clears the highest score measured on footage carrying no mark at all, 0.423
# across nine clips, so it is a lower bar and not an open door.
CONFIRMED_THRESHOLD = 0.50

# A frame this small cannot carry a legible mark, and the template scaled down
# to fit would be matching noise.
MIN_TEMPLATE_SIDE = 12

# The least edge energy a region must have before a match there means
# anything. `TM_CCOEFF_NORMED` divides by the window's standard deviation, and
# on a window with none — a black TV screen, a blown-out sky — OpenCV returns
# a perfect 1.0 rather than an error. Left unguarded that is a false positive
# with the highest possible score, which is precisely the wrong way round: a
# mark is made of edges, so a region without any cannot be one. Measured on a
# 抖音 clip whose television is off, where the unguarded matcher scored 1.0000
# on a patch with a standard deviation of exactly 0.
MIN_EDGE_ENERGY = 1.0


def _gradient(image: np.ndarray) -> np.ndarray:
    """
    The part of a blended mark that survives being blended.

    A mark is drawn over whatever is underneath, so its pixel values are not
    its own; the edges it introduces are. Blurring first because the template
    came off one encode and the frame is another, and single-pixel differences
    between the two are nothing to do with whether the shape is present.
    """
    blurred = cv2.GaussianBlur(image.astype(np.float32), (0, 0), 1.0)
    return cv2.magnitude(
        cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3),
    )


def load_template(name: str) -> np.ndarray:
    """A mark's alpha as float32 in [0, 1]. Raises if the asset is missing."""
    path = os.path.join(MARKS_DIR, f'{name}.png')
    image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(f'No template for {name!r} at {path}')
    return image.astype(np.float32) / 255.0


def find(frame: np.ndarray, template: np.ndarray) -> tuple[float, tuple[int, int, int, int]] | None:
    """
    Where this mark is in this frame, and how sure.

    Returns `(score, box)` for the best placement at any of `SCALES`, or None
    when the frame is too small to hold the template at all. The score is a
    normalised correlation, so it is comparable between frames and sizes; the
    caller decides what is good enough, because a survey that lists everything
    and an export that removes things do not want the same bar.
    """
    if frame.ndim == 3:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = frame.shape[:2]
    field = _gradient(frame)

    best: tuple[float, tuple[int, int, int, int]] | None = None
    for relative in SCALES:
        scale = (width / TEMPLATE_WIDTH_AT) * relative
        # Decide the size before asking for it: `cv2.resize` raises on a
        # target that rounds away to nothing, so on a thumbnail-sized frame
        # the smallest scale would throw rather than be skipped.
        rows = int(round(template.shape[0] * scale))
        cols = int(round(template.shape[1] * scale))
        if min(rows, cols) < MIN_TEMPLATE_SIDE or rows >= height or cols >= width:
            continue
        sized = cv2.resize(template, (cols, rows), interpolation=cv2.INTER_AREA)
        response = cv2.matchTemplate(
            field, _gradient(sized * 255.0), cv2.TM_CCOEFF_NORMED)
        response[_featureless(field, rows, cols)] = -1.0
        _, score, _, corner = cv2.minMaxLoc(response)
        if best is None or score > best[0]:
            best = (float(score), (int(corner[0]), int(corner[1]), cols, rows))
    return best


def _featureless(field: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """
    Where a window of this size holds too little structure to match against.

    The shape returned lines up with `matchTemplate`'s response, one entry per
    candidate top-left corner. Standard deviation over each window, by the
    usual two box filters, so the whole map costs one pass rather than one per
    position.
    """
    ksize = (cols, rows)
    mean = cv2.boxFilter(field, cv2.CV_32F, ksize, normalize=True,
                         anchor=(0, 0), borderType=cv2.BORDER_ISOLATED)
    mean_square = cv2.boxFilter(field * field, cv2.CV_32F, ksize, normalize=True,
                                anchor=(0, 0), borderType=cv2.BORDER_ISOLATED)
    variance = mean_square - mean * mean
    valid = variance[:field.shape[0] - rows + 1, :field.shape[1] - cols + 1]
    return valid < MIN_EDGE_ENERGY ** 2


# Every platform whose mark ships as a template. Each was recovered the same
# way, from a clip posted to that platform and downloaded back beside the take
# it was made from; the ones still missing wait on the same paired footage.
#
# Only the fixed part of each is kept. Both platforms draw a logo and wordmark
# over a line naming the account, and the account is different for every user.
# How much of a recognised mark a finding has to contain to be that mark, and
# how much bigger than the mark that finding may be. Both from measurement:
# see `covers`.
COVERAGE = 0.6
AREA_LIMIT = 12.0

KNOWN = ('douyin', 'kuaishou', 'xiaohongshu')


def locate_in(frame_paths: list[str], width: int, height: int,
              samples: int) -> list[tuple[tuple[int, int, int, int], int]]:
    """
    Every known mark found across a spread of these frames, with when.

    Returns `(box, index)` pairs, the index being into `frame_paths`, so a
    caller can tell a mark that is on screen throughout from one that comes
    and goes. 抖音's alternates between two corners every ten seconds or so,
    and removing it for only half the video would leave the other half marked.

    Sampled rather than exhaustive: a platform mark is on the video for most
    of its length or not at all, so a dozen frames settle which corners it
    uses. Boxes come back in the coordinates of the frames handed in, which
    are the survey's scaled ones.

    Failures are silent by design: a template that cannot be read or a frame
    that cannot be decoded means no recognition, which leaves the survey
    exactly as it was before this existed.
    """
    if not frame_paths or samples <= 0:
        return []
    try:
        templates = [load_template(name) for name in KNOWN]
    except (FileNotFoundError, OSError):
        return []

    step = max(1, len(frame_paths) // samples)
    # Every sighting worth a second look, before deciding which platform this
    # video belongs to. A mark is scored twice: once to establish the platform
    # and once, at a lower bar, for the placements it also appears in.
    seen: list[tuple[str, float, tuple[int, int, int, int], int]] = []
    for index in range(0, len(frame_paths), step)[:samples]:
        frame = cv2.imread(frame_paths[index], cv2.IMREAD_GRAYSCALE)
        if frame is None:
            continue
        for name, template in zip(KNOWN, templates):
            hit = find(frame, template)
            if hit and hit[0] >= CONFIRMED_THRESHOLD:
                seen.append((name, hit[0], hit[1], index))

    return confirmed(seen)


def confirmed(seen: list[tuple[str, float, tuple[int, int, int, int], int]]
              ) -> list[tuple[tuple[int, int, int, int], int]]:
    """
    Which sightings to keep, given every one worth a second look.

    A sighting between the two bars counts only if some sighting of the *same*
    template cleared the upper one somewhere in the video. Establishing the
    platform and finding its other placements are different questions, and the
    evidence needed differs: the first has to rule out every other video in
    the world, the second only has to rule out coincidence in a video already
    known to carry that platform's mark.

    Separate from `locate_in` because it is the whole of the rule and none of
    the decoding, and a rule this consequential should be readable and
    testable without a video to hand.
    """
    established = {name for name, score, _, _ in seen if score >= MATCH_THRESHOLD}
    return [(box, index) for name, _, box, index in seen if name in established]


def placements(hits: list[tuple[tuple[int, int, int, int], int]],
               total: int, step: int) -> list[tuple[tuple[int, int, int, int], int, int]]:
    """
    The same mark seen in the same place, gathered into `(box, start, end)`.

    Hits drift by a pixel or two between frames, so they are grouped by
    overlap rather than by equality, and the group's box is the union — the
    mark does not move within a corner, so a union is still the mark.

    The span is padded by one sampling step at each end because only every
    `step`th frame was looked at: a mark first seen at frame 40 with a stride
    of 12 was probably already there at 29, and cutting it short would leave
    the first second of it in the video.
    """
    groups: list[list[tuple[tuple[int, int, int, int], int]]] = []
    for box, index in hits:
        for group in groups:
            if _touches(box, group[0][0]):
                group.append((box, index))
                break
        else:
            groups.append([(box, index)])

    out = []
    for group in groups:
        xs = [b[0] for b, _ in group]
        ys = [b[1] for b, _ in group]
        rights = [b[0] + b[2] for b, _ in group]
        bottoms = [b[1] + b[3] for b, _ in group]
        seen = [i for _, i in group]
        box = (min(xs), min(ys), max(rights) - min(xs), max(bottoms) - min(ys))
        out.append((box, max(0, min(seen) - step), min(total, max(seen) + step)))
    return out


def _touches(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    """Whether two sightings are of a mark in the same place."""
    wide = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    tall = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    return wide * tall * 2 >= min(a[2] * a[3], b[2] * b[3])


def covers(box: tuple[int, int, int, int],
           recognised: list[tuple[int, int, int, int]]) -> bool:
    """
    Whether this finding is one of the marks that were recognised.

    The test is how much of the *match* the finding contains, not the other
    way round, and that direction was a real bug before it was measured. The
    template is deliberately smaller than the mark it identifies — it is the
    logo and wordmark, without the account number underneath, because the
    number varies per user — so the survey's box is normally the larger of
    the two. Asking how much of the finding sits inside the match scored the
    real 抖音 region at 49.6% and missed it by a fraction.

    `AREA_LIMIT` stops a region that has swallowed half the picture from
    claiming the mark by containing it. On the measured clip the two mark
    regions come to 2.0 and 2.6 times the match, and the room-sized finding
    that also overlapped covered 8.3% of it and is excluded twice over.
    """
    bx, by, bw, bh = box
    for mx, my, mw, mh in recognised:
        wide = max(0, min(bx + bw, mx + mw) - max(bx, mx))
        tall = max(0, min(by + bh, my + mh) - max(by, my))
        inside = wide * tall
        if (inside >= COVERAGE * mw * mh
                and bw * bh <= AREA_LIMIT * mw * mh):
            return True
    return False
