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


@pytest.fixture(scope='module')
def pan() -> Pan:
    return Pan()


@pytest.fixture(scope='module')
def mask() -> np.ndarray:
    return create_mask(*SIZE, *ROI)


# ─── quality settings ────────────────────────────────────────────────────────

def test_every_quality_the_ui_offers_has_settings():
    for name in ('fast', 'balanced', 'quality'):
        assert temporal_core.quality_settings(name).name == name


def test_an_unknown_quality_names_the_ones_that_exist():
    with pytest.raises(ValueError, match='balanced'):
        temporal_core.quality_settings('cinematic')


def test_the_settings_get_slower_and_more_thorough_in_order():
    fast, balanced, best = (temporal_core.quality_settings(n)
                            for n in ('fast', 'balanced', 'quality'))
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

    flow = temporal_core.flow_estimator(temporal_core.quality_settings('quality'))(
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
        pan.frame(index), mask, ROI, pan.source(index), quality='quality')
    single_frame = process_inpaint(pan.frame(index), mask, radius=3, roi=ROI)

    assert pan.error(index, temporal) < pan.error(index, single_frame) / 2


def test_quality_buys_accuracy(pan, mask):
    index = 12
    errors = {
        name: pan.error(index, temporal_core.process_temporal(
            pan.frame(index), mask, ROI, pan.source(index), quality=name))
        for name in ('fast', 'balanced', 'quality')
    }
    assert errors['quality'] <= errors['balanced'] <= errors['fast']


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
        pan.frame(index), mask, ROI, pan.source(index), quality='quality')

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
        pan.frame(index), mask, ROI, pan.source(index), quality='quality')

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

    settings = temporal_core.quality_settings('quality')
    temporal_core.process_temporal(pan.frame(7), mask, ROI, source, quality='quality')

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

    temporal_core.process_temporal(pan.frame(index), mask, ROI, counted, quality='quality')
    assert len(asked) < temporal_core.quality_settings('quality').reach
