"""
Speed and accuracy of temporal fill, recorded so a change can be compared
against what it used to do.

This is not part of the test run. Timings measured on a shared CI runner vary
by more than most real regressions do, so gating a merge on them would fail
honest changes and pass slow ones by luck. What it produces instead is a
record: seconds per frame and mean absolute error against the background the
mark was hiding, per quality, written to a JSON file that can be kept beside
the commit that produced it and diffed against the next one.

Run it deliberately:

    WATERMARK_BENCHMARK=1 backend/.venv/bin/python -m pytest \\
        tests/unit/backend/test_temporal_benchmark.py -s

The numbers only mean anything against numbers from the same machine.

The accuracy half *is* checked, because it does not depend on how fast the
machine is: a change that makes the reconstruction visibly worse fails here
even when it makes it faster, which is the trade this file exists to catch.
The bounds are deliberately loose — flow estimators differ between OpenCV
builds, and DIS may not be present at all — so they catch a broken
reconstruction rather than a slightly different one.
"""
import json
import os
import time

import numpy as np
import pytest

import temporal_core
from image_core import create_mask, process_inpaint

from test_temporal_core import ROI, SIZE, Pan

BENCHMARK_ENV = 'WATERMARK_BENCHMARK'

pytestmark = pytest.mark.skipif(
    os.environ.get(BENCHMARK_ENV, '') not in ('1', 'true', 'yes'),
    reason=f'benchmark run: set {BENCHMARK_ENV}=1',
)

# Enough frames for the per-frame cost to settle, few enough that the slowest
# quality still finishes in the time someone will wait for an answer.
BENCHMARK_FRAMES = 12
# The first frames of the clip have neighbours on one side only and are not
# representative of the cost of the rest.
FIRST_FRAME = 10

#: Where the record lands. Overridable so a CI job can collect it as an
#: artifact without writing into the working tree.
OUTPUT_PATH = os.environ.get(
    'WATERMARK_BENCHMARK_OUTPUT',
    os.path.join(os.path.dirname(__file__), '..', '..', '..', 'benchmarks.json'),
)

#: Mean absolute error, per quality, above which the reconstruction has
#: stopped working rather than merely changed. The single-frame fill scores
#: around 30 on this scene, so these are all "much better than not trying",
#: not "pixel-exact".
MAE_CEILING = {'fast': 20.0, 'balanced': 15.0, 'quality': 12.0}


def _measure(pan: Pan, mask: np.ndarray, quality: str) -> dict:
    """Time and score one quality over a run of frames."""
    errors = []
    started = time.perf_counter()
    for index in range(FIRST_FRAME, FIRST_FRAME + BENCHMARK_FRAMES):
        result = temporal_core.process_temporal(
            pan.frame(index), mask, ROI, pan.source(index), quality=quality)
        errors.append(pan.error(index, result))
    elapsed = time.perf_counter() - started

    return {
        'quality': quality,
        'frames': BENCHMARK_FRAMES,
        'seconds_total': round(elapsed, 3),
        'seconds_per_frame': round(elapsed / BENCHMARK_FRAMES, 4),
        'mae_mean': round(float(np.mean(errors)), 3),
        'mae_worst': round(float(np.max(errors)), 3),
    }


def test_record_speed_and_accuracy_per_quality():
    pan = Pan()
    mask = create_mask(*SIZE, *ROI)

    # What the engine is being compared against: the fill it falls back to.
    baseline_errors = [
        pan.error(index, process_inpaint(pan.frame(index), mask, radius=3, roi=ROI))
        for index in range(FIRST_FRAME, FIRST_FRAME + BENCHMARK_FRAMES)
    ]

    record = {
        'frames': BENCHMARK_FRAMES,
        'roi': list(ROI),
        'size': list(SIZE),
        'opencv': __import__('cv2').__version__,
        'has_dis': hasattr(__import__('cv2'), 'DISOpticalFlow_create'),
        'single_frame_mae': round(float(np.mean(baseline_errors)), 3),
        'qualities': [_measure(pan, mask, name)
                      for name in ('fast', 'balanced', 'quality')],
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write('\n')

    # -s puts this in front of whoever ran it; the file is for the next run.
    print(f'\ntemporal benchmark → {os.path.abspath(OUTPUT_PATH)}')
    for entry in record['qualities']:
        print(f"  {entry['quality']:<9} {entry['seconds_per_frame']:>7.4f} s/frame"
              f"   MAE {entry['mae_mean']:>6.2f}"
              f"  (single-frame {record['single_frame_mae']:.2f})")

    for entry in record['qualities']:
        name = entry['quality']
        assert entry['mae_mean'] < MAE_CEILING[name], (
            f"{name} reconstructs the pan worse than it used to: "
            f"MAE {entry['mae_mean']} over the {MAE_CEILING[name]} ceiling"
        )
        assert entry['mae_mean'] < record['single_frame_mae'], (
            f'{name} is no better than the single-frame fill it replaces'
        )
