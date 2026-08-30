"""
Unit tests for backend/image_core.py

Run with:
    cd /path/to/watermark-remove
    backend/.venv/bin/python -m pytest tests/unit/backend/ -v
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import pytest
import numpy as np
import cv2
from image_core import (
    create_mask,
    process_inpaint,
    process_blur,
    process_solid_fill,
    process_clone_stamp,
)


# ─── create_mask ─────────────────────────────────────────────────────────────

def test_create_mask_shape():
    mask = create_mask(width=100, height=80, x=10, y=10, w=20, h=20)
    assert mask.shape == (80, 100)
    assert mask.dtype == np.uint8


def test_create_mask_roi_is_white():
    mask = create_mask(100, 100, x=10, y=10, w=20, h=20)
    # Interior pixel
    assert mask[15, 15] == 255


def test_create_mask_outside_is_black():
    # cv2.rectangle with pt2=(x+w, y+h)=(30,30) includes (30,30); first outside pixel is (31,31)
    mask = create_mask(100, 100, x=10, y=10, w=20, h=20)
    assert mask[0, 0] == 0      # top-left corner outside
    assert mask[31, 31] == 0    # one pixel past bottom-right corner


def test_create_mask_boundary():
    mask = create_mask(100, 100, x=10, y=10, w=20, h=20)
    # Top-left corner of rect (row=10, col=10)
    assert mask[10, 10] == 255
    # cv2.rectangle pt2 is inclusive: (row=30, col=30) is white
    assert mask[30, 30] == 255
    # One pixel past the bottom-right inclusive edge
    assert mask[31, 31] == 0


# ─── process_inpaint ─────────────────────────────────────────────────────────

def test_process_inpaint_fills_black_square():
    """A black square on a white frame should be filled approximately white."""
    frame = np.ones((100, 100, 3), dtype=np.uint8) * 255
    frame[40:60, 40:60] = 0  # black 20×20 square
    mask = create_mask(100, 100, x=40, y=40, w=20, h=20)
    result = process_inpaint(frame, mask, radius=3)
    # The ROI should no longer be purely black
    roi = result[40:60, 40:60]
    assert roi.mean() > 50, "Inpainted region should not remain black"


def test_process_inpaint_matches_a_full_frame_pass():
    """
    Only the neighbourhood of the selection is handed to OpenCV, because
    inpainting costs what the image it is given costs — a small logo on a
    large frame was paying for the whole frame, every frame. TELEA reads no
    pixel further than `radius` from what it is filling, so the crop must
    produce the same image the full-frame call did.
    """
    rng = np.random.default_rng(7)
    frame = cv2.GaussianBlur(
        rng.integers(0, 255, (480, 640, 3), dtype=np.uint8), (9, 9), 0,
    )
    mask = create_mask(640, 480, x=500, y=380, w=90, h=40)

    cropped = process_inpaint(frame, mask, radius=5, roi=(500, 380, 90, 40))
    whole_frame = cv2.inpaint(frame, mask, 5, cv2.INPAINT_TELEA)

    assert np.array_equal(cropped, whole_frame)


def test_process_inpaint_finds_the_selection_without_being_told():
    """The mask's bounding box is the same rectangle, so callers that have no
    ROI to hand still get the cropped path."""
    frame = np.ones((100, 100, 3), dtype=np.uint8) * 255
    frame[40:60, 40:60] = 0
    mask = create_mask(100, 100, x=40, y=40, w=20, h=20)

    assert np.array_equal(
        process_inpaint(frame, mask, radius=3),
        process_inpaint(frame, mask, radius=3, roi=(40, 40, 20, 20)),
    )


def test_process_inpaint_leaves_a_frame_with_nothing_masked_alone():
    frame = np.ones((60, 60, 3), dtype=np.uint8) * 128
    empty = np.zeros((60, 60), dtype=np.uint8)

    result = process_inpaint(frame, empty, radius=3)

    assert np.array_equal(result, frame)
    assert result is not frame  # every engine returns a copy


def test_process_inpaint_handles_a_selection_against_the_frame_edge():
    """The crop is clipped to the frame, so a mark in the corner still works."""
    frame = np.ones((80, 80, 3), dtype=np.uint8) * 200
    frame[0:15, 0:15] = 0
    mask = create_mask(80, 80, x=0, y=0, w=15, h=15)

    result = process_inpaint(frame, mask, radius=3, roi=(0, 0, 15, 15))

    assert result[0:15, 0:15].mean() > 50


# ─── process_blur ─────────────────────────────────────────────────────────────

def test_process_blur_changes_roi():
    # Use a non-uniform ROI (half black, half white) so blurring changes values
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    frame[40:60, 40:50] = 0    # left half of ROI: black
    frame[40:60, 50:60] = 255  # right half of ROI: white
    result = process_blur(frame, x=40, y=40, w=20, h=20, kernel_size=7)
    roi_result = result[40:60, 40:60]
    roi_original = frame[40:60, 40:60].copy()
    # The blurred pixels at the black/white boundary must differ from the original
    assert not np.array_equal(roi_result, roi_original)


def test_process_blur_even_kernel_corrected():
    """Even kernel_size should be bumped to odd without raising."""
    frame = np.zeros((50, 50, 3), dtype=np.uint8)
    result = process_blur(frame, x=10, y=10, w=10, h=10, kernel_size=10)
    assert result.shape == frame.shape  # no crash


# ─── process_solid_fill ──────────────────────────────────────────────────────

def test_process_solid_fill_exact_color():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    result = process_solid_fill(frame, x=10, y=10, w=30, h=30, color=(255, 128, 0))
    roi = result[10:40, 10:40]
    # OpenCV stores BGR; our function converts R,G,B → B,G,R
    assert np.all(roi[:, :, 0] == 0)    # B channel = 0
    assert np.all(roi[:, :, 1] == 128)  # G channel = 128
    assert np.all(roi[:, :, 2] == 255)  # R channel = 255


def test_process_solid_fill_does_not_modify_outside():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    result = process_solid_fill(frame, x=10, y=10, w=30, h=30, color=(255, 255, 255))
    assert result[0, 0, 0] == 0  # outside ROI unchanged


# ─── process_clone_stamp ─────────────────────────────────────────────────────

def test_process_clone_stamp_copies_pixels():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    # Fill source region with a distinct color
    frame[0:20, 0:20] = [100, 150, 200]
    result = process_clone_stamp(frame, x=50, y=50, w=20, h=20, dx=-50, dy=-50)
    roi = result[50:70, 50:70]
    assert np.all(roi[:, :, 0] == 100)
    assert np.all(roi[:, :, 1] == 150)
    assert np.all(roi[:, :, 2] == 200)


def test_process_clone_stamp_out_of_bounds_raises():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    with pytest.raises(ValueError, match="outside"):
        # source offset would land at x=-10, out of bounds
        process_clone_stamp(frame, x=5, y=5, w=20, h=20, dx=-15, dy=0)

