"""
Unit tests for the backend helpers added around the pipeline: ROI clamping,
clone-stamp offset clamping, preview window selection and audio mux arguments.

Run with:
    backend/.venv/bin/python -m pytest tests/unit/backend/ -v
"""
import os
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import numpy as np
import pytest

import ff_utils
import main as backend_main
from image_core import apply_removal, clamp_clone_offset, clamp_roi, create_mask


# ─── clamp_roi ───────────────────────────────────────────────────────────────

def test_clamp_roi_leaves_an_inside_rect_alone():
    assert clamp_roi(1920, 1080, 100, 100, 200, 50) == (100, 100, 200, 50)


def test_clamp_roi_trims_a_rect_running_off_the_right_edge():
    # A rounding error in the UI pushes the box 10px past the frame
    assert clamp_roi(640, 480, 600, 100, 50, 50) == (600, 100, 40, 50)


def test_clamp_roi_trims_a_rect_running_off_the_bottom_edge():
    assert clamp_roi(640, 480, 100, 460, 50, 50) == (100, 460, 50, 20)


def test_clamp_roi_pulls_negative_origins_back_to_zero():
    # Origin moves to 0 and the width shrinks by the amount that was off-frame
    assert clamp_roi(640, 480, -10, -20, 100, 100) == (0, 0, 90, 80)


def test_clamp_roi_rejects_a_rect_entirely_outside_the_frame():
    with pytest.raises(ValueError, match="outside"):
        clamp_roi(640, 480, 700, 100, 50, 50)


# ─── clamp_clone_offset ──────────────────────────────────────────────────────

def test_clone_offset_is_untouched_when_the_source_fits():
    assert clamp_clone_offset(640, 480, 100, 100, 50, 50, dx=0, dy=-50) == (0, -50)


def test_clone_offset_is_pulled_back_when_the_source_runs_off_the_top():
    # ROI sits 20px from the top, so the default -50 offset cannot be honoured
    assert clamp_clone_offset(640, 480, 100, 20, 50, 50, dx=0, dy=-50) == (0, -20)


def test_clone_offset_is_pulled_back_when_the_source_runs_off_the_right():
    assert clamp_clone_offset(640, 480, 560, 100, 50, 50, dx=100, dy=0) == (30, 0)


# ─── apply_removal with an out-of-bounds ROI ─────────────────────────────────

@pytest.mark.parametrize('method', ['inpaint', 'blur', 'solidFill', 'cloneStamp'])
def test_apply_removal_survives_an_roi_over_the_frame_edge(method):
    """Every engine must cope with a box that hangs off the frame."""
    frame = np.full((100, 100, 3), 128, dtype=np.uint8)
    mask = create_mask(100, 100, 80, 80, 40, 40)
    config = {
        'method': method,
        'roi': {'x': 80, 'y': 80, 'w': 40, 'h': 40},  # 20px past both edges
        'radius': 3,
        'kernelSize': 21,
        'color': [255, 0, 0],
        'dx': 0,
        'dy': -50,
    }
    result = apply_removal(frame, mask, config)
    assert result.shape == frame.shape


def test_apply_removal_still_rejects_a_fully_outside_roi():
    frame = np.full((100, 100, 3), 128, dtype=np.uint8)
    mask = create_mask(100, 100, 0, 0, 10, 10)
    config = {'method': 'blur', 'roi': {'x': 200, 'y': 200, 'w': 40, 'h': 40}}
    with pytest.raises(ValueError, match="outside"):
        apply_removal(frame, mask, config)


# ─── preview_window ──────────────────────────────────────────────────────────

def test_preview_window_is_centred_in_a_long_video():
    start, length = backend_main.preview_window(60.0)
    assert length == backend_main.PREVIEW_SECONDS
    assert start == pytest.approx((60.0 - length) / 2)


def test_preview_window_shrinks_to_fit_a_short_video():
    # A clip shorter than the window cannot fill it — take all of it instead
    assert backend_main.preview_window(0.4, length=3.0) == (0.0, 0.4)


def test_preview_window_handles_an_unknown_duration():
    assert backend_main.preview_window(0.0) == (0.0, backend_main.PREVIEW_SECONDS)


def test_preview_window_honours_a_requested_length():
    """A job may ask for a longer look than the default second."""
    start, length = backend_main.preview_window(60.0, length=5.0)
    assert length == 5.0
    assert start == pytest.approx(27.5)


# ─── audio_args_for ──────────────────────────────────────────────────────────

@pytest.mark.parametrize('codec', ['aac', 'mp3', 'ac3'])
def test_mp4_native_audio_is_copied(codec):
    assert ff_utils.audio_args_for(codec) == ['-c:a', 'copy']


def test_missing_audio_track_uses_copy():
    # '-map 1:a:0?' drops the audio arguments entirely for a silent source
    assert ff_utils.audio_args_for(None) == ['-c:a', 'copy']


@pytest.mark.parametrize('codec', ['opus', 'vorbis', 'flac', 'pcm_s16le'])
def test_non_mp4_audio_is_transcoded_to_aac(codec):
    assert ff_utils.audio_args_for(codec)[:2] == ['-c:a', 'aac']


# ─── _run / terminate (the cancel path) ──────────────────────────────────────

def test_run_returns_child_stdout():
    result = ff_utils._run([sys.executable, '-c', 'print("hello")'])
    assert result.stdout.decode().strip() == 'hello'


def test_run_raises_with_stderr_on_failure():
    with pytest.raises(subprocess.CalledProcessError) as excinfo:
        ff_utils._run([sys.executable, '-c', 'import sys; sys.stderr.write("boom"); sys.exit(3)'])
    assert excinfo.value.returncode == 3
    assert b'boom' in excinfo.value.stderr


def test_terminate_stops_a_running_child():
    """A cancel must not leave the ffmpeg child running behind us."""
    error: list[BaseException] = []

    def run_long_child():
        try:
            ff_utils._run([sys.executable, '-c', 'import time; time.sleep(30)'])
        except BaseException as exc:  # noqa: BLE001 — recorded for the assertion
            error.append(exc)

    thread = threading.Thread(target=run_long_child)
    thread.start()

    # Wait for the child to actually be running before cancelling it
    deadline = time.monotonic() + 5
    while ff_utils._active_proc is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert ff_utils._active_proc is not None, 'child never started'

    ff_utils.terminate()
    thread.join(timeout=5)

    assert not thread.is_alive(), 'child outlived terminate()'
    assert error and isinstance(error[0], subprocess.CalledProcessError)
    assert ff_utils._active_proc is None


def test_terminate_is_a_no_op_when_nothing_is_running():
    ff_utils.terminate()  # must not raise


# ─── stage labels ────────────────────────────────────────────────────────────
#
# Stages go out as keys, not sentences. The UI is bilingual and the backend
# cannot know which language the user reads, so the words live in the
# renderer's locale files and only the key crosses the protocol.

def test_a_stage_is_emitted_as_a_key(capsys):
    backend_main.stage('encoding')
    assert capsys.readouterr().out.strip() == 'STATE:stage:encoding'


def test_stage_keys_stay_on_one_line(capsys):
    """The Electron parser is line-based; a key with a newline in it is lost."""
    for key in ('probing', 'extractingStill', 'extractingClip',
                'extractingFrames', 'processing', 'encoding'):
        backend_main.stage(key)
    lines = capsys.readouterr().out.strip().splitlines()
    assert all(line.startswith('STATE:stage:') for line in lines)
    assert len(lines) == 6


# ─── the "no output file" sentinel ───────────────────────────────────────────

def test_the_posix_sentinel_is_accepted_on_every_platform():
    """It is a protocol token the renderer sends, not a path anything opens."""
    assert backend_main.is_null_sink('/dev/null')


def test_this_platforms_own_null_device_is_accepted():
    assert backend_main.is_null_sink(os.devnull)


def test_a_real_output_path_is_not_mistaken_for_the_sentinel(tmp_path):
    assert not backend_main.is_null_sink(str(tmp_path / 'out.mp4'))
    assert not backend_main.is_null_sink('/dev/nullish.mp4')


@pytest.mark.skipif(os.name != 'nt', reason='Windows device names only')
def test_windows_accepts_the_null_device_in_any_case():
    assert backend_main.is_null_sink('nul')
    assert backend_main.is_null_sink('NUL')


# ─── describing a failure that does not describe itself ──────────────────────

def test_an_exception_with_a_message_is_forwarded_verbatim():
    """The renderer classifies the raw text; rewriting it here loses detail."""
    assert backend_main.describe_exception(
        ValueError('No video stream found')) == 'No video stream found'


def test_a_silent_exception_is_named_by_its_class():
    """
    `str(MemoryError())` is empty, and an empty ERROR line reaches the user as
    "the backend gave no reason" — the one thing that is certainly untrue when
    the process ran out of memory.
    """
    assert backend_main.describe_exception(MemoryError()) == 'MemoryError'
