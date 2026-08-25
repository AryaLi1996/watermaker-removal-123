"""
Unit tests for backend/ff_utils.py — the ffmpeg/ffprobe layer.

These run real ffmpeg against tiny synthetic clips (see conftest.py) so the
command lines are verified as ffmpeg actually accepts them, not as we imagine.
"""
import glob
import os
import subprocess

import pytest

import ff_utils
from conftest import requires_ffmpeg

pytestmark = requires_ffmpeg


# ─── probe_video ─────────────────────────────────────────────────────────────

def test_probe_reports_dimensions_fps_and_duration(sample_video):
    meta = ff_utils.probe_video(sample_video)
    assert (meta['width'], meta['height']) == (320, 240)
    assert meta['fps'] == pytest.approx(10.0)
    assert meta['duration'] == pytest.approx(1.0, abs=0.2)
    assert meta['video_codec'] == 'h264'
    assert meta['audio_codec'] == 'aac'


def test_probe_reports_no_audio_for_a_silent_video(silent_video):
    assert ff_utils.probe_video(silent_video)['audio_codec'] is None


def test_probe_rejects_a_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        ff_utils.probe_video(str(tmp_path / 'nope.mp4'))


def test_probe_rejects_a_file_that_is_not_video(tmp_path):
    junk = tmp_path / 'junk.mp4'
    junk.write_bytes(b'this is not a video')
    with pytest.raises((subprocess.CalledProcessError, ValueError)):
        ff_utils.probe_video(str(junk))


# ─── frame extraction ────────────────────────────────────────────────────────

def test_extract_frames_writes_one_png_per_frame(sample_video, tmp_path):
    frames_dir = str(tmp_path / 'frames')
    count = ff_utils.extract_frames(sample_video, frames_dir)
    assert count == 10  # 1 second at 10fps
    assert len(glob.glob(os.path.join(frames_dir, 'frame_*.png'))) == count


def test_extract_preview_frame_writes_a_readable_still(sample_video, tmp_path):
    import cv2

    out = str(tmp_path / 'still.png')
    ff_utils.extract_preview_frame(sample_video, out, timestamp=0.5)
    image = cv2.imread(out)
    assert image is not None
    assert image.shape[:2] == (240, 320)


def test_extract_clip_trims_to_the_requested_length(sample_video, tmp_path):
    out = str(tmp_path / 'clip.mp4')
    ff_utils.extract_clip(sample_video, out, start=0.0, duration=0.5)
    assert ff_utils.probe_video(out)['duration'] == pytest.approx(0.5, abs=0.25)


# ─── reassemble_video ────────────────────────────────────────────────────────

def test_reassemble_keeps_the_original_audio(sample_video, tmp_path):
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(sample_video, frames_dir)

    out = str(tmp_path / 'out.mp4')
    ff_utils.reassemble_video(frames_dir, sample_video, out, fps=10.0, audio_codec='aac')

    meta = ff_utils.probe_video(out)
    assert meta['video_codec'] == 'h264'
    assert meta['audio_codec'] == 'aac'
    assert (meta['width'], meta['height']) == (320, 240)


def test_reassemble_handles_a_silent_source(silent_video, tmp_path):
    """'-map 1:a:0?' makes audio optional; a silent source must not fail."""
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(silent_video, frames_dir)

    out = str(tmp_path / 'out.mp4')
    ff_utils.reassemble_video(frames_dir, silent_video, out, fps=10.0, audio_codec=None)
    assert ff_utils.probe_video(out)['audio_codec'] is None


def test_reassemble_transcodes_audio_mp4_cannot_carry(vorbis_video, tmp_path):
    """A vorbis .mkv used to fail the mux outright; it must come back as AAC."""
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(vorbis_video, frames_dir)

    out = str(tmp_path / 'out.mp4')
    ff_utils.reassemble_video(frames_dir, vorbis_video, out, fps=10.0, audio_codec='vorbis')
    assert ff_utils.probe_video(out)['audio_codec'] == 'aac'


def test_reassemble_removes_its_intermediate_file(sample_video, tmp_path):
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(sample_video, frames_dir)

    temp_video = str(tmp_path / 'video_only.mp4')
    ff_utils.reassemble_video(frames_dir, sample_video, str(tmp_path / 'out.mp4'),
                              fps=10.0, temp_video=temp_video, audio_codec='aac')
    assert not os.path.exists(temp_video)
