"""
What the blend solver is worth, measured against a picture we know.

The other tests here composite a mark in memory and check the arithmetic. This
one asks the question a user asks — is the picture that comes back the picture
that was there — under the conditions that actually apply: the composite goes
through H.264 before the solver ever sees it, so the mark's edges arrive
smeared and quantised exactly as a downloaded clip's are, and the solver is
given no help beyond the frames.

It exists because the obvious way to score this is wrong. Comparing the output
against a template taken from the output itself agrees with itself on a blurred
or filled rectangle and disagrees with itself by four-fold on a solved one,
which makes it useless for the thing it was meant to judge. An error in levels
against the frames the composite was built from does not have that problem, and
it agrees with what the eye reports.

The assertions are ratios against the engines already in the tree, not absolute
levels: the point is to keep this honest as it improves, not to freeze a number
that depends on the encoder's mood.
"""
import os
import subprocess

import cv2
import numpy as np
import pytest

import dewatermark
from conftest import requires_ffmpeg_encoder

WIDTH, HEIGHT = 160, 72
FRAMES = 150
BOX = (8, 6, 144, 60)          # what a user would drag around the mark

# How fast the scene moves under the mark. It matters more than it looks:
# faster motion gets fewer bits from the encoder, so the frames the solve reads
# are noisier, and the opacity error runs 0.05 at one pixel a frame against
# 0.18 at four. The reported clip measures 0.04, so it sits at the calm end;
# this is set between the two rather than at either.
PAN = 2


def _clean_frames() -> np.ndarray:
    """A moving scene with the texture and the edges real footage has."""
    rng = np.random.default_rng(11)
    span = WIDTH + PAN * FRAMES
    scene = np.zeros((HEIGHT + 60, span, 3), np.uint8)
    scene[..., 0] = np.linspace(25, 225, span, dtype=np.float32)[None, :]
    scene[..., 1] = np.linspace(190, 45, HEIGHT + 60, dtype=np.float32)[:, None]
    for _ in range(400):
        cv2.circle(scene, (int(rng.integers(0, span)), int(rng.integers(0, HEIGHT + 60))),
                   int(rng.integers(4, 22)),
                   tuple(int(v) for v in rng.integers(15, 240, 3)), -1)
    scene = cv2.GaussianBlur(scene, (3, 3), 0)
    return np.stack([
        np.ascontiguousarray(scene[20:20 + HEIGHT, PAN * i:PAN * i + WIDTH])
        for i in range(FRAMES)
    ])


def _mark() -> tuple[np.ndarray, np.ndarray]:
    """Thin strokes with soft edges and one tinted glyph, as the real ones are."""
    strokes = np.zeros((HEIGHT, WIDTH), np.uint8)
    cv2.putText(strokes, 'demo', (14, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 215, 2)
    cv2.putText(strokes, '01234', (14, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.5, 180, 1)
    cv2.circle(strokes, (WIDTH - 24, 24), 8, 170, -1)
    alpha = cv2.GaussianBlur(strokes.astype(np.float32) / 255.0, (3, 3), 0.7)

    colour = np.full((HEIGHT, WIDTH, 3), 255.0, np.float32)
    colour[:38, WIDTH - 40:] = np.array([210.0, 70.0, 45.0], np.float32)
    return alpha, colour


def _roundtrip(frames: np.ndarray, path: str) -> np.ndarray:
    """Through H.264 and back, so the codec does to it what it does to a real clip."""
    encode = subprocess.Popen(
        ['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
         '-s', f'{WIDTH}x{HEIGHT}', '-r', '30', '-i', '-',
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', path],
        stdin=subprocess.PIPE)
    encode.communicate(np.ascontiguousarray(frames).tobytes())
    assert encode.returncode == 0

    decoded = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
        capture_output=True).stdout
    count = len(decoded) // (WIDTH * HEIGHT * 3)
    return np.frombuffer(decoded, np.uint8)[:count * WIDTH * HEIGHT * 3] \
        .reshape(count, HEIGHT, WIDTH, 3).copy()


pytestmark = requires_ffmpeg_encoder


@pytest.fixture(scope='module')
def bench(tmp_path_factory):
    """Marked footage, the clean footage it was made from, and the solved model."""
    out = tmp_path_factory.mktemp('dewatermark')
    clean = _clean_frames()
    alpha, colour = _mark()

    a3 = alpha[..., None]
    composited = np.clip((1 - a3)[None] * clean.astype(np.float32)
                         + a3[None] * colour[None], 0, 255).astype(np.uint8)

    marked = _roundtrip(composited, str(out / 'marked.mp4'))
    # The reference goes through the same encoder, so the codec's own cost is
    # not charged to whichever engine is being scored.
    reference = _roundtrip(clean, str(out / 'clean.mp4'))
    count = min(len(marked), len(reference))
    marked, reference = marked[:count], reference[:count]

    model = dewatermark.fit(marked.astype(np.float32), (0, 0, WIDTH, HEIGHT))
    return marked, reference, model, alpha


def _error_on_the_mark(rendered, reference, where) -> float:
    total = [np.abs(r.astype(np.float32) - t.astype(np.float32)).mean(2)[where]
             for r, t in zip(rendered, reference)]
    return float(np.concatenate(total).mean())


def _engines(model):
    x, y, w, h = BOX
    box = np.zeros((HEIGHT, WIDTH), np.uint8)
    box[y:y + h, x:x + w] = 1

    def blur(frame):
        out = frame.copy()
        out[y:y + h, x:x + w] = cv2.GaussianBlur(out[y:y + h, x:x + w], (51, 51), 0)
        return out

    return {
        'untouched': lambda frame: frame,
        'blur the box': blur,
        'fill the box': lambda frame: cv2.inpaint(frame, box, 4, cv2.INPAINT_TELEA),
        'unblend': lambda frame: dewatermark.restore(frame, model),
    }


@pytest.fixture(scope='module')
def scores(bench) -> dict:
    marked, reference, model, alpha = bench
    on_the_mark = alpha > dewatermark.ALPHA_FLOOR
    sampled = np.arange(0, len(marked), 3)
    return {
        name: _error_on_the_mark([run(marked[i]) for i in sampled],
                                 [reference[i] for i in sampled], on_the_mark)
        for name, run in _engines(model).items()
    }


def test_the_mark_really_is_in_the_way(scores):
    """Without it the benchmark would be measuring nothing."""
    assert scores['untouched'] > 25


def test_unblending_beats_painting_over_the_selection(scores):
    """
    Both engines in the tree today invent the whole rectangle. Recovering it
    should be worth a good deal more than that, or this module has no reason
    to exist.
    """
    painted = min(scores['blur the box'], scores['fill the box'])
    assert scores['unblend'] < painted / 1.6, (
        f'unblend {scores["unblend"]:.1f} vs best painted {painted:.1f} levels')


def test_most_of_the_mark_is_recovered_not_invented(bench):
    _, _, model, _ = bench
    assert model.invented < 0.05
    assert model.coverage > 0.05


def test_the_solver_finds_the_opacity_it_was_given(bench):
    """
    Blind: the solver sees an encoded video, not the matte it was built from.

    The bound is loose because the encoder sets it, not the arithmetic — see
    PAN. On the reported clip the same measurement reads 0.04.
    """
    _, _, model, alpha = bench
    on_the_mark = alpha > 0.2
    assert np.abs(model.alpha - alpha)[on_the_mark].mean() < 0.22


def test_how_far_from_the_truth_we_still_are(scores, bench):
    """
    Not a bar to clear but a record to move. The gap between what comes back
    and what the codec alone costs is what is still visible in the output, and
    it is why this is not yet finished.
    """
    _, _, model, _ = bench
    assert scores['unblend'] < scores['untouched'] / 2
    print(f'\n  levels of error on the mark: '
          + ', '.join(f'{k} {v:.1f}' for k, v in scores.items())
          + f'; invented {100 * model.invented:.1f}%')
