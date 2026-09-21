"""
Unit tests for backend/dewatermark.py — undoing a semi-transparent blend.

Unlike the inpainting engines, this one has a ground truth available: the
scenes here are composited from a known alpha and a known colour, so the tests
can ask the only question that matters — did the picture that was really there
come back — rather than whether the output merely looks plausible.
"""
import cv2
import numpy as np
import pytest

import dewatermark
from dewatermark import ALPHA_FLOOR, WatermarkModel

ROI = (40, 30, 96, 48)


def _scene(width: int = 2600, height: int = 200, seed: int = 5) -> np.ndarray:
    """A backdrop with enough variety to condition the solve."""
    rng = np.random.default_rng(seed)
    scene = np.zeros((height, width, 3), dtype=np.uint8)
    scene[..., 0] = np.linspace(20, 235, width, dtype=np.float32)[None, :]
    scene[..., 2] = np.linspace(200, 40, height, dtype=np.float32)[:, None]
    for _ in range(340):
        centre = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        colour = tuple(int(v) for v in rng.integers(20, 235, 3))
        cv2.circle(scene, centre, int(rng.integers(5, 26)), colour, -1)
    return cv2.GaussianBlur(scene, (5, 5), 0)


def _watermark(w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """
    A mark shaped like the real ones: thin strokes with soft edges, mostly
    white, with one tinted glyph that a single global colour cannot explain.
    """
    strokes = np.zeros((h, w), np.uint8)
    cv2.putText(strokes, 'ABC', (6, h - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.8, 217, 2)
    cv2.line(strokes, (4, 8), (w - 30, 8), 128, 1)
    # The tinted glyph is deliberately left in the band the solve is expected to
    # recover: above the ceiling its colour would never be used, because those
    # pixels are filled rather than divided.
    cv2.circle(strokes, (w - 16, 16), 7, 165, -1)
    alpha = cv2.GaussianBlur(strokes.astype(np.float32) / 255.0, (3, 3), 0.7)

    colour = np.full((h, w, 3), 255.0, np.float32)
    colour[:26, w - 32:] = np.array([200.0, 60.0, 40.0], np.float32)  # tinted glyph
    return alpha, colour


class Marked:
    """A panning camera over `_scene`, with a fixed mark blended into it."""

    def __init__(self, roi=ROI, frames: int = 90, speed: int = 9):
        self.roi = roi
        self.scene = _scene()
        self.speed = speed
        self.count = frames
        self.width, self.height = 220, 120
        self.alpha, self.colour = _watermark(roi[2], roi[3])

    def truth(self, index: int) -> np.ndarray:
        left = 20 + self.speed * index
        return np.ascontiguousarray(
            self.scene[10:10 + self.height, left:left + self.width])

    def frame(self, index: int) -> np.ndarray:
        x, y, w, h = self.roi
        frame = self.truth(index).astype(np.float32)
        patch = frame[y:y + h, x:x + w]
        a = self.alpha[..., None]
        frame[y:y + h, x:x + w] = (1 - a) * patch + a * self.colour
        return np.clip(frame, 0, 255).astype(np.uint8)

    def stack(self) -> np.ndarray:
        return np.stack([self.frame(i) for i in range(self.count)])


@pytest.fixture(scope='module')
def marked() -> Marked:
    return Marked()


@pytest.fixture(scope='module')
def model(marked: Marked) -> WatermarkModel:
    return dewatermark.fit(marked.stack().astype(np.float32), marked.roi, iterations=4)


def test_solve_recovers_the_alpha_matte(marked, model):
    """The solved opacity should be the one that was composited in."""
    inside = marked.alpha > 0.2
    error = np.abs(model.alpha - marked.alpha)[inside].mean()
    assert error < 0.08, f'mean alpha error {error:.3f}'


def test_solve_leaves_untouched_pixels_alone(marked, model):
    """Nothing outside the mark should be claimed as part of it."""
    outside = marked.alpha < 0.01
    assert model.alpha[outside].max() < 0.2
    assert (model.alpha[outside] > ALPHA_FLOOR).mean() < 0.05


def _tinted(marked) -> np.ndarray:
    """Where the fixture's coloured glyph sits."""
    _, _, w, h = marked.roi
    where = np.zeros((h, w), bool)
    where[:26, w - 32:] = True
    return where & (marked.alpha > 0.5)


def test_solve_recovers_what_it_actually_subtracts(marked, model):
    """
    ``a`` and ``W`` only ever enter the blend as the product ``a * W``, and
    taken apart they are poorly determined — so that product, not either
    factor, is what a test can hold the solve to.
    """
    matted = model.alpha[..., None] * model.colour
    truth = marked.alpha[..., None] * marked.colour
    error = np.abs(matted - truth)[marked.alpha > 0.2].mean()
    assert error < 10, f'mean matted error {error:.1f} levels'


def test_a_tinted_glyph_does_not_collapse_its_own_opacity(marked, model):
    """
    Regression test. Solving ``a`` against a white-only colour explains a
    coloured glyph away by lowering its opacity instead of colouring it: the
    fixture's 0.63 came back as 0.13, and since every later step takes ``a`` as
    given, nothing downstream could recover from it. Alternating the two solves
    is what fixes it, so this guards the alternation.
    """
    strong = _tinted(marked)
    assert strong.any(), 'the fixture should place the glyph over opaque pixels'
    assert model.alpha[strong].mean() > 0.35

    matted = (model.alpha[..., None] * model.colour)[strong]
    truth = (marked.alpha[..., None] * marked.colour)[strong]
    white_only = (model.alpha[..., None] * 255.0)[strong]
    assert np.abs(matted - truth).mean() < np.abs(white_only - truth).mean()


def test_restore_brings_back_the_real_picture(marked, model):
    """
    The point of the whole module: the recovered pixels should be the ones that
    were filmed, not a plausible substitute.
    """
    x, y, w, h = marked.roi
    index = marked.count // 2
    restored = dewatermark.restore(marked.frame(index), model)
    truth = marked.truth(index)

    mark = marked.alpha > ALPHA_FLOOR
    recoverable = mark & (model.unrecoverable == 0)
    assert recoverable.sum() > 0.8 * mark.sum(), 'most of the mark should be recoverable'

    err_before = np.abs(marked.frame(index)[y:y + h, x:x + w].astype(np.float32)
                        - truth[y:y + h, x:x + w].astype(np.float32)).mean(2)
    err_after = np.abs(restored[y:y + h, x:x + w].astype(np.float32)
                       - truth[y:y + h, x:x + w].astype(np.float32)).mean(2)

    assert err_after[recoverable].mean() < err_before[recoverable].mean() / 8
    assert err_after[recoverable].mean() < 6, (
        'recovered pixels should land within the codec\'s own noise of the truth')


def test_restore_does_not_touch_the_rest_of_the_frame(marked, model):
    x, y, w, h = marked.roi
    frame = marked.frame(3)
    restored = dewatermark.restore(frame, model)
    untouched = np.ones(frame.shape[:2], bool)
    untouched[y:y + h, x:x + w] = False
    assert np.array_equal(restored[untouched], frame[untouched])


def test_only_a_little_has_to_be_invented(marked, model):
    """
    The visible block users complain about is a symptom of inventing a whole
    rectangle. Almost all of this mark should be recovered instead.
    """
    assert model.invented < 0.10
    assert model.coverage > 0.05


def test_model_reports_how_well_the_blend_fits(model):
    assert 0.0 <= model.residual < 9.0
    assert model.frames_fitted > 0


def test_solve_rejects_a_stack_it_cannot_fit():
    with pytest.raises(ValueError):
        dewatermark.solve(np.zeros((1, 8, 8, 3), np.float32))


def test_persistent_strokes_finds_what_holds_still(marked):
    """The seed mask should cover the mark and little else."""
    x, y, w, h = marked.roi
    mask = dewatermark.persistent_strokes(
        marked.stack()[:, y:y + h, x:x + w].astype(np.float32))
    assert mask[marked.alpha > 0.5].mean() > 0.9
