"""
Unit tests for backend/temporal_core.py — flow-guided temporal inpainting.

The scenes here are synthetic but not arbitrary: a panning camera over a
textured background with a static mark burned into every frame is exactly the
case the engine exists for, and the frames it is not given (the ends of a
clip, a cut) are the cases it has to survive.
"""
import cv2
import numpy as np
import pytest

import temporal_core
from image_core import create_mask, process_inpaint

ROI = (200, 100, 80, 40)
SIZE = (480, 240)  # width, height


def _scene(width: int = 1600, height: int = 300) -> np.ndarray:
    """
    A wide, structured backdrop to pan across.

    Flow estimators need something to track: pure noise defeats them at any
    real displacement, and a flat gradient gives them nothing at all. Circles
    over a gradient behave like footage does.
    """
    rng = np.random.default_rng(3)
    scene = np.zeros((height, width, 3), dtype=np.uint8)
    scene[..., 0] = np.linspace(0, 255, width, dtype=np.float32)[None, :]
    scene[..., 1] = np.linspace(30, 220, height, dtype=np.float32)[:, None]
    for _ in range(150):
        centre = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        colour = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.circle(scene, centre, int(rng.integers(6, 30)), colour, -1)
    return cv2.GaussianBlur(scene, (5, 5), 0)


class Pan:
    """A camera panning across `_scene` at a fixed speed, marked and unmarked."""

    def __init__(self, pixels_per_frame: int = 20, roi=ROI):
        self.scene = _scene()
        self.speed = pixels_per_frame
        self.roi = roi
        self.width, self.height = SIZE

    def truth(self, index: int) -> np.ndarray:
        left = 100 + self.speed * index
        return np.ascontiguousarray(
            self.scene[30:30 + self.height, left:left + self.width])

    def frame(self, index: int) -> np.ndarray:
        x, y, w, h = self.roi
        frame = self.truth(index)
        frame[y:y + h, x:x + w] = 250  # the watermark, in the same place always
        return frame

    def source(self, index: int, count: int = 40):
        """A `neighbor_at` for frame `index` of a clip `count` frames long."""
        def at(offset: int):
            wanted = index + offset
            return self.frame(wanted) if 0 <= wanted < count else None
        return at

    def error(self, index: int, result: np.ndarray) -> float:
        """Mean absolute error against the background the mark was hiding."""
        x, y, w, h = self.roi
        return float(np.abs(
            result[y:y + h, x:x + w].astype(int)
            - self.truth(index)[y:y + h, x:x + w].astype(int)
        ).mean())


class Rotation:
    """
    The same backdrop turning about a point outside the frame, so the mark is
    uncovered by rotation rather than by a pan.

    Worth its own scene: a translation-only motion model fits a pan perfectly
    and a rotation not at all, so this is what shows the affine fit earning
    its extra four coefficients.
    """

    def __init__(self, degrees_per_frame: float = 3.0, roi=ROI):
        self.scene = _scene()
        self.degrees = degrees_per_frame
        self.roi = roi
        self.width, self.height = SIZE

    def truth(self, index: int) -> np.ndarray:
        base = np.ascontiguousarray(
            self.scene[30:30 + self.height, 500:500 + self.width])
        matrix = cv2.getRotationMatrix2D((0.0, float(self.height)),
                                         self.degrees * index, 1.0)
        return cv2.warpAffine(base, matrix, (self.width, self.height),
                              flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    def frame(self, index: int) -> np.ndarray:
        x, y, w, h = self.roi
        frame = self.truth(index)
        frame[y:y + h, x:x + w] = 250
        return frame

    def source(self, index: int, count: int = 40):
        def at(offset: int):
            wanted = index + offset
            return self.frame(wanted) if 0 <= wanted < count else None
        return at

    def error(self, index: int, result: np.ndarray) -> float:
        x, y, w, h = self.roi
        return float(np.abs(
            result[y:y + h, x:x + w].astype(int)
            - self.truth(index)[y:y + h, x:x + w].astype(int)
        ).mean())


@pytest.fixture(scope='module')
def pan() -> Pan:
    return Pan()


@pytest.fixture(scope='module')
def rotation() -> Rotation:
    return Rotation()


@pytest.fixture(scope='module')
def mask() -> np.ndarray:
    return create_mask(*SIZE, *ROI)


# ─── quality settings ────────────────────────────────────────────────────────

def test_every_quality_the_ui_offers_has_settings():
    for name in ('fast', 'balanced', 'high'):
        assert temporal_core.quality_settings(name).name == name


def test_an_unknown_quality_names_the_ones_that_exist():
    with pytest.raises(ValueError, match='balanced'):
        temporal_core.quality_settings('cinematic')


def test_the_settings_get_slower_and_more_thorough_in_order():
    fast, balanced, best = (temporal_core.quality_settings(n)
                            for n in ('fast', 'balanced', 'high'))
    assert fast.max_links < balanced.max_links < best.max_links
    assert fast.flow_scale <= balanced.flow_scale <= best.flow_scale
    assert fast.reach == fast.max_links


# ─── the pieces ──────────────────────────────────────────────────────────────

def test_flow_estimator_follows_opencvs_direction_convention():
    """`prev(p)` is `next(p + flow(p))` — what the sampler assumes."""
    scene = _scene(800, 200)
    shift = 6
    previous = cv2.cvtColor(np.ascontiguousarray(scene[:, 100:500]), cv2.COLOR_BGR2GRAY)
    following = cv2.cvtColor(
        np.ascontiguousarray(scene[:, 100 + shift:500 + shift]), cv2.COLOR_BGR2GRAY)

    flow = temporal_core.flow_estimator(temporal_core.quality_settings('high'))(
        previous, following)
    assert np.median(flow[..., 0]) == pytest.approx(-shift, abs=1.0)
    assert np.median(flow[..., 1]) == pytest.approx(0, abs=1.0)


def test_fit_affine_flow_recovers_a_translation():
    flow = np.zeros((60, 80, 2), dtype=np.float32)
    flow[..., 0] = -4.0
    flow[..., 1] = 2.5
    matrix = temporal_core.fit_affine_flow(flow, np.ones((60, 80), dtype=bool))

    assert matrix[0, 2] == pytest.approx(-4.0, abs=1e-6)
    assert matrix[1, 2] == pytest.approx(2.5, abs=1e-6)
    assert np.allclose(matrix[:, :2], 0, atol=1e-6)


def test_fit_affine_flow_recovers_a_zoom():
    ys, xs = np.mgrid[0:60, 0:80].astype(np.float32)
    flow = np.stack([0.1 * xs, 0.1 * ys], axis=-1)
    matrix = temporal_core.fit_affine_flow(flow, np.ones((60, 80), dtype=bool))

    assert matrix[0, 0] == pytest.approx(0.1, abs=1e-6)
    assert matrix[1, 1] == pytest.approx(0.1, abs=1e-6)


def test_fit_affine_flow_falls_back_to_a_median_with_too_little_to_fit_on():
    """A mark against the frame edge leaves barely any ring; it still answers."""
    flow = np.zeros((60, 80, 2), dtype=np.float32)
    flow[..., 0] = 3.0
    ring = np.zeros((60, 80), dtype=bool)
    ring[0, :10] = True  # far fewer points than MIN_FIT_POINTS

    matrix = temporal_core.fit_affine_flow(flow, ring)
    assert matrix[0, 2] == pytest.approx(3.0)
    assert np.allclose(matrix[:, :2], 0)


def test_fit_affine_flow_answers_even_with_no_ring_at_all():
    matrix = temporal_core.fit_affine_flow(
        np.zeros((10, 10, 2), dtype=np.float32), np.zeros((10, 10), dtype=bool))
    assert matrix.shape == (2, 3)
    assert np.allclose(matrix, 0)


def test_composing_two_steps_gives_the_sum_of_two_translations():
    first = np.array([[0.0, 0.0, -5.0], [0.0, 0.0, 1.0]])
    second = np.array([[0.0, 0.0, -7.0], [0.0, 0.0, 2.0]])
    composed = temporal_core.compose(first, second)

    assert composed[0, 2] == pytest.approx(-12.0)
    assert composed[1, 2] == pytest.approx(3.0)


def test_composing_a_step_with_nothing_changes_nothing():
    step = np.array([[0.01, 0.0, -5.0], [0.0, 0.02, 1.0]])
    assert np.allclose(temporal_core.compose(np.zeros((2, 3)), step), step)


def test_sample_grid_reads_the_pixels_the_model_points_at():
    scene = _scene(600, 200)
    shift = 7
    target = np.ascontiguousarray(scene[:, 20:220])
    neighbor = np.ascontiguousarray(scene[:, 20 + shift:220 + shift])

    map_x, map_y = temporal_core.sample_grid(
        np.array([[0.0, 0.0, -shift], [0.0, 0.0, 0.0]]), 50, 40, 150, 100, 0, 0)
    sampled = cv2.remap(neighbor, map_x, map_y, cv2.INTER_LINEAR)

    assert np.array_equal(sampled, target[40:100, 50:150])


def test_flow_residual_separates_a_right_model_from_a_wrong_one():
    scene = _scene(800, 200)
    shift = 5
    target = cv2.cvtColor(np.ascontiguousarray(scene[:, 100:400]), cv2.COLOR_BGR2GRAY)
    neighbor = cv2.cvtColor(
        np.ascontiguousarray(scene[:, 100 + shift:400 + shift]), cv2.COLOR_BGR2GRAY)
    ring = np.ones(target.shape, dtype=bool)
    contrast = temporal_core.ring_contrast(target, ring)

    right = temporal_core.flow_residual(
        target, neighbor, np.array([[0.0, 0.0, -shift], [0.0, 0.0, 0.0]]), ring, contrast)
    wrong = temporal_core.flow_residual(
        target, neighbor, np.array([[0.0, 0.0, 40.0], [0.0, 0.0, 0.0]]), ring, contrast)

    assert right < temporal_core.FLOW_RESIDUAL_LIMIT < wrong


def test_flow_residual_refuses_to_judge_on_almost_no_ring():
    gray = np.zeros((50, 50), dtype=np.uint8)
    ring = np.zeros((50, 50), dtype=bool)
    ring[0, :3] = True
    assert temporal_core.flow_residual(gray, gray, np.zeros((2, 3)), ring, 10.0) == float('inf')


def test_feather_alpha_is_solid_over_the_selection_and_fades_to_its_edge():
    alpha = temporal_core.feather_alpha(20, 20, left=4, right=4, top=4, bottom=4)

    assert alpha[10, 10] == pytest.approx(1.0)      # the selection itself
    assert alpha[0, 10] < 0.2                        # the outer edge of the band
    assert alpha[4, 10] == pytest.approx(1.0)        # where the selection starts
    # Monotonic across the band: no step for a seam to show up on.
    assert list(alpha[:5, 10]) == sorted(alpha[:5, 10])


def test_feather_alpha_stays_solid_on_a_side_with_no_band():
    """A mark on the frame edge has no clean pixels to fade into on that side."""
    alpha = temporal_core.feather_alpha(20, 20, left=0, right=4, top=0, bottom=4)
    assert alpha[0, 0] == pytest.approx(1.0)
    assert alpha[0, 19] < 1.0


# ─── the engine ──────────────────────────────────────────────────────────────

def test_it_recovers_the_background_a_pan_uncovered(pan, mask):
    """The whole point: better than reconstructing from this frame alone."""
    index = 12
    temporal = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='high')
    single_frame = process_inpaint(pan.frame(index), mask, radius=3, roi=ROI)

    assert pan.error(index, temporal) < pan.error(index, single_frame) / 2


def test_quality_buys_accuracy(pan, mask):
    index = 12
    errors = {
        name: pan.error(index, temporal_core.process_temporal(
            pan.frame(index), mask, ROI, pan.source(index), quality=name))
        for name in ('fast', 'balanced', 'high')
    }
    assert errors['high'] <= errors['balanced'] <= errors['fast']


def test_it_leaves_everything_outside_the_selection_alone(pan, mask):
    index = 12
    original = pan.frame(index)
    result = temporal_core.process_temporal(original, mask, ROI, pan.source(index))

    x, y, w, h = ROI
    feather = temporal_core.quality_settings('balanced').feather
    untouched = np.ones(original.shape[:2], dtype=bool)
    untouched[y - feather:y + h + feather, x - feather:x + w + feather] = False
    assert np.array_equal(result[untouched], original[untouched])


def test_the_seam_is_gradual_rather_than_a_step(pan, mask):
    """
    The edge is the complaint the feature exists to answer: a hard boundary
    between filled and original pixels is what reads as a block.
    """
    index = 12
    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='high')

    x, y, w, h = ROI
    row = result[y + h // 2, x - 12:x + 12].astype(int)
    jumps = np.abs(np.diff(row, axis=0)).max(axis=1)
    assert jumps.max() < 60


def test_a_frame_with_no_neighbours_falls_back_to_single_frame_inpainting(pan, mask):
    """The first frame of a clip is not an error, and not a hole."""
    frame = pan.frame(0)
    result = temporal_core.process_temporal(frame, mask, ROI, lambda _offset: None)
    assert np.array_equal(result, process_inpaint(frame, mask, radius=3, roi=ROI))


def test_a_still_camera_falls_back_rather_than_inventing_motion(pan, mask):
    """
    Nothing is ever uncovered, so there is nothing to recover: the result is
    the single-frame fill, give or take the handful of pixels at the very edge
    of the selection that a neighbour can legitimately reach.
    """
    frame = pan.frame(7)
    result = temporal_core.process_temporal(
        frame, mask, ROI, lambda _offset: pan.frame(7), quality='fast')
    assert np.allclose(result, process_inpaint(frame, mask, radius=3, roi=ROI), atol=8)


def test_it_ignores_a_neighbour_of_a_different_size(pan, mask):
    """A frame that cannot be sampled with these coordinates is not used."""
    index = 12
    odd = np.zeros((100, 100, 3), dtype=np.uint8)
    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, lambda _offset: odd, quality='fast')
    assert np.array_equal(result, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))


def test_it_does_not_copy_the_mark_from_a_neighbouring_frame(pan, mask):
    """
    The mark sits in the same place in every frame, so a neighbour's own mark
    is never a valid source. It is the mistake that would leave the watermark
    exactly where it was.
    """
    index = 12
    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='high')

    x, y, w, h = ROI
    middle = result[y + 8:y + h - 8, x + 8:x + w - 8]
    assert np.count_nonzero(np.all(middle >= 248, axis=-1)) < middle[..., 0].size // 20


def test_a_mark_against_the_frame_edge_is_still_filled(pan):
    """No band on two sides, and less ring to fit the motion to."""
    corner = (0, 0, 60, 40)
    edge_pan = Pan(roi=corner)
    mask = create_mask(*SIZE, *corner)
    index = 12

    result = temporal_core.process_temporal(
        edge_pan.frame(index), mask, corner, edge_pan.source(index), quality='balanced')
    filled = result[2:38, 2:58]
    assert np.count_nonzero(np.all(filled >= 248, axis=-1)) < filled[..., 0].size // 20


def test_a_cut_in_the_middle_of_the_walk_is_dropped(pan, mask):
    """
    Frames from the other side of a cut verify badly and are thrown away
    rather than pasted into the middle of this shot.
    """
    index = 12
    rng = np.random.default_rng(11)
    unrelated = rng.integers(0, 255, (SIZE[1], SIZE[0], 3), dtype=np.uint8)

    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, lambda _offset: unrelated, quality='balanced')
    assert np.array_equal(result, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))


def test_a_walk_that_gets_nowhere_stops_early(pan, mask):
    """Patience, not the full reach, is what a locked-off shot pays for."""
    asked = []

    def source(offset: int):
        asked.append(offset)
        return pan.frame(7)

    settings = temporal_core.quality_settings('high')
    temporal_core.process_temporal(pan.frame(7), mask, ROI, source, quality='high')

    # A couple of steps to fill the feather band, then the patience rule ends
    # it — nothing like the sixteen frames either side the setting allows for.
    assert len(asked) <= 2 * (settings.min_samples + temporal_core.NO_GAIN_PATIENCE)
    assert len(asked) < settings.reach


def test_a_pan_stops_walking_as_soon_as_it_has_covered_the_mark(pan, mask):
    """The reach is a limit, not a cost: an easy shot never reaches it."""
    index = 12
    asked = []
    source = pan.source(index)

    def counted(offset: int):
        asked.append(offset)
        return source(offset)

    temporal_core.process_temporal(pan.frame(index), mask, ROI, counted, quality='high')
    assert len(asked) < temporal_core.quality_settings('high').reach


# ─── how good is good enough ─────────────────────────────────────────────────
#
# The thresholds below are absolute rather than relative, because "better than
# inpainting" is not the promise the feature makes — recovering the background
# is. They are set well above the measured figures (in brackets) so ordinary
# variation between OpenCV builds does not fail the suite, and far below what
# single-frame inpainting scores on the same scene.

def test_a_pan_is_reconstructed_to_within_a_few_pixel_values(pan, mask):
    index = 12
    balanced = pan.error(index, temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='balanced'))
    high = pan.error(index, temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='high'))
    single_frame = pan.error(index, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))

    assert balanced < 6.0    # measured 4.5
    assert high < 1.0        # measured 0.4
    assert single_frame > 15.0  # measured 17.4 — what the mark hides today


def test_a_rotation_is_reconstructed_too(rotation):
    """
    The mark is uncovered by the picture turning, not sliding. A model that
    could only measure translation would score no better than inpainting here.
    """
    mask = create_mask(*SIZE, *ROI)
    index = 12
    balanced = rotation.error(index, temporal_core.process_temporal(
        rotation.frame(index), mask, ROI, rotation.source(index), quality='balanced'))
    high = rotation.error(index, temporal_core.process_temporal(
        rotation.frame(index), mask, ROI, rotation.source(index), quality='high'))
    single_frame = rotation.error(
        index, process_inpaint(rotation.frame(index), mask, radius=3, roi=ROI))

    assert balanced < 6.0    # measured 2.5
    assert high < 2.0        # measured 1.7
    assert single_frame > 8.0   # measured 11.9


# ─── failures that must not take the job with them ───────────────────────────

def _raising_estimator(exception: BaseException, only_at: int | None = None):
    """
    A flow estimator that fails, standing in for the ones that do in the wild:
    a build whose DIS asserts on a frame it will not take, or a machine that
    has run out of room to hold the field.

    `only_at` fails on the nth call and behaves for the rest, which is how a
    single bad step in one direction gets tested apart from a total failure.
    """
    calls = {'n': 0}
    real = temporal_core.flow_estimator

    def make(settings):
        genuine = real(settings)

        def estimate(previous, following):
            calls['n'] += 1
            if only_at is None or calls['n'] == only_at:
                raise exception
            return genuine(previous, following)

        return estimate

    return make, calls


def test_a_flow_failure_falls_back_to_the_single_frame_fill(pan, mask, monkeypatch, capsys):
    """
    Every direction failing is the worst case, and it is still a finished
    frame: the same fill the single-frame engine would have produced, not a
    crash halfway through an export.
    """
    index = 12
    make, _ = _raising_estimator(cv2.error('DIS: unsupported frame'))
    monkeypatch.setattr(temporal_core, 'flow_estimator', make)

    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='balanced')

    assert np.array_equal(
        result, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))
    # The frame came out; the log is where the reason lives.
    warnings_out = capsys.readouterr().err
    assert 'optical flow failed' in warnings_out
    assert 'single-frame fill' in warnings_out


def test_one_bad_step_costs_its_direction_and_not_the_frame(pan, mask, monkeypatch):
    """The other side of the walk is untouched, and still recovers the mark."""
    index = 12
    make, _ = _raising_estimator(cv2.error('DIS: unsupported frame'), only_at=1)
    monkeypatch.setattr(temporal_core, 'flow_estimator', make)

    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='balanced')

    # Reconstructed from the surviving direction, not fallen back on.
    assert not np.array_equal(
        result, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))
    assert pan.error(index, result) < 12.0


def test_running_out_of_memory_says_which_dial_to_turn(pan, mask, monkeypatch):
    """
    `str(MemoryError())` is empty, and an empty failure reaches the user as
    "the backend gave no reason". The one thing worth saying here is what they
    can change, so the message carries it.
    """
    make, _ = _raising_estimator(MemoryError())
    monkeypatch.setattr(temporal_core, 'flow_estimator', make)

    with pytest.raises(MemoryError, match='lower temporal quality'):
        temporal_core.process_temporal(
            pan.frame(12), mask, ROI, pan.source(12), quality='balanced')


def test_a_degenerate_solve_ends_its_direction_rather_than_the_job(pan, mask, monkeypatch):
    """numpy raising out of the fit is the same kind of event as cv2 raising."""
    make, _ = _raising_estimator(np.linalg.LinAlgError('SVD did not converge'))
    monkeypatch.setattr(temporal_core, 'flow_estimator', make)

    result = temporal_core.process_temporal(
        pan.frame(12), mask, ROI, pan.source(12), quality='balanced')
    assert result.shape == pan.frame(12).shape


def test_a_sampling_failure_skips_the_neighbour_and_keeps_the_walk(pan, mask, monkeypatch, capsys):
    """
    The model verified before the sample was taken, so the walk is sound and
    only this one neighbour's pixels are lost.
    """
    index = 12
    real_remap = cv2.remap
    calls = {'n': 0}

    def flaky_remap(*args, **kwargs):
        calls['n'] += 1
        # The residual check remaps too; fail a sampling call, which comes
        # after it and asks for a three-channel image.
        if calls['n'] == 2:
            raise cv2.error('remap: unsupported map type')
        return real_remap(*args, **kwargs)

    monkeypatch.setattr(cv2, 'remap', flaky_remap)
    result = temporal_core.process_temporal(
        pan.frame(index), mask, ROI, pan.source(index), quality='balanced')

    assert 'skipping it' in capsys.readouterr().err
    assert result.shape == pan.frame(index).shape
    assert pan.error(index, result) < 12.0


def test_a_frame_that_falls_back_after_a_failure_says_so(pan, mask, monkeypatch):
    """
    The caller needs to count these: one line per frame in a log nobody reads
    is not the same as one number the user is shown at the end.
    """
    reasons = []
    make, _ = _raising_estimator(cv2.error('DIS: unsupported frame'))
    monkeypatch.setattr(temporal_core, 'flow_estimator', make)

    temporal_core.process_temporal(
        pan.frame(12), mask, ROI, pan.source(12), quality='balanced',
        on_degraded=reasons.append)

    assert len(reasons) == 1
    assert 'single-frame fill' in reasons[0]


def test_a_frame_that_reconstructs_normally_reports_nothing(pan, mask):
    reasons = []
    temporal_core.process_temporal(
        pan.frame(12), mask, ROI, pan.source(12), quality='balanced',
        on_degraded=reasons.append)
    assert reasons == []


def test_a_shot_with_nothing_to_rebuild_from_is_not_a_failure(pan, mask):
    """
    A locked-off camera over a still background never uncovers the mark, so
    every frame falls back — and that is the engine working, not failing.
    Counting it would tell the user something went wrong on footage where
    nothing did.
    """
    reasons = []
    result = temporal_core.process_temporal(
        pan.frame(7), mask, ROI, lambda _offset: pan.frame(7), quality='balanced',
        on_degraded=reasons.append)

    # It did fall back — the result is the single-frame fill, give or take the
    # few edge pixels a neighbour can legitimately reach (see
    # test_a_still_camera_falls_back_rather_than_inventing_motion) …
    assert np.allclose(
        result, process_inpaint(pan.frame(7), mask, radius=3, roi=ROI), atol=8)
    # … and it said nothing about it.
    assert reasons == []


def test_a_frame_with_no_neighbours_at_all_reports_nothing(pan, mask):
    """The first frame of a clip has nothing either side; that is not a fault."""
    reasons = []
    temporal_core.process_temporal(
        pan.frame(0), mask, ROI, lambda _offset: None, on_degraded=reasons.append)
    assert reasons == []
