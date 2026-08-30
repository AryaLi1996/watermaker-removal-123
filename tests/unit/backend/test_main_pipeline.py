"""
Unit tests for backend/main.py — job schema, stdout protocol and the pipeline.

The dispatcher is also driven the way Electron drives it (a JSON payload on
stdin, protocol lines on stdout), so the contract the main process parses is
covered end to end.
"""
import io
import json
import os
import subprocess
import sys
import typing

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


def test_job_config_rounds_the_fractional_pixels_the_canvas_produces(existing_file):
    """The renderer divides canvas pixels by a zoom factor; 10.5 is a box the
    user drew correctly, not a bad payload."""
    config = backend_main.JobConfig.model_validate({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 10.5, 'y': 2.4, 'w': 100.6, 'h': 50.0},
        'method': 'inpaint',
    })
    assert (config.roi.x, config.roi.y, config.roi.w, config.roi.h) == (10, 2, 101, 50)


def test_job_config_rejects_a_selection_with_no_area(existing_file):
    with pytest.raises(ValidationError, match='greater than 0'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 0, 'h': 10},
            'method': 'inpaint',
        })


def test_job_config_rejects_an_unknown_method(existing_file):
    """Caught here rather than one frame at a time, after a whole video has
    already been extracted."""
    with pytest.raises(ValidationError, match='cloneStamp'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'magic',
        })


def test_job_config_accepts_the_temporal_method_and_its_quality(existing_file):
    config = backend_main.JobConfig.model_validate({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'temporal',
        'temporalQuality': 'quality',
    })
    assert config.method == 'temporal'
    assert config.temporalQuality == 'quality'


def test_job_config_defaults_the_temporal_quality(existing_file):
    """An older renderer sends no quality at all; the middle setting is the one."""
    config = backend_main.JobConfig.model_validate({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'temporal',
    })
    assert config.temporalQuality == 'balanced'


def test_job_config_rejects_a_temporal_quality_the_engine_has_no_settings_for(existing_file):
    with pytest.raises(ValidationError, match='balanced'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'temporal',
            'temporalQuality': 'cinematic',
        })


def test_the_quality_names_the_ui_offers_are_the_ones_the_engine_knows():
    """
    The schema and the engine keep separate lists of the same three names;
    this is what stops one of them growing a fourth on its own.
    """
    import temporal_core

    schema = set(typing.get_args(backend_main.TemporalQuality))
    assert schema == set(temporal_core.QUALITY_PRESETS)
    assert temporal_core.DEFAULT_QUALITY in schema


def test_temporal_gets_more_of_the_bar_for_the_work_that_dominates_it():
    """
    A temporal export spends nearly all its time on the frames; splitting the
    bar as if extraction and encoding were comparable makes it look stuck.
    """
    extract, process = backend_main.stage_bounds('temporal')
    single_extract, single_process = backend_main.stage_bounds('inpaint')

    assert extract < single_extract
    assert process > single_process
    assert extract < process < 100


def test_job_config_rejects_an_unknown_mode(existing_file):
    with pytest.raises(ValidationError, match='preview_frame'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'inpaint',
            'mode': 'previewFrame',
        })


@pytest.mark.parametrize('color', [[255, 0], [0, 0, 0, 0], [300, 0, 0], [-1, 0, 0]])
def test_job_config_rejects_a_colour_that_is_not_three_channels_in_range(existing_file, color):
    with pytest.raises(ValidationError):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file,
            'outputPath': '/tmp/out.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'solidFill',
            'color': color,
        })


# ─── validation errors the UI can read ───────────────────────────────────────

def _validation_error(payload) -> ValidationError:
    try:
        backend_main.JobConfig.model_validate(payload)
    except ValidationError as exc:
        return exc
    raise AssertionError('payload was expected to fail validation')


def test_a_validation_failure_is_described_on_a_single_line(existing_file):
    """The stdout protocol is line-based: anything after the first newline is
    dropped by the Electron parser, which is how "1 validation error for
    JobConfig" used to reach the user with no field and no reason."""
    exc = _validation_error({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'magic',
    })
    described = backend_main.describe_validation_error(exc)
    assert '\n' not in described
    assert 'method' in described
    assert 'inpaint' in described


def test_every_failed_field_is_named(existing_file):
    exc = _validation_error({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0},
        'method': 'inpaint',
    })
    described = backend_main.describe_validation_error(exc)
    assert 'roi.w' in described and 'roi.h' in described
    assert '\n' not in described


def test_a_malformed_payload_is_reported_on_stdout_with_its_reason(existing_file, capsys, monkeypatch):
    """End to end through main(): what Electron would actually parse."""
    payload = json.dumps({
        'inputPath': existing_file,
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 0, 'h': 0},
        'method': 'inpaint',
    })
    monkeypatch.setattr('sys.stdin', io.StringIO(payload))

    with pytest.raises(SystemExit):
        backend_main.main()

    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1
    assert lines[0].startswith('ERROR:Invalid job configuration')
    assert 'roi.w' in lines[0]


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

def _run_backend(payload: dict, env: dict | None = None) -> list[str]:
    """
    Feed a job payload on stdin and return the emitted protocol lines.

    Decoded as UTF-8 because that is what Electron does with the bytes
    (`chunk.toString()`), so a line this cannot decode is one the app cannot
    read either.
    """
    proc = subprocess.run(
        [PYTHON, os.path.join(BACKEND_DIR, 'main.py')],
        input=json.dumps(payload).encode(),
        capture_output=True,
        timeout=180,
        env=env,
    )
    return [line for line in proc.stdout.decode().splitlines() if line]


def _legacy_codepage_env() -> dict:
    """
    A console that is not UTF-8 — what a Windows runner, or a machine in a
    Chinese locale, gives the backend by default.
    """
    return {**os.environ, 'PYTHONIOENCODING': 'cp1252'}


def test_an_error_line_is_utf8_whatever_the_console_encoding_is(tmp_path):
    """Electron decodes stdout as UTF-8. Python otherwise follows the console
    code page, on which the em dash in a validation message is a single
    un-decodable byte."""
    lines = _run_backend({
        'inputPath': str(tmp_path / 'missing.mp4'), 'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    }, env=_legacy_codepage_env())

    assert len(lines) == 1
    assert lines[0].startswith('ERROR:Invalid job configuration')


def test_a_non_ascii_path_still_reaches_the_ui(tmp_path):
    """A bilingual app will be handed such a path. Encoding it against a legacy
    code page raised inside the emit itself, so no ERROR: line was written at
    all and the user got a bare exit code."""
    missing = str(tmp_path / '视频.mp4')
    lines = _run_backend({
        'inputPath': missing, 'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    }, env=_legacy_codepage_env())

    assert len(lines) == 1
    assert '视频.mp4' in lines[0]


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

def _dispatch(monkeypatch, capsys, payload: dict) -> tuple[list[str], int]:
    """
    Run main() in-process. Returns the protocol lines and the exit status,
    which a failing job reports as non-zero the same way the real process does.
    """
    import io

    monkeypatch.setattr('sys.stdin', io.StringIO(json.dumps(payload)))
    status = 0
    try:
        backend_main.main()
    except SystemExit as exc:
        status = exc.code or 0
    return [line for line in capsys.readouterr().out.splitlines() if line], status


@requires_ffmpeg
def test_dispatch_full_mode(monkeypatch, capsys, sample_video, tmp_path):
    out = str(tmp_path / 'dispatched.mp4')
    lines, status = _dispatch(monkeypatch, capsys, {
        'inputPath': sample_video, 'outputPath': out,
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'blur', 'mode': 'full',
    })
    assert lines[-1] == f'STATE:done:{out}'
    assert os.path.exists(out)


@requires_ffmpeg
def test_dispatch_preview_frame_mode(monkeypatch, capsys, sample_video):
    lines, status = _dispatch(monkeypatch, capsys, {
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
    lines, status = _dispatch(monkeypatch, capsys, {
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
    lines, status = _dispatch(monkeypatch, capsys, {
        'inputPath': str(tmp_path / 'missing.mp4'), 'outputPath': '/tmp/o.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert any(l.startswith('ERROR:') for l in lines)


def test_dispatch_passes_the_failure_detail_through_untouched(
    monkeypatch, capsys, existing_file, tmp_path,
):
    """
    The renderer turns a raw failure into plain language and keeps the original
    behind "Copy details". Flattening it here to one generic English sentence
    would leave that button with nothing to show and the user with no clue.
    """
    def boom(*_args, **_kwargs):
        raise RuntimeError('ffmpeg: No space left on device')

    monkeypatch.setattr(ff_utils, 'probe_video', boom)
    lines, status = _dispatch(monkeypatch, capsys, {
        'inputPath': existing_file, 'outputPath': str(tmp_path / 'o.mp4'),
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert lines[-1] == 'ERROR:ffmpeg: No space left on device'


def test_dispatch_exits_non_zero_when_the_job_fails(
    monkeypatch, capsys, existing_file, tmp_path,
):
    """
    Electron reads a zero exit as success and follows it with job:done. A
    failed export that exits 0 therefore reports itself as complete.
    """
    def boom(*_args, **_kwargs):
        raise RuntimeError('something broke')

    monkeypatch.setattr(ff_utils, 'probe_video', boom)
    _lines, status = _dispatch(monkeypatch, capsys, {
        'inputPath': existing_file, 'outputPath': str(tmp_path / 'o.mp4'),
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
    })
    assert status == 1


@requires_ffmpeg
def test_dispatch_still_exits_zero_on_success(monkeypatch, capsys, sample_video, tmp_path):
    _lines, status = _dispatch(monkeypatch, capsys, {
        'inputPath': sample_video, 'outputPath': str(tmp_path / 'ok.mp4'),
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40}, 'method': 'blur',
    })
    assert status == 0


def test_a_failed_run_exits_non_zero_as_a_real_process(tmp_path):
    """The same contract, through the process boundary Electron actually sees."""
    proc = subprocess.run(
        [PYTHON, os.path.join(BACKEND_DIR, 'main.py')],
        input=json.dumps({
            'inputPath': str(tmp_path / 'missing.mp4'), 'outputPath': '/tmp/o.mp4',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'method': 'inpaint',
        }).encode(),
        capture_output=True, timeout=60,
    )
    assert proc.returncode != 0
    assert 'ERROR:' in proc.stdout.decode()


@requires_ffmpeg
def test_a_run_that_extracts_no_frames_says_so(monkeypatch, sample_video, tmp_path):
    """
    Left alone, an empty frames directory fails several steps later inside the
    encoder, with a message about a missing input pattern.
    """
    monkeypatch.setattr(ff_utils, 'extract_frames', lambda *_a, **_k: 0)
    config = backend_main.JobConfig.model_validate({
        'inputPath': sample_video, 'outputPath': str(tmp_path / 'out.mp4'),
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40}, 'method': 'blur',
    })
    with pytest.raises(ValueError, match='No frames could be extracted'):
        backend_main.run_pipeline(config, str(tmp_path / 'work'), sample_video)


# ─── the frozen build's worker processes ─────────────────────────────────────
#
# The release freezes this dispatcher into one executable, and a worker pool
# starts its children by re-running that executable. Anything this module does
# at import time, or on being run again, therefore happens once per core —
# which is how a preview came to report "No input received on stdin." while it
# was otherwise working: each worker ran the dispatcher from the top, found
# the stdin Electron had already closed, and said so on the shared stdout.

def test_being_re_imported_by_a_worker_produces_no_output():
    """
    A spawned worker imports this module under a different name. Doing so must
    be silent: a stray protocol line from a worker is one Electron parses as
    the job's own.
    """
    proc = subprocess.run(
        [PYTHON, '-c',
         'import runpy, sys;'
         f'sys.path.insert(0, {BACKEND_DIR!r});'
         f'runpy.run_path({os.path.join(BACKEND_DIR, "main.py")!r}, run_name="__mp_main__")'],
        input=b'', capture_output=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr.decode()
    assert proc.stdout.decode() == ''


def test_the_entry_point_arms_freeze_support_before_running_a_job():
    """
    Pinned by reading the source, because the call is a no-op under a normal
    interpreter: only PyInstaller's runtime hook makes it the thing that turns
    a re-run executable into a worker instead of a second dispatcher. There is
    no way to observe that without building the frozen binary, and no way to
    notice its removal either — hence this test.
    """
    source = open(os.path.join(BACKEND_DIR, 'main.py'), encoding='utf-8').read()
    entry = source[source.index("if __name__ == '__main__':"):]
    assert entry.index('multiprocessing.freeze_support()') < entry.index('main()')


def test_importing_the_dispatcher_does_not_load_opencv():
    """
    OpenCV costs the best part of a second to import and, frozen, unpacks a
    large part of the bundle. Loading a video needs ffprobe and one ffmpeg
    call — none of it — and that import was pure delay between the user
    picking a file and seeing it.
    """
    proc = subprocess.run(
        [PYTHON, '-c',
         f'import sys; sys.path.insert(0, {BACKEND_DIR!r});'
         'import main; print("cv2" in sys.modules)'],
        capture_output=True, timeout=120,
    )
    assert proc.stdout.decode().strip() == 'False', proc.stderr.decode()


# ─── stage reporting ─────────────────────────────────────────────────────────

@requires_ffmpeg
def test_loading_a_video_reports_the_stage_it_is_at(sample_video):
    """Without this the canvas shows a bare spinner, and a slow file is
    indistinguishable from a stuck backend."""
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
        'method': 'inpaint', 'mode': 'preview_frame',
    })

    stages = [l.removeprefix('STATE:stage:') for l in lines if l.startswith('STATE:stage:')]
    assert stages == ['probing', 'extractingStill']

    still = lines[-1].removeprefix('STATE:preview_ready:')
    os.path.exists(still) and os.unlink(still)


@requires_ffmpeg
def test_an_export_reports_its_stages_as_keys_not_prose(sample_video, tmp_path):
    """The renderer translates these; a sentence from here would pin the
    status line to English."""
    out = str(tmp_path / 'staged.mp4')
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': out,
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40}, 'method': 'blur',
    })

    stages = [l.removeprefix('STATE:stage:') for l in lines if l.startswith('STATE:stage:')]
    assert stages == ['probing', 'extractingFrames', 'processing', 'encoding']
    # No other STATE line carries prose for the UI to display untranslated.
    other = [l for l in lines
             if l.startswith('STATE:')
             and not l.startswith(('STATE:stage:', 'STATE:meta:', 'STATE:done:'))]
    assert other == []


@requires_ffmpeg
def test_a_preview_covers_the_requested_number_of_seconds(sample_video):
    """The clip length is a job setting, so a longer look is possible without
    a new backend."""
    lines = _run_backend({
        'inputPath': sample_video, 'outputPath': '/dev/null',
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'blur', 'mode': 'preview', 'previewSeconds': 0.5,
    })

    clip = lines[-1].removeprefix('STATE:preview_ready:')
    try:
        assert ff_utils.probe_video(clip)['duration'] == pytest.approx(0.5, abs=0.3)
    finally:
        os.path.exists(clip) and os.unlink(clip)


def test_a_preview_length_outside_the_allowed_range_is_rejected(existing_file):
    with pytest.raises(ValidationError, match='previewSeconds'):
        backend_main.JobConfig.model_validate({
            'inputPath': existing_file, 'outputPath': '/dev/null',
            'roi': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
            'method': 'blur', 'mode': 'preview', 'previewSeconds': 0,
        })


# ─── reporting frames that fell back ─────────────────────────────────────────

def _pipeline_lines(monkeypatch, capsys, sample_video, tmp_path, degraded: int) -> list[str]:
    """
    Run the pipeline with the frame processor stubbed to report `degraded`
    frames, and return what it wrote to stdout.

    Stubbing run_batch keeps this about the protocol: the engine's own
    behaviour is covered in test_temporal_core and test_processor, and running
    real optical flow here would cost seconds to test one string.
    """
    processor = backend_main.load_processor()
    monkeypatch.setattr(
        processor, 'run_batch',
        lambda *a, progress_callback=None, **k: degraded)

    config = backend_main.JobConfig.model_validate({
        'inputPath': sample_video,
        'outputPath': str(tmp_path / 'out.mp4'),
        'roi': {'x': 10, 'y': 10, 'w': 60, 'h': 40},
        'method': 'temporal',
    })
    backend_main.run_pipeline(config, str(tmp_path / 'work'), sample_video)
    return [line for line in capsys.readouterr().out.splitlines() if line]


@requires_ffmpeg
def test_frames_that_fell_back_are_reported_once_with_their_count(
    monkeypatch, capsys, sample_video, tmp_path,
):
    lines = _pipeline_lines(monkeypatch, capsys, sample_video, tmp_path, degraded=3)

    reported = [line for line in lines if line.startswith('STATE:temporal_fallback:')]
    assert len(reported) == 1
    count, _, total = reported[0].split(':')[2].partition('/')
    assert count == '3'
    assert int(total) > 0

    # It arrives after the per-frame work and before the file is announced, so
    # the UI has it in hand by the time it shows the result.
    assert lines.index(reported[0]) < len(lines) - 1


@requires_ffmpeg
def test_a_run_with_nothing_to_report_stays_quiet(
    monkeypatch, capsys, sample_video, tmp_path,
):
    """
    Nearly every export takes this path, so an empty report must not reach the
    UI at all — a notice reading "0 frames could not be rebuilt" is worse than
    no notice.
    """
    lines = _pipeline_lines(monkeypatch, capsys, sample_video, tmp_path, degraded=0)
    assert not any(line.startswith('STATE:temporal_fallback:') for line in lines)
