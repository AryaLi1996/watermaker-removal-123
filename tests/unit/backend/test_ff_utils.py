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


def test_reassemble_transcodes_audio_mp4_cannot_carry(nonmp4_audio_video, tmp_path):
    """Audio MP4 cannot carry used to fail the mux outright; it must come back as AAC."""
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(nonmp4_audio_video, frames_dir)

    source_codec = ff_utils.probe_video(nonmp4_audio_video)['audio_codec']
    assert source_codec not in ff_utils.MP4_AUDIO_CODECS, 'fixture must use a codec MP4 rejects'

    out = str(tmp_path / 'out.mp4')
    ff_utils.reassemble_video(frames_dir, nonmp4_audio_video, out,
                              fps=10.0, audio_codec=source_codec)
    assert ff_utils.probe_video(out)['audio_codec'] == 'aac'


def test_reassemble_removes_its_intermediate_file(sample_video, tmp_path):
    frames_dir = str(tmp_path / 'frames')
    ff_utils.extract_frames(sample_video, frames_dir)

    temp_video = str(tmp_path / 'video_only.mp4')
    ff_utils.reassemble_video(frames_dir, sample_video, str(tmp_path / 'out.mp4'),
                              fps=10.0, temp_video=temp_video, audio_codec='aac')
    assert not os.path.exists(temp_video)


# ─── binary resolution ───────────────────────────────────────────────────────
#
# A packaged app ships its own ffmpeg and points the backend at it; a
# development run uses whatever is on PATH.

def test_binaries_default_to_path(monkeypatch):
    monkeypatch.delenv('FFMPEG_PATH', raising=False)
    monkeypatch.delenv('FFPROBE_PATH', raising=False)
    assert ff_utils.ffmpeg_bin() == 'ffmpeg'
    assert ff_utils.ffprobe_bin() == 'ffprobe'


def test_binaries_follow_the_bundled_paths(monkeypatch):
    monkeypatch.setenv('FFMPEG_PATH', '/opt/app/resources/backend/ffmpeg')
    monkeypatch.setenv('FFPROBE_PATH', '/opt/app/resources/backend/ffprobe')
    assert ff_utils.ffmpeg_bin() == '/opt/app/resources/backend/ffmpeg'
    assert ff_utils.ffprobe_bin() == '/opt/app/resources/backend/ffprobe'


def test_an_empty_override_falls_back_to_path(monkeypatch):
    """An unset-but-present env var must not produce an empty command."""
    monkeypatch.setenv('FFMPEG_PATH', '')
    assert ff_utils.ffmpeg_bin() == 'ffmpeg'


def test_probe_uses_the_configured_ffprobe(monkeypatch, sample_video):
    """The override is honoured by the real call path, not just the getter."""
    import shutil

    resolved = shutil.which('ffprobe')
    monkeypatch.setenv('FFPROBE_PATH', resolved)
    assert ff_utils.probe_video(sample_video)['width'] == 320


# ─── failure reporting ───────────────────────────────────────────────────────
#
# The UI classifies a failure by matching on the message text, so whatever the
# tool wrote to stderr has to survive into the exception.

@pytest.mark.parametrize('stderr, expected', [
    (None, ''),
    (b'', ''),
    (b'\n  \n', ''),
    (b'only line\n', 'only line'),
    (b'a\nb\nc\nd\ne\nf\n', 'c | d | e | f'),  # last four, oldest first
])
def test_stderr_tail_keeps_the_closing_lines(stderr, expected):
    assert ff_utils.stderr_tail(stderr) == expected


def test_stderr_tail_is_bounded():
    assert len(ff_utils.stderr_tail(b'x' * 10_000)) <= 500


def test_stderr_tail_survives_undecodable_bytes():
    assert ff_utils.stderr_tail(b'\xff\xfe bad') != ''


def test_a_failed_call_reports_what_the_tool_said():
    """
    Without this the message is 'returned non-zero exit status 1' and nothing
    else: a full disk and a corrupt file look identical to the user.
    """
    error = ff_utils.FFmpegError(1, ['ffmpeg', '-i', 'x'],
                                 b'', b'x: No space left on device\n')
    assert 'No space left on device' in str(error)
    # Still a CalledProcessError, so existing handlers keep working.
    assert isinstance(error, subprocess.CalledProcessError)


def test_a_failed_call_without_stderr_reads_as_before():
    assert str(ff_utils.FFmpegError(1, ['ffmpeg'], b'', b'')).endswith('status 1.')


def test_a_real_ffprobe_failure_carries_its_reason(tmp_path):
    junk = tmp_path / 'junk.mp4'
    junk.write_bytes(b'this is not a video')
    with pytest.raises(subprocess.CalledProcessError) as caught:
        ff_utils.probe_video(str(junk))
    # ffprobe explains itself; '-v quiet' used to throw that explanation away,
    # leaving an exit status and nothing to classify or report.
    assert caught.value.stderr, 'ffprobe reported no reason at all'
    assert ff_utils.stderr_tail(caught.value.stderr) in str(caught.value)
