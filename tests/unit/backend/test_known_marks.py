"""
Recognising 抖音's mark rather than inferring one.

The separation these rest on was measured on real footage — three rooms shot
on a stand, posted to 抖音 and downloaded back, against the same three rooms
clean, plus 快手 and the 抖音 sample. Scores over twelve frames each:

    clean 3213/3214/3215   0.271 – 0.380      0 of 36 over the threshold
    快手                   0.379 – 0.431      0 of 12
    抖音 sample            0.416 – 0.852     10 of 12  (two frames mid-swap)
    3213/3214/3215 + 抖音  0.837 – 0.932     36 of 36

Those clips cannot live in the repository, so what is pinned here instead is
the contract that produced those numbers: the mark composited the way a
platform composites it, over backgrounds chosen to be hostile, and the same
backgrounds without it.
"""
import numpy as np
import pytest

import known_marks


@pytest.fixture(scope='module')
def template():
    return known_marks.load_template('douyin')


def busy_background(width: int, height: int, seed: int = 0) -> np.ndarray:
    """
    A frame with as much edge energy as an ordinary room.

    Flat noise would be a soft test: what the matcher has to survive is
    scenery full of straight bright edges — window frames, door frames, the
    printed boxes that produced every false positive this project has had.
    """
    rng = np.random.default_rng(seed)
    frame = rng.integers(40, 90, (height, width, 3), dtype=np.uint8)
    for i in range(6):
        x = int(width * (i + 1) / 8)
        frame[:, x:x + 3] = 230
        y = int(height * (i + 1) / 8)
        frame[y:y + 3, :] = 215
    return frame


def composite(frame: np.ndarray, template: np.ndarray, x: int, y: int,
              scale: float = 1.0) -> np.ndarray:
    """Draw the mark the way a platform draws it: white, alpha-blended."""
    import cv2
    alpha = cv2.resize(template, None, fx=scale, fy=scale,
                       interpolation=cv2.INTER_AREA)
    rows, cols = alpha.shape
    patch = frame[y:y + rows, x:x + cols].astype(np.float32)
    a = alpha[..., None]
    frame = frame.copy()
    frame[y:y + rows, x:x + cols] = (patch * (1 - a) + 255.0 * a).astype(np.uint8)
    return frame


def test_the_template_is_the_marks_alpha(template):
    assert template.dtype == np.float32
    assert 0.0 <= template.min() and template.max() <= 1.0
    # Mostly transparent: it is a logo and a word, not a block.
    assert 0.1 < (template > 0.25).mean() < 0.6


def test_an_unknown_mark_has_no_template():
    with pytest.raises(FileNotFoundError):
        known_marks.load_template('no-such-platform')


def test_it_finds_the_mark_where_it_was_drawn(template):
    frame = composite(busy_background(1080, 1920), template, 30, 30)
    score, (x, y, w, h) = known_marks.find(frame, template)
    assert score >= known_marks.MATCH_THRESHOLD
    # Within a couple of pixels: the gradient is blurred before matching, so
    # the peak can sit a pixel either side of the truth.
    assert abs(x - 30) <= 3 and abs(y - 30) <= 3


def test_it_stays_quiet_on_the_same_frame_without_the_mark(template):
    """The false positive is the one that costs the user their own picture."""
    score, _ = known_marks.find(busy_background(1080, 1920), template)
    assert score < known_marks.MATCH_THRESHOLD


@pytest.mark.parametrize('width, height', [(1080, 1920), (720, 1280), (320, 568)])
def test_it_holds_across_the_sizes_a_phone_produces(template, width, height):
    """
    The template was cut from a 1080-wide clip and is scaled by the frame.

    Measured on real footage at both 1080 and 320 wide, which is the range a
    reposted phone video actually arrives in.
    """
    scale = width / known_marks.TEMPLATE_WIDTH_AT
    frame = composite(busy_background(width, height, seed=width), template,
                      int(width * 0.03), int(height * 0.02), scale)
    score, _ = known_marks.find(frame, template)
    assert score >= known_marks.MATCH_THRESHOLD


def test_it_finds_the_mark_in_either_corner(template):
    """抖音 alternates between two corners, and both have to be found."""
    rows, cols = template.shape
    frame = composite(busy_background(1080, 1920, seed=7), template,
                      1080 - cols - 40, 1920 - rows - 40)
    score, (x, y, _, _) = known_marks.find(frame, template)
    assert score >= known_marks.MATCH_THRESHOLD
    assert x > 540 and y > 960


def test_a_frame_too_small_to_hold_the_mark_is_not_guessed_at(template):
    assert known_marks.find(np.zeros((8, 8, 3), np.uint8), template) is None


def test_a_flat_frame_scores_nothing(template):
    """No edges anywhere is not a reason to match a shape made of edges."""
    score, _ = known_marks.find(np.full((1920, 1080, 3), 128, np.uint8), template)
    assert score < known_marks.MATCH_THRESHOLD


# ─── deciding which finding is the recognised mark ───────────────────────────
#
# The numbers are from the measured clip: 抖音's logo matched at
# (13, 15, 120, 48), and the survey's own regions around it were
# (13, 11, 132, 88) — the mark — plus a (92, 39, 30, 21) fragment and a
# (0, 59, 296, 341) piece of room that merely overlapped.

MATCH = (13, 15, 120, 48)


def test_the_finding_that_contains_the_mark_is_the_mark():
    assert known_marks.covers((13, 11, 132, 88), [MATCH])


def test_a_fragment_of_the_mark_is_not_the_mark():
    """It sits wholly inside the match but covers almost none of it."""
    assert not known_marks.covers((92, 39, 30, 21), [MATCH])


def test_a_room_sized_region_cannot_claim_the_mark_by_overlapping_it():
    assert not known_marks.covers((0, 59, 296, 341), [MATCH])


def test_a_region_that_merely_swallows_the_mark_is_rejected_on_size():
    """Containing all of it is not enough if it has swallowed the picture."""
    big = (0, 0, int((MATCH[2] * MATCH[3] * known_marks.AREA_LIMIT) ** 0.5) + 60,
           int((MATCH[2] * MATCH[3] * known_marks.AREA_LIMIT) ** 0.5) + 60)
    assert not known_marks.covers(big, [MATCH])


def test_nothing_is_the_mark_when_nothing_was_recognised():
    assert not known_marks.covers((13, 11, 132, 88), [])


def test_the_direction_of_the_test_is_coverage_of_the_match():
    """
    The bug this pins: asking how much of the *finding* sits inside the match
    scored the real 抖音 region at 49.6% and missed it. The template is
    deliberately smaller than the mark, so the finding is normally larger.
    """
    finding = (13, 11, 132, 88)
    fx, fy, fw, fh = finding
    mx, my, mw, mh = MATCH
    wide = min(fx + fw, mx + mw) - max(fx, mx)
    tall = min(fy + fh, my + mh) - max(fy, my)
    assert wide * tall == mw * mh                 # all of the match is inside
    assert wide * tall / (fw * fh) < 0.5          # but less than half the finding
    assert known_marks.covers(finding, [MATCH])


# ─── gathering sightings into placements ─────────────────────────────────────

def test_sightings_of_one_mark_become_one_placement():
    """Hits drift a pixel or two between frames; that is the same mark."""
    hits = [((14, 15, 120, 48), 0), ((15, 15, 120, 48), 12), ((16, 15, 120, 48), 24)]
    placed = known_marks.placements(hits, 173, 12)
    assert len(placed) == 1
    (box, start, end), = placed
    assert box[:2] == (14, 15)
    assert (start, end) == (0, 36)          # padded by one stride each way


def test_the_two_corners_抖音_uses_stay_apart():
    hits = [((14, 15, 120, 48), 0), ((407, 869, 120, 48), 96)]
    assert len(known_marks.placements(hits, 173, 12)) == 2


def test_a_span_is_padded_but_never_past_the_video():
    hits = [((14, 15, 120, 48), 2), ((14, 15, 120, 48), 170)]
    (_, start, end), = known_marks.placements(hits, 173, 12)
    assert start == 0 and end == 173


def test_nothing_seen_is_nothing_placed():
    assert known_marks.placements([], 173, 12) == []
