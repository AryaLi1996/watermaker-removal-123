"""
Unit tests for backend/processor.py — the multi-core frame batch.

Workers read and write real PNG files, so these tests use real files rather
than mocking the pool: that is the contract the pipeline depends on.
"""
import os

import cv2
import numpy as np
import pytest

import processor
import temporal_core


def _write_frames(directory: str, count: int, size=(240, 320)) -> list[str]:
    """
    Write `count` grey PNGs carrying a striped "watermark" where the ROI sits.

    The stripes matter: a blur over a uniform block returns the block
    unchanged, so a flat patch could not tell a processed frame from a
    skipped one.
    """
    os.makedirs(directory, exist_ok=True)
    paths = []
    for i in range(count):
        frame = np.full((*size, 3), 120, dtype=np.uint8)
        frame[10:40, 10:60] = 255
        frame[10:40:4, 10:60] = 0  # stripes, so a blur visibly changes pixels
        path = os.path.join(directory, f'frame_{i:06d}.png')
        cv2.imwrite(path, frame)
        paths.append(path)
    return paths


BLUR_CONFIG = {
    'method': 'blur',
    'roi': {'x': 10, 'y': 10, 'w': 50, 'h': 30},
    'kernelSize': 21,
}


def test_run_batch_rewrites_every_frame_in_place(tmp_path):
    paths = _write_frames(str(tmp_path / 'frames'), 8)
    before = [cv2.imread(p)[10:40, 10:60].copy() for p in paths]

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    for path, original in zip(paths, before):
        after = cv2.imread(path)[10:40, 10:60]
        assert not np.array_equal(after, original), f'{path} was not processed'


def test_run_batch_leaves_pixels_outside_the_roi_alone(tmp_path):
    paths = _write_frames(str(tmp_path / 'frames'), 4)
    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    untouched = cv2.imread(paths[0])[100:200, 100:300]
    assert np.all(untouched == 120)


def test_run_batch_reports_progress_from_zero_to_a_hundred(tmp_path):
    paths = _write_frames(str(tmp_path / 'frames'), 6)
    seen: list[float] = []

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240,
                        progress_callback=seen.append)

    assert len(seen) == len(paths)
    assert seen == sorted(seen)
    assert seen[-1] == pytest.approx(100.0)


def test_run_batch_surfaces_a_worker_failure(tmp_path):
    """A frame that cannot be read must fail the batch, not pass silently."""
    frames_dir = str(tmp_path / 'frames')
    paths = _write_frames(frames_dir, 2)
    broken = os.path.join(frames_dir, 'frame_000099.png')
    with open(broken, 'wb') as fh:
        fh.write(b'not a png')

    with pytest.raises(Exception):
        processor.run_batch(paths + [broken], BLUR_CONFIG, width=320, height=240)


@pytest.mark.parametrize('method,extra', [
    ('inpaint', {'radius': 3}),
    ('blur', {'kernelSize': 21}),
    ('solidFill', {'color': [255, 0, 0]}),
    ('cloneStamp', {'dx': 0, 'dy': 60}),
])
def test_run_batch_runs_every_engine(tmp_path, method, extra):
    paths = _write_frames(str(tmp_path / f'frames_{method}'), 2)
    config = {'method': method, 'roi': {'x': 10, 'y': 10, 'w': 50, 'h': 30}, **extra}

    processor.run_batch(paths, config, width=320, height=240)

    result = cv2.imread(paths[0])
    assert result.shape == (240, 320, 3)


def test_terminate_without_an_active_pool_is_a_no_op():
    processor.terminate()  # must not raise


def test_worker_processes_one_frame_on_disk(tmp_path):
    """
    The worker body runs inside pool subprocesses, so call it directly: it is
    the piece that reads, processes and writes each frame back.
    """
    paths = _write_frames(str(tmp_path / 'frames'), 1)
    before = cv2.imread(paths[0])[10:40, 10:60].copy()

    processor._process_single_frame((paths[0], BLUR_CONFIG, (320, 240, 10, 10, 50, 30)))

    assert not np.array_equal(cv2.imread(paths[0])[10:40, 10:60], before)


def test_worker_raises_on_an_unreadable_frame(tmp_path):
    broken = tmp_path / 'broken.png'
    broken.write_bytes(b'not a png')
    with pytest.raises(IOError):
        processor._process_single_frame((str(broken), BLUR_CONFIG, (320, 240, 10, 10, 50, 30)))


# ─── OpenCV thread budget ────────────────────────────────────────────────────
#
# Each pool worker runs OpenCV, which by default spawns threads up to the core
# count — so N workers each try to use N cores. Pinning them measured ~6%
# faster. The setting is applied before forking: calling into OpenCV's
# threading machinery *inside* a forked child deadlocks when the parent already
# has a warm thread pool, which is exactly what a full test run produces.

def test_thread_count_defaults_to_one_per_worker(monkeypatch):
    monkeypatch.delenv('WATERMARK_CV_THREADS', raising=False)
    assert processor.opencv_thread_count() == 1


def test_thread_count_honours_an_override(monkeypatch):
    monkeypatch.setenv('WATERMARK_CV_THREADS', '2')
    assert processor.opencv_thread_count() == 2


def test_zero_means_leave_opencv_alone(monkeypatch):
    monkeypatch.setenv('WATERMARK_CV_THREADS', '0')
    assert processor.opencv_thread_count() == 0


def test_a_nonsense_override_falls_back_to_one(monkeypatch):
    monkeypatch.setenv('WATERMARK_CV_THREADS', 'lots')
    assert processor.opencv_thread_count() == 1


def test_run_batch_restores_the_previous_thread_setting(tmp_path, monkeypatch):
    """The setting is global to the process, so a job must put it back."""
    monkeypatch.setenv('WATERMARK_CV_THREADS', '1')
    cv2.setNumThreads(3)

    paths = _write_frames(str(tmp_path / 'frames'), 2)
    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    assert cv2.getNumThreads() == 3


# ─── choosing between a pool and this process ────────────────────────────────
#
# The bar for using a pool is deliberately low. Measured over the 30 frames of
# a one-second preview on four cores, a pool took 1.2s against 4.2s in-process
# — and 1.4s with its workers started the slow way (spawn), which is how the
# packaged mac and Windows builds start them. Only a batch too small to repay
# starting the first worker is run here.

def _pool_spy(monkeypatch) -> list:
    """Record every worker pool the batch starts, without starting one."""
    started: list = []
    real_pool = processor.multiprocessing.Pool

    def spy(*args, **kwargs):
        started.append(kwargs.get('processes'))
        return real_pool(*args, **kwargs)

    monkeypatch.setattr(processor.multiprocessing, 'Pool', spy)
    return started


def test_a_tiny_batch_runs_without_starting_a_pool(tmp_path, monkeypatch):
    started = _pool_spy(monkeypatch)
    paths = _write_frames(str(tmp_path / 'frames'), processor.SEQUENTIAL_FRAME_LIMIT)

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    assert started == []
    assert all(cv2.imread(p) is not None for p in paths)


def test_a_preview_sized_batch_still_uses_every_core(tmp_path, monkeypatch):
    """The frames of a short preview are the same size as any other frame;
    there is nothing cheap about them to justify giving up the cores."""
    started = _pool_spy(monkeypatch)
    paths = _write_frames(str(tmp_path / 'frames'), 30)

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    assert started == [min(os.cpu_count() or 1, 30)]


def test_a_long_batch_still_uses_every_core(tmp_path, monkeypatch):
    started = _pool_spy(monkeypatch)
    count = processor.SEQUENTIAL_FRAME_LIMIT + 1
    paths = _write_frames(str(tmp_path / 'frames'), count)

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    assert started == [min(os.cpu_count() or 1, count)]


def test_a_pool_is_never_larger_than_the_work(tmp_path, monkeypatch):
    """Workers beyond one per frame only pay start-up costs to do nothing."""
    monkeypatch.setattr(processor.os, 'cpu_count', lambda: 64)
    started = _pool_spy(monkeypatch)
    count = processor.SEQUENTIAL_FRAME_LIMIT + 2
    paths = _write_frames(str(tmp_path / 'frames'), count)

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240)

    assert started == [count]


def test_an_empty_batch_does_nothing(tmp_path, monkeypatch):
    started = _pool_spy(monkeypatch)
    processor.run_batch([], BLUR_CONFIG, width=320, height=240,
                        progress_callback=lambda _: pytest.fail('no work to report'))
    assert started == []


def test_a_batch_run_in_process_reports_progress_the_same_way(tmp_path):
    paths = _write_frames(str(tmp_path / 'frames'), processor.SEQUENTIAL_FRAME_LIMIT)
    seen: list[float] = []

    processor.run_batch(paths, BLUR_CONFIG, width=320, height=240,
                        progress_callback=seen.append)

    assert len(seen) == len(paths)
    assert seen == sorted(seen)
    assert seen[-1] == pytest.approx(100.0)


# ─── temporal batches ────────────────────────────────────────────────────────
#
# The temporal engine is the one that reads frames other than the one it is
# writing, which is what these cover: that it gets the neighbours it asked
# for, that it never reads one another worker has already painted over, and
# that the frames it leaves behind are the ones the encoder picks up.

TEMPORAL_CONFIG = {
    'method': 'temporal',
    'roi': {'x': 10, 'y': 10, 'w': 50, 'h': 30},
    'radius': 3,
    'temporalQuality': 'fast',
}


def _write_pan(directory: str, count: int, speed: int = 12, size=(240, 320)) -> list[str]:
    """
    Frames of a scene panning under a static white mark — the case temporal
    inpainting exists for, and one where a frame is recognisably different
    from its neighbours.
    """
    os.makedirs(directory, exist_ok=True)
    height, width = size
    rng = np.random.default_rng(7)
    scene = np.zeros((height, width + speed * count, 3), dtype=np.uint8)
    scene[..., 0] = np.linspace(0, 255, scene.shape[1], dtype=np.float32)[None, :]
    for _ in range(120):
        centre = (int(rng.integers(0, scene.shape[1])), int(rng.integers(0, height)))
        colour = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.circle(scene, centre, int(rng.integers(5, 20)), colour, -1)

    paths = []
    for i in range(count):
        frame = np.ascontiguousarray(scene[:, speed * i:speed * i + width])
        frame[10:40, 10:60] = 250
        path = os.path.join(directory, f'frame_{i:06d}.png')
        cv2.imwrite(path, frame)
        paths.append(path)
    return paths


def test_a_temporal_batch_rewrites_every_frame_in_place(tmp_path):
    paths = _write_pan(str(tmp_path / 'frames'), 8)
    before = [cv2.imread(p)[10:40, 10:60].copy() for p in paths]

    processor.run_batch(paths, TEMPORAL_CONFIG, width=320, height=240)

    for path, original in zip(paths, before):
        after = cv2.imread(path)[10:40, 10:60]
        assert not np.array_equal(after, original), f'{path} was not processed'


def test_a_temporal_batch_leaves_no_working_directory_behind(tmp_path):
    paths = _write_pan(str(tmp_path / 'frames'), 6)
    processor.run_batch(paths, TEMPORAL_CONFIG, width=320, height=240)

    assert not os.path.exists(str(tmp_path / processor.TEMPORAL_OUTPUT_DIR))
    # And nothing beside the frames for ffmpeg's numbered pattern to trip on.
    assert sorted(os.listdir(str(tmp_path / 'frames'))) == sorted(
        os.path.basename(p) for p in paths)


def test_a_temporal_worker_reads_the_extracted_frames_not_the_processed_ones(
        tmp_path, monkeypatch):
    """
    Reconstructing frame N reads frames N±k. Painting over them as the batch
    goes would feed each frame the previous frame's output, which drifts and
    is invisible in the result — so the run is staged through a separate
    directory and committed at the end.
    """
    # One worker, so the batch runs in this process where the reads can be seen.
    monkeypatch.setattr(processor.os, 'cpu_count', lambda: 1)
    paths = _write_pan(str(tmp_path / 'frames'), 6)
    originals = {p: cv2.imread(p).copy() for p in paths}
    stale: list[str] = []

    real_imread = processor.cv2.imread

    def recording_imread(path, *args, **kwargs):
        frame = real_imread(path, *args, **kwargs)
        if path in originals and not np.array_equal(frame, originals[path]):
            stale.append(path)
        return frame

    monkeypatch.setattr(processor.cv2, 'imread', recording_imread)
    processor._neighbor_cache.clear()
    processor.run_batch(paths, TEMPORAL_CONFIG, width=320, height=240)

    assert not stale, f'a worker read frames that had been painted over: {stale}'
    # And the frames really were rewritten, so the check above meant something.
    assert any(not np.array_equal(cv2.imread(p), originals[p]) for p in paths)


def test_a_temporal_job_carries_the_neighbours_its_quality_can_reach(tmp_path):
    paths = [f'/frames/frame_{i:06d}.png' for i in range(40)]
    jobs = processor._temporal_jobs(paths, TEMPORAL_CONFIG, (320, 240, 10, 10, 50, 30), '/out')
    reach = temporal_core.quality_settings('fast').reach

    _, middle, _, _, _ = jobs[20]
    assert set(middle) == {o for o in range(-reach, reach + 1) if o != 0}
    assert middle[1] == paths[21]
    assert middle[-1] == paths[19]

    # The ends of the clip simply have fewer; a missing frame is not an error.
    _, first, _, _, _ = jobs[0]
    assert all(offset > 0 for offset in first)
    _, last, _, _, _ = jobs[-1]
    assert all(offset < 0 for offset in last)


def test_a_temporal_batch_reports_progress_frame_by_frame(tmp_path):
    paths = _write_pan(str(tmp_path / 'frames'), 6)
    seen: list[float] = []

    processor.run_batch(paths, TEMPORAL_CONFIG, width=320, height=240,
                        progress_callback=seen.append)

    assert len(seen) == len(paths)
    assert seen == sorted(seen)
    assert seen[-1] == pytest.approx(100.0)


def test_a_temporal_batch_goes_parallel_sooner_than_a_single_frame_one(tmp_path, monkeypatch):
    """One frame of temporal work costs more than starting the pool."""
    monkeypatch.setattr(processor.os, 'cpu_count', lambda: 4)
    started = _pool_spy(monkeypatch)
    paths = _write_pan(str(tmp_path / 'frames'), 2)

    processor.run_batch(paths, TEMPORAL_CONFIG, width=320, height=240)

    assert started == [2]


def test_the_neighbour_cache_serves_a_frame_without_reading_it_twice(tmp_path):
    paths = _write_pan(str(tmp_path / 'frames'), 2)
    processor._neighbor_cache.clear()

    first = processor._read_cached(paths[0])
    second = processor._read_cached(paths[0])

    assert second is first  # the same decoded array, not a second decode
    assert np.array_equal(first, cv2.imread(paths[0]))


def test_the_neighbour_cache_forgets_the_oldest_frame_first(tmp_path, monkeypatch):
    monkeypatch.setenv('WATERMARK_TEMPORAL_CACHE', '1')
    paths = _write_pan(str(tmp_path / 'frames'), 2)
    processor._neighbor_cache.clear()

    processor._read_cached(paths[0])
    processor._read_cached(paths[1])

    assert list(processor._neighbor_cache) == [paths[1]]


def test_the_neighbour_cache_can_be_turned_off(tmp_path, monkeypatch):
    monkeypatch.setenv('WATERMARK_TEMPORAL_CACHE', '0')
    paths = _write_pan(str(tmp_path / 'frames'), 1)
    processor._neighbor_cache.clear()

    assert processor._read_cached(paths[0]) is not None
    assert not processor._neighbor_cache
