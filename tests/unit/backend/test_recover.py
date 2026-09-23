"""
Unit tests for backend/recover.py — finding the mark without being told.

The scene here is the case the module exists for: a mark that sits in one
corner for a while and then moves to another, over footage that keeps moving
behind it. The tests ask what the user would ask — was it found, was it found
in both places, and was the stretch of frames between the two positions left
with a watermark on it — rather than whether any particular intermediate
number came out.
"""
import cv2
import numpy as np
import pytest

import dewatermark
import recover
from recover import Candidate, Placement

WIDTH, HEIGHT = 320, 240
MARK = (96, 40)
MOVE_AT = 180
TOP_LEFT = (12, 10)
BOTTOM_RIGHT = (WIDTH - MARK[0] - 12, HEIGHT - MARK[1] - 10)


def _mark() -> tuple[np.ndarray, np.ndarray]:
    """Thin bright strokes with a soft rim, the way the real ones are drawn."""
    w, h = MARK
    strokes = np.zeros((h, w), np.uint8)
    cv2.putText(strokes, 'MARK', (4, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 225, 2)
    cv2.line(strokes, (4, 34), (w - 8, 34), 150, 2)
    alpha = cv2.GaussianBlur(strokes.astype(np.float32) / 255.0, (3, 3), 0.7)
    return alpha, np.full((h, w, 3), 250.0, np.float32)


class Clip:
    """A moving picture with a mark that changes corner part-way through."""

    # How far the picture travels between frames. It matters more than it
    # looks: the scan's whole premise is that the mark holds still while the
    # picture does not, so a backdrop that creeps a pixel a frame is one whose
    # own texture is nearly as persistent as a watermark. Real footage — even a
    # locked-off shot of something alive — moves much more than that.
    SPEED = 4

    def __init__(self, frames: int = 360, move_at: int = MOVE_AT):
        self.count = frames
        self.move_at = move_at
        self.alpha, self.colour = _mark()
        rng = np.random.default_rng(7)
        # A backdrop wide enough to pan across, with enough going on that a
        # window of it has no business looking persistent.
        self.scene = np.zeros(
            (HEIGHT + 40, WIDTH + self.SPEED * frames + 40, 3), np.uint8)
        self.scene[..., 0] = np.linspace(
            30, 220, self.scene.shape[1], dtype=np.float32)[None, :]
        self.scene[..., 2] = np.linspace(
            210, 35, self.scene.shape[0], dtype=np.float32)[:, None]
        for _ in range(900):
            centre = (int(rng.integers(0, self.scene.shape[1])),
                      int(rng.integers(0, self.scene.shape[0])))
            colour = tuple(int(v) for v in rng.integers(20, 235, 3))
            cv2.circle(self.scene, centre, int(rng.integers(4, 22)), colour, -1)
        self.scene = cv2.GaussianBlur(self.scene, (5, 5), 0)

    def corner(self, index: int) -> tuple[int, int]:
        return TOP_LEFT if index < self.move_at else BOTTOM_RIGHT

    def truth(self, index: int) -> np.ndarray:
        left = self.SPEED * index
        return np.ascontiguousarray(
            self.scene[20:20 + HEIGHT, left:left + WIDTH])

    def frame(self, index: int) -> np.ndarray:
        x, y = self.corner(index)
        w, h = MARK
        frame = self.truth(index).astype(np.float32)
        a = self.alpha[..., None]
        frame[y:y + h, x:x + w] = (1 - a) * frame[y:y + h, x:x + w] + a * self.colour
        return np.clip(frame, 0, 255).astype(np.uint8)

    def read(self, index: int) -> np.ndarray:
        return self.frame(index)


@pytest.fixture(scope='module')
def clip() -> Clip:
    return Clip()


# A box a user would drag: around what they can see of the first mark, and a
# little tighter than the mark really is.
USER_BOX = (TOP_LEFT[0] + 4, TOP_LEFT[1] + 4, MARK[0] - 10, MARK[1] - 8)


@pytest.fixture(scope='module')
def located(clip: Clip) -> list[tuple]:
    return recover.locate(clip.read, clip.count, USER_BOX, WIDTH, HEIGHT)


@pytest.fixture(scope='module')
def placements(located) -> list[Placement]:
    return [placement for placement, _ in located]


def _ink(clip) -> tuple[int, int, int, int]:
    """
    The part of the mark that is actually on the picture, relative to its
    corner.

    Not the nominal rectangle: the strokes are drawn inside it with several
    rows of nothing above and below, and those rows have no opacity to find. A
    detection that stops where the ink does has not clipped the mark — it has
    measured it — so that is what the box has to cover.
    """
    on = clip.alpha > 0.05
    rows = np.flatnonzero(on.any(axis=1))
    cols = np.flatnonzero(on.any(axis=0))
    return (int(cols[0]), int(rows[0]),
            int(cols[-1] - cols[0]) + 1, int(rows[-1] - rows[0]) + 1)


def _mark_at(clip, corner) -> tuple[int, int, int, int]:
    x, y = corner
    ix, iy, iw, ih = _ink(clip)
    return (x + ix, y + iy, iw, ih)


def _contains(outer, inner) -> bool:
    ox, oy, ow, oh = outer
    ix, iy, iw, ih = inner
    return (ox <= ix and oy <= iy
            and ox + ow >= ix + iw and oy + oh >= iy + ih)


# ─── What the scan finds ────────────────────────────────────────────────────

def test_scan_finds_the_mark_in_both_corners(clip, placements):
    """The mark moves once, so there are two places it is ever in."""
    corners = set()
    for placement in placements:
        x, y, w, h = placement.box
        corners.add('top' if y < HEIGHT // 2 else 'bottom')
    assert corners == {'top', 'bottom'}, placements


def test_scan_covers_the_mark_wherever_it_is(clip, placements):
    """
    Every frame's mark is inside some placement that is live on that frame.

    This is the test that matters: a frame whose mark no placement covers is a
    frame the user still sees a watermark on, and a scan that finds the mark
    twice but drops the seconds around the move has not solved their problem.
    """
    for index in range(0, clip.count, 7):
        want = _mark_at(clip, clip.corner(index))
        live = [p for p in placements if p.start <= index < p.end]
        assert any(_contains(p.box, want) for p in live), (
            f'frame {index} at {want} covered by {live}')


def test_scan_boxes_reach_past_the_users_box(clip, placements):
    """
    The detection is the mark's own extent, not the box it was seeded from.

    A user draws around what they can see; the rim and shadow go further, and a
    box that stops where the eye does leaves an outline behind.
    """
    top = next(p for p in placements if p.box[1] < HEIGHT // 2)
    assert _contains(top.box, _mark_at(clip, TOP_LEFT)), top.box
    assert top.box[2] > USER_BOX[2] and top.box[3] > USER_BOX[3], (
        f'{top.box} is no bigger than the box it was seeded from {USER_BOX}')


def test_only_the_real_marks_survive_the_solve(clip, placements):
    """
    Textured footage gives the scan more things that hold still than there are
    marks. What decides is the solve: a proposal it finds no opacity in is
    dropped, so what comes out of `locate` is the two real ones and nothing
    else.
    """
    assert len(recover.scan(clip.read, clip.count, USER_BOX, WIDTH, HEIGHT)) > len(placements)
    for placement in placements:
        corner = TOP_LEFT if placement.box[1] < HEIGHT // 2 else BOTTOM_RIGHT
        assert _contains(placement.box, _mark_at(clip, corner)), placement


def test_scan_survives_frames_it_cannot_read(clip):
    """A frame that will not decode is skipped, not fatal."""
    def flaky(index):
        return None if index % 5 == 0 else clip.read(index)

    roi = (TOP_LEFT[0], TOP_LEFT[1], MARK[0], MARK[1])
    assert recover.scan(flaky, clip.count, roi, WIDTH, HEIGHT)


# ─── Telling a mark from a picture ──────────────────────────────────────────

def test_a_solved_mark_is_believable(located):
    assert located and all(recover.believable(model) for _, model in located)


def test_picture_with_no_mark_on_it_is_not_believable(clip):
    """
    A box over footage that simply has no mark in it must come back as nothing
    to remove — otherwise the divide runs over pixels that are the picture.
    """
    frames = np.stack([clip.truth(i)[60:140, 120:230] for i in range(0, 120, 10)])
    model = dewatermark.fit(frames.astype(np.float32), (0, 0, 110, 80))
    assert not recover.believable(model)


# ─── The pieces, on their own ───────────────────────────────────────────────

def test_windows_cover_everything_without_a_stub():
    bounds = recover.windows(205, size=60)
    assert bounds[0][0] == 0 and bounds[-1][1] == 205
    assert all(a[1] == b[0] for a, b in zip(bounds, bounds[1:]))
    # The remainder joins the last window rather than becoming one of its own.
    assert bounds[-1][1] - bounds[-1][0] >= 60


def test_windows_of_a_short_clip_is_one_window():
    assert recover.windows(40, size=60) == [(0, 40)]


def test_sample_indices_spread_over_the_span():
    assert recover.sample_indices(0, 100, 5) == [0, 25, 50, 74, 99]
    assert recover.sample_indices(10, 14, 9) == [10, 11, 12, 13]
    assert recover.sample_indices(5, 5, 4) == []


def test_close_gaps_hands_a_short_hole_to_its_neighbours():
    closed = recover.close_gaps(
        [Placement(60, 120, (0, 0, 10, 10)), Placement(180, 240, (50, 50, 10, 10))],
        300, window=60,
    )
    assert closed[0].start == 0, 'the run before the first detection is its own'
    assert closed[-1].end == 300, 'and the run after the last one likewise'
    assert closed[0].end == closed[1].start, 'the hole between them is shared out'


def test_close_gaps_leaves_a_long_absence_alone():
    """A mark that is genuinely gone for ten seconds should stay gone."""
    closed = recover.close_gaps(
        [Placement(0, 60, (0, 0, 10, 10)), Placement(600, 660, (0, 0, 10, 10))],
        660, window=60,
    )
    assert closed[0].end == 60 and closed[1].start == 600


def test_schedule_gives_each_frame_exactly_one_run():
    """
    Overlapping placements must not become two jobs over the same frame: both
    would repaint the same file, and in a worker pool that is a race.
    """
    placements = [Placement(0, 180, (0, 0, 10, 10)), Placement(120, 300, (5, 5, 10, 10))]
    runs = recover.schedule(placements, ['a', 'b'], 300)

    seen: dict[int, int] = {}
    for start, end, models in runs:
        for index in range(start, end):
            seen[index] = seen.get(index, 0) + 1
    assert set(seen) == set(range(300))
    assert set(seen.values()) == {1}

    overlap = next(models for start, end, models in runs if start <= 150 < end)
    assert overlap == ('a', 'b'), 'a frame under both marks needs both models'


def test_schedule_skips_frames_no_placement_covers():
    runs = recover.schedule([Placement(100, 200, (0, 0, 10, 10))], ['a'], 300)
    covered = {i for start, end, _ in runs for i in range(start, end)}
    assert covered == set(range(100, 200))


def _one_bright_patch() -> np.ndarray:
    """A map with a single mark-sized thing in it, small enough that even the
    lowest of the scan's cuts falls below it rather than on it."""
    magnitude = np.zeros((240, 320), np.float32)
    magnitude[100:120, 140:190] = 40.0
    return magnitude


def test_candidates_drops_near_duplicates():
    """The same thing found at four percentiles is one candidate, not four."""
    found = recover.candidates(_one_bright_patch())
    assert len(found) == 1, found


def test_blobs_ignore_something_the_size_of_the_picture():
    """A mark is a mark; a whole frame that holds still is the footage."""
    magnitude = np.full((120, 160), 40.0, np.float32)
    assert recover._blobs_at(magnitude, 10.0) == []


def test_clamp_box_stays_inside_the_frame():
    assert recover.clamp_box((2, 2, 20, 20), 30, 30, pad=5) == (0, 0, 27, 27)


def test_candidate_carries_its_strength():
    found = recover.candidates(_one_bright_patch())
    assert isinstance(found[0], Candidate) and found[0].strength > 0


# ─── Through the pipeline ───────────────────────────────────────────────────

def test_run_batch_takes_the_mark_off_the_frames(clip, tmp_path):
    """
    End to end through the worker: frames on disk in, frames on disk out, with
    the mark gone from both of the places it was in and the picture behind it
    close to what was really filmed.

    Scored the way the user does — how much of the mark is still legible —
    rather than by an intermediate the engine controls.
    """
    import processor

    # Every frame. Subsampling is not free here: the scan's windows are counted
    # in frames, so taking every other one halves how many windows the clip has,
    # and a clip of three windows is one the scan has to find the mark, the move
    # and the mark again inside. That is a real limit on very short clips — the
    # module says so — and not what this test is for.
    sources = list(range(clip.count))
    paths = []
    for position, index in enumerate(sources):
        path = tmp_path / f'f{position:05d}.png'
        cv2.imwrite(str(path), clip.frame(index))
        paths.append(str(path))

    config = {'method': 'recover', 'roi': dict(zip('xywh', USER_BOX))}
    assert processor.run_batch(paths, config, WIDTH, HEIGHT) == 0

    def legibility(get) -> float:
        scores = []
        for position, index in enumerate(sources):
            x, y = clip.corner(index)
            w, h = MARK
            patch = cv2.cvtColor(get(position)[y:y + h, x:x + w],
                                 cv2.COLOR_BGR2GRAY).astype(np.float32)
            detail = patch - cv2.medianBlur(patch.astype(np.uint8), 21).astype(np.float32)
            detail -= detail.mean()
            shape = clip.alpha - clip.alpha.mean()
            size = np.linalg.norm(detail) * np.linalg.norm(shape)
            if size > 1e-6:
                scores.append(float((detail * shape).sum() / size))
        return float(np.mean(scores))

    before = legibility(lambda position: clip.frame(sources[position]))
    after = legibility(lambda position: cv2.imread(paths[position]))
    assert before > 0.4, f'the mark should be plain to start with, got {before:.3f}'
    assert after < before / 4, f'mark still legible at {after:.3f} (was {before:.3f})'


def test_run_batch_leaves_a_clip_with_no_mark_alone(clip, tmp_path):
    """
    Footage the scan finds nothing in falls back to solving the user's box, and
    a box with no mark in it solves to nothing — so the frames come back as
    they went in rather than mangled.
    """
    import processor

    paths = []
    for position in range(0, 40):
        path = tmp_path / f'f{position:05d}.png'
        cv2.imwrite(str(path), clip.truth(position * 3))
        paths.append(str(path))
    before = [cv2.imread(path) for path in paths]

    config = {'method': 'recover', 'roi': {'x': 120, 'y': 60, 'w': 110, 'h': 80}}
    processor.run_batch(paths, config, WIDTH, HEIGHT)

    for path, original in zip(paths, before):
        difference = np.abs(cv2.imread(path).astype(np.float32)
                            - original.astype(np.float32)).mean()
        assert difference < 2.0, f'{path} moved by {difference:.2f} levels'


def test_run_batch_leaves_a_single_frame_alone(clip, tmp_path):
    """
    The still the app shows when a video opens is one frame, and a blend cannot
    be solved from one frame — `dewatermark.solve` refuses outright. So the
    frame comes back untouched rather than the job failing, which is what it
    did before this was guarded.
    """
    import processor

    path = tmp_path / 'f00000.png'
    cv2.imwrite(str(path), clip.frame(0))
    before = cv2.imread(str(path))

    config = {'method': 'recover', 'roi': dict(zip('xywh', USER_BOX))}
    assert processor.run_batch([str(path)], config, WIDTH, HEIGHT) == 0
    assert np.array_equal(cv2.imread(str(path)), before)


# ─── Confirmed regions ──────────────────────────────────────────────────────

def test_run_batch_runs_the_regions_it_is_given(clip, tmp_path):
    """
    A confirmed region is not re-litigated. It came from a list the user was
    shown and agreed with, so it runs as given — and the mark inside it goes.
    """
    import processor

    sources = list(range(clip.count))
    paths = []
    for position, index in enumerate(sources):
        path = tmp_path / f'f{position:05d}.png'
        cv2.imwrite(str(path), clip.frame(index))
        paths.append(str(path))

    config = {
        'method': 'recover',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},   # deliberately useless
        'regions': [
            {**dict(zip('xywh', (TOP_LEFT[0], TOP_LEFT[1], *MARK))),
             'start': 0, 'end': clip.move_at},
            {**dict(zip('xywh', (BOTTOM_RIGHT[0], BOTTOM_RIGHT[1], *MARK))),
             'start': clip.move_at, 'end': clip.count},
        ],
    }
    assert processor.run_batch(paths, config, WIDTH, HEIGHT) == 0

    shape = clip.alpha - clip.alpha.mean()
    for index in (clip.move_at // 2, clip.move_at + 40):
        x, y = clip.corner(index)
        w, h = MARK
        patch = cv2.cvtColor(cv2.imread(paths[index])[y:y + h, x:x + w],
                             cv2.COLOR_BGR2GRAY).astype(np.float32)
        detail = patch - cv2.medianBlur(patch.astype(np.uint8), 21).astype(np.float32)
        detail -= detail.mean()
        size = np.linalg.norm(detail) * np.linalg.norm(shape)
        legible = float((detail * shape).sum() / size) if size > 1e-6 else 0.0
        assert legible < 0.25, f'frame {index} still shows the mark at {legible:.3f}'


def test_a_confirmed_region_with_no_mark_in_it_is_left_alone(clip, tmp_path):
    """
    The user can point at anything. Where the solve finds no blend, the frames
    come back as they were rather than divided by an opacity that is not there.
    """
    import processor

    paths = []
    for position in range(60):
        path = tmp_path / f'f{position:05d}.png'
        cv2.imwrite(str(path), clip.truth(position))
        paths.append(str(path))
    before = [cv2.imread(path) for path in paths]

    config = {'method': 'recover', 'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
              'regions': [{'x': 120, 'y': 60, 'w': 110, 'h': 80,
                           'start': 0, 'end': 60}]}
    processor.run_batch(paths, config, WIDTH, HEIGHT)

    for path, original in zip(paths, before):
        moved = np.abs(cv2.imread(path).astype(np.float32)
                       - original.astype(np.float32)).mean()
        assert moved < 2.0, f'{path} moved by {moved:.2f} levels'


# ─── The filler that is not on this machine ─────────────────────────────────

def _frames_on_disk(clip, tmp_path, count):
    tmp_path.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(count):
        path = tmp_path / f'f{index:05d}.png'
        cv2.imwrite(str(path), clip.frame(index))
        paths.append(str(path))
    return paths


def _painting_service(colour):
    """A stand-in that paints the masked pixels, so they can be recognised."""
    import base64
    import json

    import cloud_fill

    def post(url, body, token, timeout):
        payload = json.loads(body.decode())
        mask = cv2.imdecode(
            np.frombuffer(base64.b64decode(payload['mask_png']), np.uint8),
            cv2.IMREAD_GRAYSCALE)
        answered = []
        for blob in payload['frames_webp']:
            patch = cloud_fill.decode_patch(blob, mask.shape).copy()
            patch[mask > 0] = colour
            answered.append(cloud_fill.encode_patch(patch))
        return json.dumps({'frames_webp': answered}).encode()

    return post


def _region_config(clip, endpoint=None, frames=None):
    config = {
        'method': 'recover',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'regions': [{**dict(zip('xywh', (TOP_LEFT[0], TOP_LEFT[1], *MARK))),
                     'start': 0,
                     'end': min(clip.move_at, frames) if frames else clip.move_at}],
    }
    if endpoint:
        config['cloudFill'] = endpoint
    return config


def test_the_service_fills_the_pixels_the_arithmetic_could_not(clip, tmp_path, monkeypatch):
    """
    What comes back from the service is what ends up in the frame — in the
    pixels beyond recovery, and only there.
    """
    import cloud_fill
    import processor

    count = 120
    local_paths = _frames_on_disk(clip, tmp_path / 'local', count)
    cloud_paths = _frames_on_disk(clip, tmp_path / 'cloud', count)

    processor.run_batch(local_paths, _region_config(clip, frames=count), WIDTH, HEIGHT)

    magenta = (255, 0, 255)
    monkeypatch.setattr(cloud_fill, 'post', _painting_service(magenta))
    processor.run_batch(
        cloud_paths,
        _region_config(clip, {'url': 'https://fill.example.com/inpaint'}, frames=count),
        WIDTH, HEIGHT)

    model = recover.fit_placement(
        clip.read, recover.Placement(0, count, (*TOP_LEFT, *MARK)))
    core = model.unrecoverable > 0
    assert core.any(), 'this mark should have pixels beyond recovery'

    x, y = TOP_LEFT
    w, h = MARK
    local = cv2.imread(local_paths[10])[y:y + h, x:x + w]
    cloud = cv2.imread(cloud_paths[10])[y:y + h, x:x + w]

    # Where nothing had to be invented, both fillers leave the same picture.
    outside = ~(dewatermark.reachable_mask(model) > 0)
    assert np.abs(local[outside].astype(int) - cloud[outside].astype(int)).mean() < 2.0

    # Where it did, the service's answer is the one that is there.
    towards_magenta = np.array(magenta) - local[core].mean(axis=0)
    moved = cloud[core].mean(axis=0) - local[core].mean(axis=0)
    assert float(moved @ towards_magenta) > 0, 'the frame did not take the service colour'
    assert np.abs(cloud[core].astype(int) - np.array(magenta)).mean() < 40


def test_a_service_that_does_not_answer_leaves_a_finished_export(clip, tmp_path, monkeypatch):
    """
    Refused, timed out, nonsense back — all the same failure. The frames come
    out as the local filler would have made them, and the user is told how many.
    """
    import cloud_fill
    import processor

    count = 60
    local_paths = _frames_on_disk(clip, tmp_path / 'local', count)
    cloud_paths = _frames_on_disk(clip, tmp_path / 'cloud', count)

    processor.run_batch(local_paths, _region_config(clip, frames=count), WIDTH, HEIGHT)

    def refuse(url, body, token, timeout):
        raise OSError('connection refused')

    monkeypatch.setattr(cloud_fill, 'post', refuse)
    notices = []
    processor.run_batch(
        cloud_paths,
        _region_config(clip, {'url': 'https://fill.example.com/inpaint'}, frames=count),
        WIDTH, HEIGHT, on_notice=lambda key, detail: notices.append((key, detail)))

    for local_path, cloud_path in zip(local_paths, cloud_paths):
        assert np.array_equal(cv2.imread(local_path), cv2.imread(cloud_path)), (
            f'{cloud_path} is not what the local filler would have produced')

    assert any(key == 'cloud_fallback' for key, _ in notices), notices
    assert any(str(count) in detail for key, detail in notices if key == 'cloud_fallback')
