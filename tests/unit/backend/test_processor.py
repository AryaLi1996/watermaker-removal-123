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
