"""
Unit tests for the edge-aware half of temporal fill.

`test_temporal_core.py` covers the engine on scenes made of blurred circles
over a gradient, which is what most footage looks like and is deliberately
forgiving: everything in shot is a soft transition, so a motion model that is
half a pixel out costs almost nothing. This file covers the case that is not
forgiving. A caption, a logo, black text on white — a hard boundary where
being half a pixel out means sampling the black side when the white one
belonged, and where averaging a few such samples turns a crisp line into a
grey ramp. That ramp is the "you can still see where the watermark was"
complaint the edge-aware work exists to answer.

The scene here is accordingly built from hard-edged white bars and lettering
rather than circles, and the measurements are the ones that can see blur:
PSNR and SSIM against the background the mark was hiding, plus how much of the
original gradient energy survived into the reconstruction.
"""
import dataclasses
import warnings

import cv2
import numpy as np
import pytest

import edge_utils
import temporal_core
from image_core import create_mask

from test_temporal_core import ROI, SIZE

# ─── measurements ────────────────────────────────────────────────────────────


def psnr(truth: np.ndarray, result: np.ndarray) -> float:
    """Peak signal-to-noise ratio in dB; higher is closer to the truth."""
    mse = float(((truth.astype(np.float32) - result.astype(np.float32)) ** 2).mean())
    return 10.0 * np.log10(255.0 ** 2 / max(mse, 1e-9))


def ssim(truth: np.ndarray, result: np.ndarray) -> float:
    """
    Structural similarity over the luma, 1.0 being identical.

    Written out rather than pulled from scikit-image: the backend ships with
    OpenCV and numpy and nothing else, and a test dependency that is not in
    `requirements.txt` is a test that does not run in the packaged build.

    SSIM is the measurement that matters most here. Mean error is dominated by
    how *bright* the mistakes are; SSIM asks whether the local structure — the
    thing an edge is made of — survived, which is exactly the complaint.
    """
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    a = cv2.cvtColor(truth, cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY).astype(np.float32)

    def blur(image):
        return cv2.GaussianBlur(image, (11, 11), 1.5)

    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a * mu_a
    var_b = blur(b * b) - mu_b * mu_b
    covariance = blur(a * b) - mu_a * mu_b

    numerator = (2 * mu_a * mu_b + c1) * (2 * covariance + c2)
    denominator = (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2)
    return float((numerator / denominator).mean())


def gradient_energy(image: np.ndarray) -> float:
    """Mean Sobel magnitude — how much detail an image has left in it."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(cv2.magnitude(
        cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3),
    ).mean())


# ─── a scene with hard edges in it ───────────────────────────────────────────


def _caption_scene(width: int = 1600, height: int = 300) -> np.ndarray:
    """
    A dark backdrop carrying hard white bars and lettering.

    Every boundary in here is a step, not a ramp — which is the whole point.
    The mid-grey blobs are not decoration: a flow estimator needs texture to
    track, and a frame that is only black and white gives it nothing between
    the bars to lock onto.
    """
    rng = np.random.default_rng(5)
    scene = np.full((height, width, 3), 30, dtype=np.uint8)
    for _ in range(120):
        centre = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        shade = tuple(int(v) for v in rng.integers(40, 110, 3))
        cv2.circle(scene, centre, int(rng.integers(8, 26)), shade, -1)
    for left in range(0, width, 60):
        cv2.rectangle(scene, (left, 110), (left + 26, 190), (255, 255, 255), -1)
        cv2.rectangle(scene, (left + 34, 130), (left + 50, 170), (255, 255, 255), -1)
    cv2.putText(scene, 'SUBTITLE ' * 12, (0, 240),
                cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
    return scene


class CaptionPan:
    """The caption scene panning past a mark that never moves."""

    def __init__(self, pixels_per_frame: int = 17):
        self.scene = _caption_scene()
        self.speed = pixels_per_frame
        self.width, self.height = SIZE

    def truth(self, index: int) -> np.ndarray:
        left = 100 + self.speed * index
        return np.ascontiguousarray(
            self.scene[30:30 + self.height, left:left + self.width])

    def frame(self, index: int) -> np.ndarray:
        x, y, w, h = ROI
        frame = self.truth(index)
        frame[y:y + h, x:x + w] = 250
        return frame

    def source(self, index: int, count: int = 40):
        def at(offset: int):
            wanted = index + offset
            return self.frame(wanted) if 0 <= wanted < count else None
        return at

    def patch(self, image: np.ndarray) -> np.ndarray:
        """Just the reconstructed selection, which is what is being judged."""
        x, y, w, h = ROI
        return np.ascontiguousarray(image[y:y + h, x:x + w])


#: Frames to average each measurement over. Few enough to keep the suite quick,
#: enough that one lucky frame cannot carry a result.
FRAMES = (10, 13, 16)

#: The engine as it was before this file existed: flow only, no edge work.
#: Every comparison below is against this, so a regression shows up as the new
#: code scoring no better than the old rather than as a number drifting.
FLOW_ONLY = dict(edge_penalty=0.0, robust_fit=False, edge_feather=0.0,
                 fuse='median')


@pytest.fixture(scope='module')
def caption() -> CaptionPan:
    return CaptionPan()


@pytest.fixture(scope='module')
def mask() -> np.ndarray:
    return create_mask(*SIZE, *ROI)


def _reconstruct(caption, mask, quality, overrides=None):
    """Run the engine over `FRAMES`, optionally with a patched preset."""
    presets = temporal_core.QUALITY_PRESETS
    original = presets[quality]
    if overrides:
        presets[quality] = dataclasses.replace(original, **overrides)
    try:
        return [temporal_core.process_temporal(
            caption.frame(i), mask, ROI, caption.source(i), quality=quality)
            for i in FRAMES]
    finally:
        presets[quality] = original


def _score(caption, results):
    """Mean PSNR and SSIM over the reconstructed selections."""
    truths = [caption.patch(caption.truth(i)) for i in FRAMES]
    patches = [caption.patch(r) for r in results]
    return (float(np.mean([psnr(t, p) for t, p in zip(truths, patches)])),
            float(np.mean([ssim(t, p) for t, p in zip(truths, patches)])))


# ─── the pieces ──────────────────────────────────────────────────────────────

def test_edge_strength_marks_a_boundary_and_leaves_flat_ground_alone():
    image = np.zeros((40, 40), dtype=np.uint8)
    image[:, 20:] = 255

    edge = edge_utils.edge_strength(image)
    assert edge[20, 20] > 0.9      # on the boundary
    assert edge[20, 5] < 0.05      # well away from it
    assert edge.dtype == np.float32
    assert edge.max() <= 1.0 and edge.min() >= 0.0


def test_edge_strength_does_not_invent_edges_in_a_flat_picture():
    """
    A clear sky has no structure, and normalising by a percentile of nothing
    would divide the sensor noise by itself and report edges everywhere. The
    floor under the scale is what stops that.
    """
    rng = np.random.default_rng(1)
    flat = np.clip(np.full((60, 60), 128) + rng.normal(0, 2.0, (60, 60)),
                   0, 255).astype(np.uint8)
    assert edge_utils.edge_strength(flat).mean() < 0.15


def test_edge_strength_reads_a_colour_frame_as_well_as_a_grey_one():
    colour = np.zeros((30, 30, 3), dtype=np.uint8)
    colour[:, 15:] = 255
    assert edge_utils.edge_strength(colour).shape == (30, 30)


def test_select_nearest_returns_a_value_a_candidate_actually_had():
    """
    The point of the whole exercise: no output pixel is an average. Three
    candidates 10 apart have a median of 20, and a mean would invent 20 as
    well — but 20 is a value one of them really held, and that is what comes
    back, rather than something between them.
    """
    stack = np.stack([
        np.full((4, 4, 3), 10.0, dtype=np.float32),
        np.full((4, 4, 3), 20.0, dtype=np.float32),
        np.full((4, 4, 3), 21.0, dtype=np.float32),
    ])
    reference = np.median(stack, axis=0)

    chosen = edge_utils.select_nearest(stack, reference)
    assert np.all(np.isin(chosen, [10.0, 20.0, 21.0]))
    assert np.allclose(chosen, 20.0)


def test_select_nearest_never_picks_the_outlier():
    """A neighbour that sampled a passer-by must not win, however confident."""
    good = np.full((4, 4, 3), 100.0, dtype=np.float32)
    stack = np.stack([good, good + 1.0, np.full((4, 4, 3), 250.0, dtype=np.float32)])
    reference = np.median(stack, axis=0)

    assert np.all(edge_utils.select_nearest(stack, reference) < 150.0)


def test_select_nearest_prefers_the_candidate_it_trusts_when_both_are_close():
    """
    Confidence breaks the tie, and only the tie: the two candidates here sit
    either side of the reference, and the one read from flat ground wins over
    the one read from beside an edge.
    """
    stack = np.stack([
        np.full((4, 4, 3), 98.0, dtype=np.float32),
        np.full((4, 4, 3), 103.0, dtype=np.float32),
    ])
    reference = np.full((4, 4, 3), 100.0, dtype=np.float32)
    trust_the_second = np.stack([
        np.full((4, 4), 0.2, dtype=np.float32),
        np.full((4, 4), 1.0, dtype=np.float32),
    ])

    assert np.allclose(edge_utils.select_nearest(stack, reference), 98.0)
    assert np.allclose(
        edge_utils.select_nearest(stack, reference, trust_the_second), 103.0)


def test_select_nearest_leaves_a_pixel_no_candidate_covered_as_nan():
    """NaN is how the engine is told to fall back for that pixel."""
    stack = np.full((2, 3, 3, 3), np.nan, dtype=np.float32)
    stack[0, 0, 0] = 50.0

    with warnings.catch_warnings():
        # Building the reference over an all-NaN pixel is the point of the
        # test; numpy's notice about it is not news.
        warnings.simplefilter('ignore', category=RuntimeWarning)
        reference = np.nanmedian(stack, axis=0)
    chosen = edge_utils.select_nearest(stack, reference)
    assert np.allclose(chosen[0, 0], 50.0)
    assert np.all(np.isnan(chosen[1:, 1:]))


def test_sharpen_alpha_narrows_the_ramp_where_an_edge_crosses_it():
    ramp = np.linspace(0, 1, 21, dtype=np.float32)[None, :].repeat(3, axis=0)
    edge = np.zeros_like(ramp)
    edge[1] = 1.0  # the middle row has a hard edge running through it

    sharpened = edge_utils.sharpen_alpha(ramp, edge, strength=3.0)

    flat_row, edge_row = sharpened[0], sharpened[1]
    assert np.allclose(flat_row, ramp)              # untouched where flat
    # The edge row crosses from 0 to 1 over fewer pixels than the flat one.
    span = lambda row: np.count_nonzero((row > 0.02) & (row < 0.98))
    assert span(edge_row) < span(flat_row)
    assert sharpened.min() >= 0.0 and sharpened.max() <= 1.0


def test_sharpen_alpha_keeps_the_ends_of_the_ramp_where_they_were():
    """
    The seam still has to reach 0 at the outer edge of the band and 1 over the
    selection: a ramp that started painting outside its band would put
    reconstructed pixels over untouched picture.
    """
    ramp = np.linspace(0, 1, 21, dtype=np.float32)[None, :]
    sharpened = edge_utils.sharpen_alpha(ramp, np.ones_like(ramp), strength=4.0)

    assert sharpened[0, 0] == pytest.approx(0.0)
    assert sharpened[0, -1] == pytest.approx(1.0)
    assert np.all(np.diff(sharpened[0]) >= -1e-6)  # still monotonic


def test_sharpen_alpha_at_zero_strength_is_the_ramp_it_was_given():
    ramp = np.linspace(0, 1, 11, dtype=np.float32)[None, :]
    assert np.array_equal(
        edge_utils.sharpen_alpha(ramp, np.ones_like(ramp), strength=0.0), ramp)


# ─── the robust fit ──────────────────────────────────────────────────────────

def test_the_robust_fit_is_not_dragged_by_vectors_the_plain_one_follows():
    """
    The single largest quality win in the engine. A handful of wild vectors —
    what an estimator produces where the brightness steps — pull a
    least-squares fit off the motion everything else agrees on, and the fit is
    then extrapolated across the whole selection. Holding them down is the
    difference between recovering the background and smearing it.
    """
    flow = np.zeros((60, 80, 2), dtype=np.float32)
    flow[..., 0] = -4.0
    flow[..., 1] = 2.0
    flow[10:14, 10:14, 0] = 60.0   # a small patch of nonsense
    flow[10:14, 10:14, 1] = -40.0
    ring = np.ones((60, 80), dtype=bool)

    plain = temporal_core.fit_affine_flow(flow, ring)
    robust = temporal_core.fit_affine_flow(flow, ring, robust=True)

    assert abs(robust[0, 2] - (-4.0)) < abs(plain[0, 2] - (-4.0))
    assert abs(robust[1, 2] - 2.0) < abs(plain[1, 2] - 2.0)
    assert robust[0, 2] == pytest.approx(-4.0, abs=0.5)
    assert robust[1, 2] == pytest.approx(2.0, abs=0.5)


def test_the_robust_fit_agrees_with_the_plain_one_on_clean_flow():
    """It corrects a fit that was dragged; it does not move one that was right."""
    ys, xs = np.mgrid[0:60, 0:80].astype(np.float32)
    flow = np.stack([0.05 * xs - 3.0, 0.05 * ys + 1.0], axis=-1)
    ring = np.ones((60, 80), dtype=bool)

    plain = temporal_core.fit_affine_flow(flow, ring)
    robust = temporal_core.fit_affine_flow(flow, ring, robust=True)
    assert np.allclose(plain, robust, atol=1e-3)


def test_the_robust_fit_still_answers_with_too_little_ring_to_fit_on():
    """The edge-of-frame case must not become a crash on the robust path."""
    flow = np.zeros((60, 80, 2), dtype=np.float32)
    flow[..., 0] = 3.0
    ring = np.zeros((60, 80), dtype=bool)
    ring[0, :10] = True

    matrix = temporal_core.fit_affine_flow(flow, ring, robust=True)
    assert matrix[0, 2] == pytest.approx(3.0)


# ─── the engine, on edges ────────────────────────────────────────────────────

def test_a_caption_is_reconstructed_far_better_than_the_flow_only_engine(
        caption, mask):
    """
    The headline result. Same scene, same walk, same neighbours — the only
    difference is the edge-aware work, and it is worth about 10dB.
    """
    new_psnr, new_ssim = _score(caption, _reconstruct(caption, mask, 'high'))
    old_psnr, old_ssim = _score(
        caption, _reconstruct(caption, mask, 'high', FLOW_ONLY))

    assert new_psnr > old_psnr + 5.0   # measured 36.9 against 26.1
    assert new_ssim > old_ssim
    assert new_psnr > 30.0
    assert new_ssim > 0.95


def test_the_reconstruction_keeps_the_detail_the_background_had(caption, mask):
    """
    "The repaired region is smoother than what surrounds it" stated as a
    number: the gradient energy of the reconstruction against the gradient
    energy of the background it is standing in for. Below 1 is a patch that
    has been smoothed; the flow-only engine loses noticeably more of it.
    """
    truths = [caption.patch(caption.truth(i)) for i in FRAMES]
    wanted = float(np.mean([gradient_energy(t) for t in truths]))

    def retention(overrides):
        results = _reconstruct(caption, mask, 'high', overrides)
        got = float(np.mean([gradient_energy(caption.patch(r)) for r in results]))
        return got / wanted

    assert retention(None) == pytest.approx(1.0, abs=0.05)
    assert abs(retention(None) - 1.0) < abs(retention(FLOW_ONLY) - 1.0)


def test_a_black_and_white_boundary_comes_back_as_a_step_not_a_ramp(caption, mask):
    """
    The complaint in its most literal form. Across one of the white bars the
    background goes from 30 to 255 within a pixel or two; the reconstruction
    has to do the same, rather than easing across half the selection.
    """
    index = 13
    result = temporal_core.process_temporal(
        caption.frame(index), mask, ROI, caption.source(index), quality='high')

    x, y, w, h = ROI
    row = slice(y + h // 2, y + h // 2 + 1)
    truth_row = caption.truth(index)[row, x:x + w].astype(np.int16)
    result_row = result[row, x:x + w].astype(np.int16)

    steepest = lambda strip: int(np.abs(np.diff(strip[0, :, 0])).max())
    # The truth has a hard step in this strip; so must the reconstruction.
    assert steepest(truth_row) > 150
    assert steepest(result_row) > 0.8 * steepest(truth_row)


def _mean_error(caption, mask, quality, overrides=None) -> float:
    results = _reconstruct(caption, mask, quality, overrides)
    return float(np.mean([
        np.abs(caption.patch(r).astype(int)
               - caption.patch(caption.truth(i)).astype(int)).mean()
        for i, r in zip(FRAMES, results)]))


def test_balanced_now_handles_edges_at_least_as_well_as_the_old_high_did(
        caption, mask):
    """
    The acceptance bar for the middle setting: whatever the *old* top setting
    could do with an edge, the middle one should now do — and it should do it
    for less, or the dial has stopped meaning anything.

    It clears on all three measurements, not just the forgiving one. Full
    resolution flow is what buys that: `balanced` used to compute its flow at
    three-quarter scale, which saved about a millisecond a frame and cost most
    of the edge accuracy the rest of the setting is for.
    """
    new_psnr, new_ssim = _score(caption, _reconstruct(caption, mask, 'balanced'))
    bar_psnr, bar_ssim = _score(
        caption, _reconstruct(caption, mask, 'high', FLOW_ONLY))

    assert new_psnr >= bar_psnr           # measured 28.7 against 27.6
    assert new_ssim >= bar_ssim           # measured 0.979 against 0.975
    assert (_mean_error(caption, mask, 'balanced')
            <= _mean_error(caption, mask, 'high', FLOW_ONLY))


def test_high_still_beats_balanced_where_the_settings_actually_differ(
        caption, mask):
    """
    `balanced` gaining full-resolution flow brought it close enough to `high`
    that the two cannot be told apart on soft footage — see the tolerance in
    `test_temporal_core.test_quality_buys_accuracy`. On the footage this file
    is about they are still clearly ordered, which is what makes the top
    setting worth its extra time.
    """
    assert (_mean_error(caption, mask, 'high')
            < _mean_error(caption, mask, 'balanced'))


# ─── the settings themselves ─────────────────────────────────────────────────

def test_the_fast_setting_is_left_exactly_as_it_was():
    """
    `fast` exists for the preview, where the answer is wanted immediately. It
    opts out of all of this on purpose, and a preset edited by accident is the
    likeliest way for that to stop being true.
    """
    fast = temporal_core.quality_settings('fast')
    assert fast.fuse == 'mean'
    assert fast.edge_penalty == 0.0
    assert fast.robust_fit is False
    assert fast.edge_feather == 0.0


@pytest.mark.parametrize('name', ['balanced', 'high'])
def test_the_slower_settings_all_do_the_edge_work(name):
    settings = temporal_core.quality_settings(name)
    assert settings.fuse == 'nearest'
    assert settings.robust_fit is True
    assert settings.edge_penalty > 0.0
    assert settings.edge_feather > 0.0


def test_the_edge_work_gets_stronger_as_the_setting_gets_slower():
    balanced = temporal_core.quality_settings('balanced')
    high = temporal_core.quality_settings('high')
    assert balanced.edge_penalty < high.edge_penalty
    assert balanced.edge_feather < high.edge_feather
