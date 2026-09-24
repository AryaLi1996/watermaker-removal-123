"""
That running a detect on four cores answers what running it on one does.

The survey has three phases and all three are now lists of independent jobs
handed to a pool: the windows it scans, the frames it gathers crops from, and
the placements it solves. Each of them is deterministic on its own — the solve
seeds OpenCV's RNG for exactly this reason — so the pool is a speed-up and
nothing else.

"And nothing else" is the whole claim, and it is not one the fast path can be
trusted to make about itself: a detect that quietly answered differently on a
four-core machine than on a one-core machine would look, to the person reading
the list, like the app having an opinion that changed. So these run the same
work both ways and compare.

The clip is deliberately the one test_survey.py uses, because it is the one
carrying a mark, a subtitle and a caption — the things the answer is made of.
"""
import os

import cv2
import numpy as np
import pytest

import processor
import recover
import survey

from test_survey import WIDTH, HEIGHT, WINDOW, Clip


@pytest.fixture(scope='module')
def clip() -> Clip:
    return Clip()


@pytest.fixture(scope='module')
def frames(clip: Clip, tmp_path_factory) -> list[str]:
    """The clip on disk, because the pools take paths and not a reader."""
    directory = tmp_path_factory.mktemp('parallel-survey')
    paths = []
    for index in range(clip.count):
        path = str(directory / f'frame_{index:06d}.png')
        cv2.imwrite(path, clip.read(index), [cv2.IMWRITE_PNG_COMPRESSION, 1])
        paths.append(path)
    return paths


def _seams(paths: list[str]) -> dict:
    return {
        'scan_all': lambda spans, scale: processor.scan_windows(paths, spans, scale),
        'gather_all': lambda boxes, lengths, wanted: processor.gather_crops(
            paths, boxes, lengths, wanted),
        'fit_all': processor.fit_placements,
    }


def _comparable(findings) -> list[tuple]:
    return [(f.box, f.start, f.end, f.kind, f.proposed,
             round(f.coverage, 9), round(f.stability, 9), round(f.peak_alpha, 9),
             f.windows) for f in findings]


def test_a_pooled_detect_answers_exactly_what_a_serial_one_does(clip, frames):
    here = survey.survey(clip.read, clip.count, WIDTH, HEIGHT, window=WINDOW)
    pooled = survey.survey(clip.read, clip.count, WIDTH, HEIGHT, window=WINDOW,
                           **_seams(frames))
    assert _comparable(pooled) == _comparable(here)
    # And it actually found something, so the comparison is not two empties.
    assert here, 'the survey found nothing; this test would pass on anything'


def test_the_windows_scanned_in_a_pool_are_the_windows_scanned_here(clip, frames):
    scale = recover._scale_for(WIDTH, HEIGHT)
    spans = list(recover.windows(clip.count, WINDOW))
    here = [recover.window_magnitude(clip.read, start, end, scale)
            for start, end in spans]
    pooled = processor.scan_windows(frames, spans, scale)

    assert len(pooled) == len(here)
    for index, (one, other) in enumerate(zip(here, pooled)):
        assert (one is None) == (other is None), f'window {index}'
        if one is not None:
            assert np.array_equal(one, other), f'window {index}'


def test_the_crops_gathered_in_a_pool_are_the_crops_gathered_here(clip, frames):
    placements = [recover.Placement(0, clip.count, (10, 8, 92, 38)),
                  recover.Placement(20, clip.count - 20, (70, 180, 180, 26)),
                  recover.Placement(0, clip.count // 2, (5, 5, 40, 40))]
    here = survey._crops_for(clip.read, placements)
    pooled = survey._crops_for(
        clip.read, placements,
        gather_all=lambda boxes, lengths, wanted: processor.gather_crops(
            frames, boxes, lengths, wanted))

    assert [len(one) for one in pooled] == [len(one) for one in here]
    for slot, (ours, theirs) in enumerate(zip(here, pooled)):
        for position, (one, other) in enumerate(zip(ours, theirs)):
            assert np.array_equal(one, other), f'placement {slot}, crop {position}'


def test_the_models_solved_in_a_pool_are_the_models_solved_here(clip, frames):
    placements = [recover.Placement(0, clip.count, (10, 8, 92, 38)),
                  recover.Placement(0, clip.count, (70, 180, 180, 26)),
                  recover.Placement(0, clip.count // 2, (10, 8, 92, 38)),
                  recover.Placement(0, clip.count, (12, 10, 88, 34)),
                  recover.Placement(0, clip.count, (8, 6, 96, 42))]
    crops = survey._crops_for(clip.read, placements)
    jobs = list(zip(crops, placements))

    here = survey._fit_here(jobs, clip.read)
    pooled = processor.fit_placements(jobs)

    assert len(pooled) == len(here)
    for index, (one, other) in enumerate(zip(here, pooled)):
        assert (one is None) == (other is None), f'placement {index}'
        if one is not None:
            assert np.array_equal(one.alpha, other.alpha), f'placement {index}'
            assert np.array_equal(one.colour, other.colour), f'placement {index}'
            assert one.residual == pytest.approx(other.residual), f'placement {index}'
            assert one.roi == other.roi


def test_a_placement_with_no_frames_comes_back_as_nothing_not_an_exception():
    # It used to raise IOError and the survey caught it. Across a process
    # boundary an exception is the pool's problem, not the caller's, so the
    # worker turns it into the None the caller now reads.
    empty = [([], recover.Placement(0, 10, (0, 0, 8, 8)))]
    assert processor.fit_placements(empty) == [None]


def test_nothing_to_do_is_not_a_pool(clip, frames):
    assert processor.fit_placements([]) == []
    assert processor.scan_windows(frames, [], 1.0) == []
