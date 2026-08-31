"""
Unit tests for backend/mask_generator.py — the ROI the deep engine is given.

The mask is the whole of what ProPainter knows about the selection, so these
tests are about the two things that can go wrong with it: painting less than
the mark (the ghost survives) and painting outside the frame (an OpenCV error
in a subprocess, minutes into an export).
"""
import os

import cv2
import numpy as np
import pytest

import mask_generator

ROI = {'x': 40, 'y': 30, 'w': 60, 'h': 20}


def test_mask_covers_the_whole_selection():
    mask = mask_generator.build_mask(320, 240, **ROI)
    inside = mask[ROI['y']:ROI['y'] + ROI['h'], ROI['x']:ROI['x'] + ROI['w']]
    assert np.all(inside == 255)


def test_mask_reaches_past_the_selection():
    """A box drawn on the visible edge leaves the mark's soft edge behind."""
    mask = mask_generator.build_mask(320, 240, **ROI)
    x, y, w, h = mask_generator.mask_rect(320, 240, **ROI)
    assert w > ROI['w'] and h > ROI['h']
    assert mask[y, x] == 255


def test_mask_is_black_away_from_the_selection():
    mask = mask_generator.build_mask(320, 240, **ROI)
    assert mask[200, 300] == 0


def test_mask_is_clipped_to_the_frame():
    """A selection on the border must not grow off the edge of the picture."""
    corner = {'x': 0, 'y': 0, 'w': 30, 'h': 30}
    x, y, w, h = mask_generator.mask_rect(100, 100, **corner)
    assert (x, y) == (0, 0)
    assert x + w <= 100 and y + h <= 100

    edge = {'x': 80, 'y': 80, 'w': 20, 'h': 20}
    x, y, w, h = mask_generator.mask_rect(100, 100, **edge)
    assert x + w == 100 and y + h == 100


def test_mask_shape_matches_the_video():
    mask = mask_generator.build_mask(1920, 1080, **ROI)
    assert mask.shape == (1080, 1920)
    assert mask.dtype == np.uint8


def test_explicit_grow_overrides_the_ratio():
    x, y, w, h = mask_generator.mask_rect(320, 240, grow=0, **ROI)
    assert (x, y, w, h) == (ROI['x'], ROI['y'], ROI['w'], ROI['h'])


def test_written_mask_is_single_channel_and_readable(tmp_path):
    path = str(tmp_path / 'sub' / 'mask.png')
    mask_generator.write_static_mask(path, 320, 240, ROI)

    written = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    assert written is not None
    assert written.shape == (240, 320)
    assert set(np.unique(written)) <= {0, 255}


def test_sequence_is_one_file_per_frame_in_order(tmp_path):
    directory = str(tmp_path / 'masks')
    paths = mask_generator.write_mask_sequence(directory, 5, 320, 240, ROI)

    assert len(paths) == 5
    assert paths == sorted(paths), 'names must sort into frame order'
    assert all(os.path.isfile(p) for p in paths)


def test_sequence_rejects_a_negative_count(tmp_path):
    with pytest.raises(ValueError):
        mask_generator.write_mask_sequence(str(tmp_path), -1, 320, 240, ROI)


def test_selection_entirely_outside_the_frame_is_rejected():
    """Better here than in a worker after the whole video has been extracted."""
    with pytest.raises(ValueError):
        mask_generator.mask_rect(100, 100, 500, 500, 10, 10)
