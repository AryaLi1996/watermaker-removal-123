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


# ─── the degenerate match ────────────────────────────────────────────────────

def test_a_featureless_region_cannot_score_a_perfect_match(template):
    """
    `TM_CCOEFF_NORMED` divides by the window's standard deviation, and on a
    window with none OpenCV returns 1.0 rather than an error. Unguarded, a
    black television scored a perfect match on a real clip — a false positive
    with the highest score the scale allows, which is the wrong way round.
    """
    frame = busy_background(1080, 1920, seed=3)
    frame[600:1400, 100:900] = 0          # a screen that is off
    score, _ = known_marks.find(frame, template)
    assert score < known_marks.MATCH_THRESHOLD
    # Not merely under the bar: the unguarded failure was a *perfect* score,
    # so anything near 1.0 means the guard has stopped working. The peak may
    # still sit at the dead region's edge, where there is structure to match
    # and nothing wrong with looking.
    assert score < 0.5


def test_a_mark_over_a_dark_region_is_still_found(template):
    """The guard rejects absence of structure, not darkness."""
    frame = busy_background(1080, 1920, seed=4)
    frame[0:600, 0:700] = 6
    frame = composite(frame, template, 30, 30)
    score, _ = known_marks.find(frame, template)
    assert score >= known_marks.MATCH_THRESHOLD


# ─── more than one platform ──────────────────────────────────────────────────

def test_every_known_platform_has_a_template():
    for name in known_marks.KNOWN:
        assert known_marks.load_template(name).size > 0


@pytest.mark.parametrize('drawn', known_marks.KNOWN)
def test_a_platforms_mark_is_not_matched_by_another_platforms_template(drawn):
    """
    Measured across eleven clips: each template fires on its own platform and
    on no other, 抖音 and 快手 alike. Pinned here because the failure would be
    silent — the wrong logo removed from the right corner.
    """
    frame = composite(busy_background(1080, 1920, seed=11),
                      known_marks.load_template(drawn), 30, 30)
    for name in known_marks.KNOWN:
        score, _ = known_marks.find(frame, known_marks.load_template(name))
        if name == drawn:
            assert score >= known_marks.MATCH_THRESHOLD
        else:
            assert score < known_marks.MATCH_THRESHOLD, f'{name} matched {drawn}'


# ─── the whole mark, not just the part the template matches ──────────────────
#
# 抖音 draws its logo and the uploader's account number together, and the
# template matches only the logo. The numbers below are the drawn marks'
# measured spans from three matched pairs — the same rooms shot on a stand,
# posted and downloaded back — thresholded at 60 levels against the clean take,
# which is what separates what 抖音 drew from the translucent band it lays over
# the top and bottom of the frame.

MEASURED = [
    # (what the template matched, what 抖音 actually drew)
    ('A top-left',     (26, 22, 264, 176),   (36, 31, 571, 173)),
    ('A bottom-right', (742, 1730, 312, 190), (506, 1741, 1041, 1884)),
    ('B bottom-right', (742, 1730, 310, 162), (506, 1741, 1042, 1882)),
    ('C bottom-right', (740, 1732, 310, 158), (506, 1742, 1041, 1883)),
]


@pytest.mark.parametrize('name, matched, drawn', MEASURED,
                         ids=[m[0] for m in MEASURED])
def test_the_unit_covers_what_the_platform_actually_drew(name, matched, drawn):
    """
    The one assertion that matters: the account line ends up inside the box.

    Before this, the proposed box held 61% of 抖音's drawn marks on the
    top-left placement and the rest stayed on the exported video.
    """
    x, y, w, h = known_marks.unit_box('douyin', matched, 1080, 1920)
    dx0, dy0, dx1, dy1 = drawn
    assert x <= dx0 and y <= dy0, f'unit starts inside the mark: {(x, y)} vs {(dx0, dy0)}'
    assert x + w >= dx1 and y + h >= dy1, (
        f'unit ends inside the mark: {(x + w, y + h)} vs {(dx1, dy1)}')


def test_a_corner_mark_grows_inward_not_off_the_frame():
    """
    Which edge stays put is the whole of the geometry.

    抖音's account line runs to the right of a top-left logo and to the left of
    a bottom-right one. Anchoring on the wrong side grows the box off the frame
    and leaves the line on the video — which is what a width-only extension
    did when it was tried: on one clip it reached into a door frame instead of
    the text, and made that strip worse than leaving it alone.
    """
    left = known_marks.unit_box('douyin', (26, 22, 264, 176), 1080, 1920)
    assert left[0] == 26, 'a left-hand mark should keep its left edge'
    assert left[1] == 22, 'a top mark should keep its top edge'

    right = known_marks.unit_box('douyin', (742, 1730, 312, 190), 1080, 1920)
    assert right[0] + right[2] == 742 + 312, 'a right-hand mark should keep its right edge'
    assert right[1] + right[3] == 1730 + 190, 'a bottom mark should keep its bottom edge'


def test_the_unit_is_taller_and_wider_than_the_logo_alone():
    matched = (26, 22, 264, 176)
    x, y, w, h = known_marks.unit_box('douyin', matched, 1080, 1920)
    assert w > matched[2] and h >= matched[3]
    # And still a small part of the frame: this is a box the solve searches,
    # and one that swallowed the picture would be a different kind of wrong.
    assert w * h / (1080 * 1920) < 0.10


def test_a_platform_with_no_measured_unit_is_left_exactly_as_it_was():
    """
    Three of the four known platforms have no matched pairs behind them. A
    number nobody measured is worse than no number: it would widen every
    export's removal on a guess.
    """
    box = (26, 22, 264, 176)
    for name in known_marks.KNOWN:
        if name in known_marks.MARK_UNITS:
            continue
        assert known_marks.unit_box(name, box, 1080, 1920) == box


def test_the_unit_scales_with_the_frame():
    """The mark is drawn as a fraction of the video's width, so a 540-wide
    copy of the same video carries a half-size mark."""
    full = known_marks.unit_box('douyin', (26, 22, 264, 176), 1080, 1920)
    half = known_marks.unit_box('douyin', (13, 11, 132, 88), 540, 960)
    assert abs(half[2] * 2 - full[2]) <= 2
    assert abs(half[3] * 2 - full[3]) <= 2


def test_a_tiny_frame_gets_a_tiny_unit_rather_than_a_refusal():
    """
    The unit is a fraction of the width, so it shrinks with the frame rather
    than being withheld below some size. A 40-pixel frame still holds one.
    """
    x, y, w, h = known_marks.unit_box('douyin', (0, 0, 20, 20), 40, 40)
    assert (w, h) == (round(known_marks.MARK_UNITS['douyin'][0] * 40),
                      max(20, round(known_marks.MARK_UNITS['douyin'][1] * 40)))
    assert x + w <= 40 and y + h <= 40


def test_a_frame_with_no_size_is_left_alone():
    box = (0, 0, 10, 10)
    assert known_marks.unit_box('douyin', box, 0, 0) == box


def test_the_unit_never_shrinks_a_match():
    big = (0, 0, 900, 900)
    x, y, w, h = known_marks.unit_box('douyin', big, 1080, 1920)
    assert w >= big[2] and h >= big[3]


def test_the_unit_never_leaves_the_frame():
    for box in ((26, 22, 264, 176), (742, 1730, 312, 190), (0, 0, 10, 10),
                (1070, 1910, 10, 10)):
        x, y, w, h = known_marks.unit_box('douyin', box, 1080, 1920)
        assert 0 <= x and 0 <= y and x + w <= 1080 and y + h <= 1920, (box, (x, y, w, h))


# ─── establishing a platform, then confirming its other placements ───────────
#
# A platform draws one mark and moves it about, and the same badge scores
# differently depending on what is behind it. 小红书's pill measured 0.98 over
# a pale wall and 0.56 over dark wood in the same clip: a white badge's border
# is a strong edge against one and a weak one against the other. Holding the
# second sighting to the bar that establishes the platform lost half the video.


BOX = (30, 30, 120, 48)
ELSEWHERE = (400, 1700, 120, 48)


def test_a_faint_second_sighting_counts_once_the_platform_is_established():
    kept = known_marks.confirmed([
        ('douyin', 0.93, BOX, 0),
        ('douyin', 0.56, ELSEWHERE, 8),
    ])
    assert [box for _, box, _ in kept] == [BOX, ELSEWHERE]


def test_a_faint_sighting_alone_establishes_nothing():
    assert known_marks.confirmed([('douyin', 0.56, BOX, 0)]) == []


def test_one_platform_does_not_vouch_for_another():
    """抖音 being present is no reason to believe a weak 快手 match."""
    kept = known_marks.confirmed([
        ('douyin', 0.93, BOX, 0),
        ('kuaishou', 0.56, ELSEWHERE, 4),
    ])
    assert [box for _, box, _ in kept] == [BOX]


def test_nothing_seen_is_nothing_kept():
    assert known_marks.confirmed([]) == []


def test_the_confirmed_bar_is_below_the_establishing_one():
    assert known_marks.CONFIRMED_THRESHOLD < known_marks.MATCH_THRESHOLD
