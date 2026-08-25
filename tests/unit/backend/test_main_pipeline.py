"""
Unit tests for backend/main.py — job schema, stdout protocol and the pipeline.

The dispatcher is also driven the way Electron drives it (a JSON payload on
stdin, protocol lines on stdout), so the contract the main process parses is
covered end to end.
"""
import json
import os
import subprocess
import sys

import pytest
from pydantic import ValidationError

import ff_utils
import main as backend_main
from conftest import requires_ffmpeg

BACKEND_DIR = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend')
PYTHON = sys.executable


# ─── JobConfig validation ────────────────────────────────────────────────────

def test_job_config_accepts_a_full_payload(existing_file):
    config = backend_main.JobConfig.model_validate({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 1, 'y': 2, 'w': 3, 'h': 4},
        'method': 'inpaint',
    })
    assert config.mode == 'full'      # defaults
    assert config.radius == 3
    assert config.roi.w == 3


def test_job_config_rejects_a_relative_input_path():
    with pytest.raises(ValidationError, match='absolute'):
        backend_main.JobConfig.model_validate({
            'inputPath': 'clip.mp4',
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'inpaint',
        })


def test_job_config_rejects_an_input_that_does_not_exist(tmp_path):
    with pytest.raises(ValidationError, match='not found'):
        backend_main.JobConfig.model_validate({
            'inputPath': str(tmp_path / 'missing.mp4'),
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'inpaint',
        })


def test_job_config_rejects_a_relative_output_path(existing_file):
    with pytest.raises(ValidationError, match='absolute'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': 'out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'inpaint',
        })


def test_job_config_allows_dev_null_as_a_probe_only_output(existing_file):
    config = backend_main.JobConfig.model_validate({
        'inputPath': existing_file,
        'outputPath': '/dev/null',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'inpaint',
        'mode': 'preview_frame',
    })
    assert config.outputPath == '/dev/null'


# ─── stdout protocol ─────────────────────────────────────────────────────────

def test_progress_is_emitted_with_one_decimal(capsys):
    backend_main.progress(42.567)
    assert capsys.readouterr().out.strip() == 'PROGRESS:42.6'


def test_state_is_emitted_with_its_prefix(capsys):
    backend_main.state('Extracting frames...')
    assert capsys.readouterr().out.strip() == 'STATE:Extracting frames...'


def test_meta_is_emitted_in_the_camel_case_the_renderer_expects(capsys):
    backend_main.emit_meta({
        'width': 1920, 'height': 1080, 'fps': 30.0, 'duration': 12.5,
        'video_codec': 'h264', 'audio_codec': 'aac',
    })
    line = capsys.readouterr().out.strip()
    assert line.startswith('STATE:meta:')
    assert json.loads(line[len('STATE:meta:'):]) == {
        'width': 1920, 'height': 1080, 'fps': 30.0, 'duration': 12.5,
        'videoCodec': 'h264', 'audioCodec': 'aac',
    }


# ─── the pipeline ────────────────────────────────────────────────────────────

@requires_ffmpeg
def test_run_pipeline_writes_a_playable_video_with_audio(sample_video, tmp_path):
    out = str(tmp_path / 'out.mp4')
    config = backend_main.JobConfig.model_validate({
        'inputPath': sample_video,
        'outputPath': out,
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'blur',
        'kernelSize': 21,
    })

    result = backend_main.run_pipeline(config, str(tmp_path / 'work'), sample_video)

    assert result == out
    meta = ff_utils.probe_video(out)
    assert meta['audio_codec'] == 'aac'
    assert (meta['width'], meta['height']) == (320, 240)


# ─── the dispatcher, driven as Electron drives it ────────────────────────────

def _run_backend(payload: dict) -> list[str]:
    """Feed a job payload on stdin and return the emitted protocol lines."""
    proc = subprocess.run(
        [PYTHON, os.path.join(BACKEND_DIR, 'main.py')],
        input=json.dumps(payload).encode(),
        capture_output=True,
        timeout=180,
    )
    return [line for line in proc.stdout.decode().splitlines() if line]


@requires_ffmpeg
def test_full_mode_ends_with_a_done_line_naming_the_output(sample_video, tmp_path):
    out = str(tmp_path / 'done.mp4')
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': out,
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'solidFill', 'color': [0, 0, 0], 'mode': 'full',
    })

    assert lines[-1] == f'STATE:done:{out}'
    assert any(l.startswith('STATE:meta:') for l in lines)
    assert any(l.startswith('PROGRESS:') for l in lines)
    assert os.path.exists(out)


@requires_ffmpeg
def test_preview_frame_mode_emits_meta_and_a_still(sample_video):
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'inpaint', 'mode': 'preview_frame',
    })

    meta_line = next(l for l in lines if l.startswith('STATE:meta:'))
    assert json.loads(meta_line[len('STATE:meta:'):])['width'] == 320

    still = lines[-1].removeprefix('STATE:preview_ready:')
    try:
        assert os.path.getsize(still) > 0
    finally:
        os.path.exists(still) and os.unlink(still)


@requires_ffmpeg
def test_preview_mode_clip_audio_matches_its_video(sample_video):
    """The preview must not carry the full soundtrack over a trimmed clip."""
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'blur', 'mode': 'preview',
    })

    clip = lines[-1].removeprefix('STATE:preview_ready:')
    try:
        meta = ff_utils.probe_video(clip)
        # The source is only 1s, so the window shrinks to it rather than failing
        assert meta['duration'] == pytest.approx(1.0, abs=0.3)
    finally:
        os.path.exists(clip) and os.unlink(clip)


def test_an_invalid_payload_is_reported_as_an_error_line(tmp_path):
    lines = _run_backend({
        'inputPath': str(tmp_path / 'missing.mp4'), 'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert any(l.startswith('ERROR:') for l in lines)


def test_empty_stdin_is_reported_as_an_error_line():
    proc = subprocess.run(
        [PYTHON, os.path.join(BACKEND_DIR, 'main.py')],
        input=b'', capture_output=True, timeout=60,
    )
    assert 'ERROR:' in proc.stdout.decode()


@requires_ffmpeg
def test_the_temp_directory_is_removed_after_a_run(sample_video, tmp_path):
    import tempfile

    before = set(os.listdir(tempfile.gettempdir()))
    _run_backend({
        'inputPath': sample_video, 'outputPath': str(tmp_path / 'o.mp4'),
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40}, 'method': 'blur',
    })
    leaked = {n for n in set(os.listdir(tempfile.gettempdir())) - before
              if n.startswith('watermark_app_')}
    assert not leaked, f'temp directories left behind: {leaked}'


# ─── the dispatcher, in-process ──────────────────────────────────────────────
#
# The subprocess tests above prove the real process contract; these call main()
# directly so the dispatch branches are measured by coverage too.

def _dispatch(monkeypatch, capsys, payload: dict) -> list[str]:
    import io

    monkeypatch.setattr('sys.stdin', io.StringIO(json.dumps(payload)))
    backend_main.main()
    return [line for line in capsys.readouterr().out.splitlines() if line]


@requires_ffmpeg
def test_dispatch_full_mode(monkeypatch, capsys, sample_video, tmp_path):
    out = str(tmp_path / 'dispatched.mp4')
    lines = _dispatch(monkeypatch, capsys, {
        'inputPath': sample_video, 'outputPath': out,
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'blur', 'mode': 'full',
    })
    assert lines[-1] == f'STATE:done:{out}'
    assert os.path.exists(out)


@requires_ffmpeg
def test_dispatch_preview_frame_mode(monkeypatch, capsys, sample_video):
    lines = _dispatch(monkeypatch, capsys, {
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'inpaint', 'mode': 'preview_frame',
    })
    still = lines[-1].removeprefix('STATE:preview_ready:')
    try:
        assert os.path.getsize(still) > 0
    finally:
        os.path.exists(still) and os.unlink(still)


@requires_ffmpeg
def test_dispatch_preview_mode(monkeypatch, capsys, sample_video):
    lines = _dispatch(monkeypatch, capsys, {
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'cloneStamp', 'mode': 'preview', 'dy': 60,
    })
    clip = lines[-1].removeprefix('STATE:preview_ready:')
    try:
        assert os.path.getsize(clip) > 0
    finally:
        os.path.exists(clip) and os.unlink(clip)


def test_dispatch_reports_a_bad_payload_without_raising(monkeypatch, capsys, tmp_path):
    lines = _dispatch(monkeypatch, capsys, {
        'inputPath': str(tmp_path / 'missing.mp4'), 'outputPath': '/tmp/o.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert any(l.startswith('ERROR:') for l in lines)


def test_dispatch_translates_ffmpeg_failures_into_a_friendly_message(
    monkeypatch, capsys, existing_file, tmp_path,
):
    def boom(*_args, **_kwargs):
        raise RuntimeError('ffmpeg exited with code 1')

    monkeypatch.setattr(ff_utils, 'probe_video', boom)
    lines = _dispatch(monkeypatch, capsys, {
        'inputPath': existing_file, 'outputPath': str(tmp_path / 'o.mp4'),
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert lines[-1] == 'ERROR:FFmpeg failed. The video file may be corrupted or unsupported.'
