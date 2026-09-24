"""
Unit tests for backend/survey.py — telling a watermark from everything else.

The scene here carries the three things the module has to keep apart, over a
picture that moves: a mark in the corner that never changes, a line of type in
the lower third that says something else every few seconds, and a caption near
the top that is opaque and animates. Only the first of them is something this
app can recover the picture from, and only the first of them is proposed.
"""
import cv2
import numpy as np
import pytest

import recover
import survey
from survey import Finding, OTHER, SUBTITLE, WATERMARK

WIDTH, HEIGHT = 320, 240
WINDOW = 16
MARK_AT = (10, 8)
MARK = (92, 38)
STRIP = (70, 180, 180, 26)


def _mark_alpha() -> np.ndarray:
    w, h = MARK
    strokes = np.zeros((h, w), np.uint8)
    cv2.putText(strokes, 'MARK', (4, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 225, 2)
    cv2.line(strokes, (4, 32), (w - 8, 32), 150, 2)
    return cv2.GaussianBlur(strokes.astype(np.float32) / 255.0, (3, 3), 0.7)


class Clip:
    """Moving footage carrying a mark, a changing subtitle and a caption."""

    SPEED = 4
    SUBTITLE_EVERY = 32   # frames — two windows, so consecutive ones differ
    CAPTION = (110, 300)  # frames the opaque caption is on screen for

    def __init__(self, frames: int = 320):
        self.count = frames
        self.alpha = _mark_alpha()
        self.colour = np.full((*MARK[::-1], 3), 250.0, np.float32)

        rng = np.random.default_rng(11)
        self.scene = np.zeros((HEIGHT + 40, WIDTH + self.SPEED * frames + 40, 3), np.uint8)
        self.scene[..., 0] = np.linspace(
            30, 220, self.scene.shape[1], dtype=np.float32)[None, :]
        self.scene[..., 2] = np.linspace(
            210, 35, self.scene.shape[0], dtype=np.float32)[:, None]
        # Broad shapes rather than confetti. Real footage is smooth regions
        # with edges between them; a backdrop of small high-contrast blobs has
        # detail everywhere, which is the one thing a scan looking for detail
        # that holds still cannot see past.
        for _ in range(260):
            centre = (int(rng.integers(0, self.scene.shape[1])),
                      int(rng.integers(0, self.scene.shape[0])))
            colour = tuple(int(v) for v in rng.integers(30, 220, 3))
            cv2.circle(self.scene, centre, int(rng.integers(18, 60)), colour, -1)
        self.scene = cv2.GaussianBlur(self.scene, (9, 9), 0)

    def truth(self, index: int) -> np.ndarray:
        left = self.SPEED * index
        return np.ascontiguousarray(self.scene[20:20 + HEIGHT, left:left + WIDTH])

    def frame(self, index: int) -> np.ndarray:
        frame = self.truth(index).astype(np.float32)

        # The mark: one fixed alpha composite, in the corner, all the way
        # through — which is what a platform burns in.
        x, y = MARK_AT
        w, h = MARK
        a = self.alpha[..., None]
        frame[y:y + h, x:x + w] = (1 - a) * frame[y:y + h, x:x + w] + a * self.colour

        # The subtitle: opaque type, inset from every side, saying something
        # else every couple of windows.
        sx, sy, sw, sh = STRIP
        # Genuinely different text, not the same line with a digit changed:
        # what makes a subtitle a subtitle is that the next one is unrelated.
        lines = ['THE QUICK BROWN', 'jumps over', 'A LAZY DOG NOW',
                 'and then some', 'WXYZ 1234 !!', 'tiny']
        said = lines[(index // self.SUBTITLE_EVERY) % len(lines)]
        cv2.putText(frame, said, (sx, sy + sh - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        # The caption: opaque, near the top edge, on screen for a stretch.
        if self.CAPTION[0] <= index < self.CAPTION[1]:
            cv2.putText(frame, 'CAPTION', (150, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (20, 20, 240), 3)

        return np.clip(frame, 0, 255).astype(np.uint8)

    def read(self, index: int) -> np.ndarray:
        return self.frame(index)


@pytest.fixture(scope='module')
def clip() -> Clip:
    return Clip()


@pytest.fixture(scope='module')
def findings(clip: Clip) -> list[Finding]:
    return survey.survey(clip.read, clip.count, WIDTH, HEIGHT, window=WINDOW)


def _at(findings: list[Finding], box: tuple[int, int, int, int]) -> Finding | None:
    """The finding covering `box`, if the survey produced one."""
    for finding in findings:
        if survey._covered(box, finding.box) >= 0.6:
            return finding
    return None


# ─── What it proposes ───────────────────────────────────────────────────────

def test_the_mark_is_found_and_proposed(clip, findings):
    mark = _at(findings, (*MARK_AT, *MARK))
    assert mark is not None, findings
    assert mark.kind == WATERMARK and mark.proposed


def test_only_the_mark_is_proposed(clip, findings):
    """
    Everything else on this video is something the user put there. Proposing to
    remove a subtitle, or the caption, is proposing to destroy their work.
    """
    proposed = [f for f in findings if f.proposed]
    assert len(proposed) == 1, proposed
    assert survey._covered((*MARK_AT, *MARK), proposed[0].box) >= 0.6


def test_the_subtitle_is_reported_but_not_proposed(clip, findings):
    strip = _at(findings, STRIP)
    assert strip is not None, findings
    assert strip.kind == SUBTITLE and not strip.proposed


def test_the_caption_is_not_taken_for_a_mark(clip, findings):
    """
    Near an edge, holding still, on screen for a stretch — everything a mark
    looks like from outside. What it is not is one fixed blend.
    """
    caption = _at(findings, (150, 18, 130, 30))
    if caption is not None:
        assert caption.kind != WATERMARK and not caption.proposed


def test_the_mark_is_timed_over_the_whole_clip(clip, findings):
    mark = _at(findings, (*MARK_AT, *MARK))
    assert mark.start == 0
    assert mark.end >= clip.count - WINDOW


def test_findings_lead_with_what_is_proposed(clip, findings):
    """The list is read top down, and the decisions are at the top."""
    kinds = [f.proposed for f in findings]
    assert kinds == sorted(kinds, reverse=True)


# ─── The measurements, on their own ─────────────────────────────────────────

def test_stability_sees_a_mark_as_itself(clip):
    """The same pixels a window later correlate at nearly one."""
    maps = [recover.window_magnitude(clip.read, s, s + WINDOW, 1.0)
            for s in (0, WINDOW, 2 * WINDOW)]
    assert survey.stability(maps, (*MARK_AT, *MARK)) >= survey.STABLE_CONTENT


def test_stability_sees_a_subtitle_as_something_else(clip):
    maps = [recover.window_magnitude(clip.read, s, s + WINDOW, 1.0)
            for s in (0, 2 * WINDOW, 4 * WINDOW)]
    assert survey.stability(maps, STRIP) < survey.STABLE_CONTENT


def test_stability_of_one_window_is_not_a_number():
    assert np.isnan(survey.stability([np.zeros((10, 10), np.float32)], (0, 0, 5, 5)))


def test_edge_distance_is_zero_at_the_corner():
    assert survey.edge_distance((0, 0, 20, 20), 100, 100) == 0.0


def test_edge_distance_takes_the_closer_axis():
    # Hard against the top, far from either side: still an edge.
    assert survey.edge_distance((40, 0, 20, 10), 100, 100) == 0.0
    # Off both axes.
    assert survey.edge_distance((40, 40, 20, 20), 100, 100) == pytest.approx(0.4)


def test_typical_box_ignores_one_stray_detection():
    """
    A quartile on each side, so the window that saw half the mark and the one
    that saw the mark plus the picture next to it both lose.
    """
    boxes = [(10, 10, 40, 20)] * 6 + [(10, 10, 4, 2), (0, 0, 300, 300)]
    assert survey.typical_box(boxes) == (10, 10, 40, 20)


def test_runs_split_a_cluster_seen_again_much_later():
    """
    A corner used twice an hour apart is two answers, not one stretch with the
    whole hour inside it.
    """
    windows = {(0, 16): None, (16, 32): None, (800, 816): None}
    runs = survey._runs(windows, 16)
    assert [len(r) for r in runs] == [2, 1]


def test_runs_keep_a_short_gap_inside_one_stretch():
    windows = {(0, 16): None, (16, 32): None, (64, 80): None}
    assert len(survey._runs(windows, 16)) == 1


def test_covered_is_the_fraction_of_the_inner_box():
    assert survey._covered((0, 0, 10, 10), (0, 0, 5, 10)) == pytest.approx(0.5)
    assert survey._covered((0, 0, 10, 10), (50, 50, 10, 10)) == 0.0


def test_a_finding_inside_another_is_dropped():
    """One mark found as itself and as two of its own lines is one finding."""
    whole = Finding((0, 0, 100, 60), 0, 100, WATERMARK, 0.3, 0.9, 0.5, 4)
    piece = Finding((10, 10, 40, 20), 0, 100, WATERMARK, 0.3, 0.9, 0.5, 4)
    assert survey._merged([whole, piece]) == [whole]


def test_a_finding_elsewhere_in_time_is_kept():
    whole = Finding((0, 0, 100, 60), 0, 50, WATERMARK, 0.3, 0.9, 0.5, 4)
    later = Finding((10, 10, 40, 20), 200, 300, WATERMARK, 0.3, 0.9, 0.5, 4)
    assert len(survey._merged([whole, later])) == 2


def test_weak_evidence_is_listed_only_when_it_is_proposed():
    """
    Two windows is enough to offer a mark the user came here for, and not
    enough to be worth a row about a stretch of picture that held still.
    """
    mark = Finding((0, 0, 40, 40), 0, 32, WATERMARK, 0.3, 0.9, 0.5, 2)
    noise = Finding((200, 100, 40, 40), 0, 32, OTHER, 0.3, 0.1, 0.5, 2)
    assert survey._merged([mark, noise]) == [mark]


def test_a_mark_is_not_swallowed_by_something_that_is_not_one():
    """
    A stretch of picture that holds still is often bigger than the mark inside
    it. Largest-wins would take the one row the user came for off the list.
    """
    picture = Finding((0, 0, 300, 200), 0, 100, OTHER, 0.3, 0.2, 0.5, 5)
    mark = Finding((10, 10, 60, 30), 0, 100, WATERMARK, 0.3, 0.95, 0.5, 5)
    kept = survey._merged([picture, mark])
    assert mark in kept and picture in kept


# ─── Not solving what the answer cannot depend on ───────────────────────────

class _Model:
    """Just enough of a solved model for `classify`."""

    def __init__(self, peak: float, residual: float):
        self.alpha = np.full((10, 10), peak, np.float32)
        self.residual = residual


def test_the_screen_never_rejects_something_that_is_a_mark():
    """
    The invariant the optimisation rests on: `could_be_a_mark` is a *necessary*
    condition of `classify` returning a watermark. If it can ever be false
    where classify would say watermark, the survey silently stops finding
    marks — the one failure this whole module exists to prevent.
    """
    boxes = [(0, 0, 40, 30), (46, 0, 40, 30), (46, 46, 40, 30),
             (2, 60, 40, 30), (60, 60, 40, 30), (99, 99, 40, 30)]
    for box in boxes:
        for stable in (-0.5, 0.0, 0.5, 0.79, 0.8, 0.95, 1.0):
            for peak in (0.1, 0.5, 0.94, 0.95, 1.0):
                for residual in (0.0, 15.9, 16.0, 16.1, 60.0):
                    model = _Model(peak, residual)
                    if survey.classify(box, model, stable, 200, 200) != WATERMARK:
                        continue
                    assert survey.could_be_a_mark(box, stable, 200, 200), (
                        f'screen rejects a mark: {box} stable={stable} '
                        f'peak={peak} residual={residual}')


def test_screening_does_not_change_what_the_survey_reports(clip, findings):
    """
    The same answer, reached without solving the stretches whose answer could
    not have mattered. Measured on the reported clip: 131.7s to 53.3s, and the
    twelve findings identical.
    """
    def unscreened(*args, **kwargs):
        return True

    real, survey.could_be_a_mark = survey.could_be_a_mark, unscreened
    try:
        everything = survey.survey(clip.read, clip.count, WIDTH, HEIGHT, window=WINDOW)
    finally:
        survey.could_be_a_mark = real

    assert [(f.kind, f.box, f.start, f.end) for f in everything] == \
           [(f.kind, f.box, f.start, f.end) for f in findings]


# ── Gathering every placement's crops in one pass ────────────────────────────

def _placement(start, end, box):
    return recover.Placement(start, end, box)


def _reader(total, size=(40, 60)):
    """Frames whose content says which frame they are."""
    height, width = size

    def read(index):
        frame = np.zeros((height, width, 3), np.uint8)
        frame[:] = index % 251
        return frame

    return read


def test_the_gathered_crops_are_what_reading_per_placement_would_have_given():
    # The property the whole optimisation rests on. Anything else here is
    # detail; if this is false the survey answers differently.
    read = _reader(50)
    placements = [_placement(0, 40, (2, 3, 10, 8)),
                  _placement(10, 50, (5, 1, 12, 6)),
                  _placement(0, 12, (0, 0, 20, 20))]
    gathered = survey._crops_for(read, placements)
    for crops, placement in zip(gathered, placements):
        x, y, w, h = placement.box
        expected = [read(i)[y:y + h, x:x + w]
                    for i in recover.sample_indices(placement.start, placement.end,
                                                    recover.FIT_SAMPLES)]
        assert len(crops) == len(expected)
        for got, want in zip(crops, expected):
            assert np.array_equal(got, want)


def test_each_frame_is_read_once_however_many_placements_want_it():
    asked = []
    read = _reader(50)

    def counted(index):
        asked.append(index)
        return read(index)

    placements = [_placement(0, 40, (2, 3, 10, 8)),
                  _placement(0, 40, (5, 1, 12, 6)),
                  _placement(0, 40, (1, 1, 8, 8))]
    survey._crops_for(counted, placements)
    assert len(asked) == len(set(asked))


def test_a_frame_that_cannot_be_read_is_skipped_not_substituted():
    read = _reader(50)
    placements = [_placement(0, 40, (2, 3, 10, 8))]
    wanted = recover.sample_indices(0, 40, recover.FIT_SAMPLES)
    missing = wanted[3]

    crops = survey._crops_for(
        lambda i: None if i == missing else read(i), placements)
    assert len(crops[0]) == len(wanted) - wanted.count(missing)
    assert all(crop is not None for crop in crops[0])


def test_too_much_to_hold_at_once_reads_per_placement_instead():
    # The pathological video: hundreds of large stretches. The answer is to
    # stop gathering, not to spend the memory.
    read = _reader(50)
    placements = [_placement(0, 40, (0, 0, 600, 400)) for _ in range(200)]
    assert survey._crops_for(read, placements) is None


def test_nothing_to_gather_is_not_a_failure():
    assert survey._crops_for(_reader(10), []) == []
