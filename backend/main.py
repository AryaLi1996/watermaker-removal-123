"""
Central dispatcher. Reads a JSON job payload from stdin, orchestrates the
full pipeline, and emits structured stdout messages for the Electron IPC parser.

Stdout protocol:
  PROGRESS:<float>   — numeric progress (0–100)
  STATE:stage:<key>  — pipeline stage, as a key the renderer translates
  STATE:preview_ready:<path> — quick-preview output path
  ERROR:<string>     — fatal error; Electron shows modal
  DEBUG:<string>     — ignored in production Electron build

Stage labels are keys, not prose: the UI is bilingual and the backend has no
business deciding which language the status line is written in. The renderer
looks each key up in its own resources (`stages.<key>`).
"""
from __future__ import annotations

import json
import math
import multiprocessing
import os
import shutil
import signal
import sys
import tempfile
from glob import glob
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field, ValidationError, field_validator

import ff_utils


def load_processor():
    """
    Import the frame processor on first use.

    It pulls in OpenCV, which costs the best part of a second to import and,
    in the frozen build, unpacks a large chunk of the bundle. The metadata
    and still-frame probes that run when the user picks a file need none of
    it, and that wait is the whole of "importing is slow".
    """
    import processor  # noqa: PLC0415 — deliberately deferred
    return processor


# ─── Pydantic schema ────────────────────────────────────────────────────────

def _round_pixels(value: object) -> object:
    """
    Accept the pixel counts the canvas actually produces.

    The renderer works in scaled canvas pixels and divides by the zoom factor
    to get back to video pixels, so a box the user drew correctly can arrive
    as 10.5 rather than 10. Rejecting that would fail an export over a
    rounding artefact, so round it here. A non-finite value is a different
    story — it means the scale factor was zero or unknown, and there is no
    rectangle to recover.
    """
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('must be a finite number of pixels')
        return round(value)
    return value


Pixels = Annotated[int, BeforeValidator(_round_pixels)]

# How much of the video a quick preview covers. One second is enough to judge
# a removal — the mark is either gone or it is not — and it is a third of the
# frames to extract, process and encode, which is a third of the wait.
# `previewSeconds` on the job overrides it.
PREVIEW_SECONDS = 1.0


RemovalMethod = Literal['inpaint', 'blur', 'solidFill', 'cloneStamp']
JobMode = Literal['full', 'preview', 'preview_frame']


class ROI(BaseModel):
    x: Pixels
    y: Pixels
    # A zero-width or negative box selects nothing. It survives as far as the
    # frame workers, which fail one frame at a time after the whole video has
    # already been extracted; saying so up front costs the user seconds
    # instead of minutes.
    w: Pixels = Field(gt=0)
    h: Pixels = Field(gt=0)


class JobConfig(BaseModel):
    inputPath: str
    outputPath: str
    roi: ROI
    method: RemovalMethod
    mode: JobMode = 'full'
    radius: Pixels = Field(default=3, ge=1)
    # OpenCV needs an odd kernel; image_core rounds an even one up, so the
    # bound here is only about it being a usable size at all.
    kernelSize: Pixels = Field(default=51, ge=1)
    color: list[int] = Field(default=[0, 0, 0], min_length=3, max_length=3)
    dx: Pixels = 0
    dy: Pixels = -50
    # How many seconds of video a quick preview covers.
    previewSeconds: float = Field(default=PREVIEW_SECONDS, gt=0, le=30)

    @field_validator('color')
    @classmethod
    def color_channels_in_range(cls, v: list[int]) -> list[int]:
        if any(c < 0 or c > 255 for c in v):
            raise ValueError(f"colour channels must be between 0 and 255: {v}")
        return v

    @field_validator('inputPath')
    @classmethod
    def input_must_be_absolute_and_exist(cls, v: str) -> str:
        if not os.path.isabs(v):
            raise ValueError(f"inputPath must be an absolute path: {v!r}")
        if not os.path.isfile(v):
            raise ValueError(f"Input file not found: {v!r}")
        return v

    @field_validator('outputPath')
    @classmethod
    def output_must_be_absolute(cls, v: str) -> str:
        # Allow '/dev/null' as a valid sentinel for probe-only modes.
        if v == '/dev/null':
            return v
        if not os.path.isabs(v):
            raise ValueError(f"outputPath must be an absolute path: {v!r}")
        return v


# ─── Helpers ────────────────────────────────────────────────────────────────

def force_utf8_stdio() -> None:
    """
    Speak UTF-8 whatever the console is set to.

    Electron decodes this process's output with `chunk.toString()`, which is
    UTF-8. Python instead follows the console encoding, which on a Windows
    runner or a Chinese-locale machine is a legacy code page: a message naming
    a file with non-ASCII characters then fails to encode and the `ERROR:` line
    is never written at all, leaving the user with a bare exit code. Even pure
    ASCII prose is not safe — an em dash lands as one un-decodable byte.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure is None:
            continue
        try:
            # A path that survived a lossy decode on the way in has no valid
            # encoding on the way out; a replacement character in a diagnostic
            # beats losing the whole line.
            reconfigure(encoding='utf-8', errors='replace')
        except (ValueError, OSError):  # a stream that cannot be reconfigured
            pass


def emit(msg: str) -> None:
    print(msg, flush=True)


def describe_validation_error(exc: ValidationError) -> str:
    """
    Flatten a pydantic failure into one line the UI can actually show.

    The stdout protocol is line-based, so only the first line of a message
    survives the trip to Electron. Pydantic puts its count on that line
    ("1 validation error for JobConfig") and every useful word — the field and
    what was wrong with it — on the ones after, which the parser drops. The
    user is then told a field is invalid without being told which.
    """
    parts = []
    for err in exc.errors():
        field = '.'.join(str(p) for p in err['loc'])
        # Pydantic prefixes messages raised from our own validators.
        detail = err['msg'].removeprefix('Value error, ')
        parts.append(f'{field}: {detail}' if field else detail)
    joined = '; '.join(parts)
    return f'Invalid job configuration — {joined}'.replace('\n', ' ')


def emit_meta(meta: dict) -> None:
    """
    Publish probe results to the UI. Keys are camelCase to match the
    renderer's VideoMeta type; probe_video keeps snake_case internally.
    """
    emit('STATE:meta:' + json.dumps({
        'width': meta['width'],
        'height': meta['height'],
        'fps': meta['fps'],
        'duration': meta['duration'],
        'videoCodec': meta['video_codec'],
        'audioCodec': meta['audio_codec'],
    }))


def preview_window(duration: float, length: float = PREVIEW_SECONDS) -> tuple[float, float]:
    """
    Pick a clip window centred in the video, clamped to what actually exists.

    A fixed offset would produce an empty clip for anything shorter than it,
    and the middle of a video is more representative than its opening.
    """
    if duration <= 0:
        return 0.0, length
    clip = min(length, duration)
    start = max(0.0, (duration - clip) / 2)
    return start, clip


def progress(value: float) -> None:
    emit(f'PROGRESS:{value:.1f}')


def state(label: str) -> None:
    emit(f'STATE:{label}')


def stage(key: str) -> None:
    """
    Announce a pipeline stage by key, for the renderer to translate.

    The stage names live in the renderer's locale files alongside every other
    string in the UI, so a Chinese user sees a Chinese status line without the
    backend carrying a translation table of its own.
    """
    state(f'stage:{key}')


# ─── Signal handler (cancel) ────────────────────────────────────────────────

def _handle_sigterm(signum, frame):
    """
    Abort in-flight work, then exit (the finally block cleans temp_dir).
    Both the worker pool and any running ffmpeg child have to go, or they
    outlive this process and keep writing into a deleted temp directory.
    """
    # Only if the frame pipeline was ever reached — importing it here, purely
    # to cancel work it never started, would delay the exit by the import.
    loaded = sys.modules.get('processor')
    if loaded is not None:
        loaded.terminate()
    ff_utils.terminate()
    sys.exit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)


# ─── Core pipeline ──────────────────────────────────────────────────────────

def run_pipeline(
    config: JobConfig,
    temp_dir: str,
    source_video: str,
    announce_meta: bool = True,
) -> str:
    """
    Extract → process → reassemble. Returns the output file path.
    `source_video` is the file from which frames are extracted (may be a
    trimmed clip for preview mode).

    `announce_meta` is off for preview runs: the metadata of a trimmed clip
    would misreport the source video the UI is describing. A preview is also
    encoded for speed rather than for keeping — see ff_utils.PREVIEW_ENCODE.
    """
    is_preview = config.mode == 'preview'
    frames_dir = os.path.join(temp_dir, 'frames')

    # 1. Probe metadata
    stage('probing')
    meta = ff_utils.probe_video(source_video)
    if announce_meta:
        emit_meta(meta)
    progress(5)

    # 2. Extract frames
    stage('extractingFrames')
    ff_utils.extract_frames(source_video, frames_dir)
    progress(20)

    # Build ordered list of frame paths
    frame_paths = sorted(glob(os.path.join(frames_dir, 'frame_*.png')))

    # ffmpeg can exit 0 having written nothing — a stream it decoded but could
    # not render, or a clip window past the end of the file. Say so here, while
    # the cause is still obvious, instead of letting the encode below fail on a
    # missing input pattern and blaming the video.
    if not frame_paths:
        raise ValueError(
            'No frames could be extracted from the video. '
            'The file may be corrupted or use an unsupported codec.'
        )

    # 3. Process frames in parallel
    stage('processing')
    roi_dict = config.roi.model_dump()
    removal_config = {
        'method': config.method,
        'roi': {'x': roi_dict['x'], 'y': roi_dict['y'],
                'w': roi_dict['w'], 'h': roi_dict['h']},
        'radius': config.radius,
        'kernelSize': config.kernelSize,
        'color': config.color,
        'dx': config.dx,
        'dy': config.dy,
    }

    def _progress_cb(pct: float):
        # Maps 0–100 of processing to 20–80 of total progress
        progress(20 + pct * 0.6)

    load_processor().run_batch(
        frame_paths,
        removal_config,
        meta['width'],
        meta['height'],
        progress_callback=_progress_cb,
    )
    progress(80)

    # 4. Reassemble
    stage('encoding')
    output_path = config.outputPath
    ff_utils.reassemble_video(
        frames_dir,
        # Audio and metadata come from the file the frames were extracted from.
        # In preview mode that is the trimmed clip — muxing the full original
        # here leaves a one-second video carrying the whole soundtrack.
        source_video,
        output_path,
        meta['fps'],
        temp_video=os.path.join(temp_dir, 'video_only.mp4'),
        audio_codec=meta['audio_codec'],
        encode=ff_utils.PREVIEW_ENCODE if is_preview else ff_utils.EXPORT_ENCODE,
    )
    progress(100)
    return output_path


# ─── Entry point ────────────────────────────────────────────────────────────

def main() -> None:
    force_utf8_stdio()
    temp_dir = tempfile.mkdtemp(prefix='watermark_app_')

    try:
        raw = sys.stdin.read().strip()
        if not raw:
            raise ValueError('No input received on stdin.')

        try:
            config = JobConfig.model_validate_json(raw)
        except ValidationError as exc:
            # Re-raised as a plain error so the single-line stdout protocol
            # carries the field and the reason, not just the error count.
            raise ValueError(describe_validation_error(exc)) from exc

        if config.mode == 'preview_frame':
            # Loading a video is two ffmpeg calls and no UI of its own, so it
            # says where it is: without that the canvas shows a spinner and
            # the user cannot tell a slow file from a stuck app.
            stage('probing')
            # Probe metadata first so the UI can display width/height/fps/duration.
            meta = ff_utils.probe_video(config.inputPath)
            emit_meta(meta)

            # Extract a single representative frame for the UI canvas.
            # Placed OUTSIDE temp_dir so finally:rmtree doesn't delete it
            # before Electron reads it. Electron is responsible for cleanup.
            stage('extractingStill')
            fd, preview_png = tempfile.mkstemp(suffix='_wm_preview.png')
            os.close(fd)
            # Clamp timestamp: if video is shorter than 5 s use 0 s
            ts = min(5.0, max(0.0, meta['duration'] - 0.5))
            ff_utils.extract_preview_frame(config.inputPath, preview_png, timestamp=ts)
            emit(f'STATE:preview_ready:{preview_png}')

        elif config.mode == 'preview':
            # Extract a short clip, run the full pipeline on it, and return
            # the result. Write OUTSIDE temp_dir so finally:rmtree doesn't
            # delete it before Electron reads it. Electron cleans it up.
            fd, preview_out = tempfile.mkstemp(suffix='_wm_preview_clip.mp4')
            os.close(fd)

            stage('extractingClip')
            clip_path = os.path.join(temp_dir, 'preview_src.mp4')
            src_meta = ff_utils.probe_video(config.inputPath)
            emit_meta(src_meta)
            start, length = preview_window(src_meta['duration'], config.previewSeconds)
            ff_utils.extract_clip(config.inputPath, clip_path, start=start, duration=length)
            # Run pipeline on the clip, writing to the safe external path
            preview_config = config.model_copy(update={'outputPath': preview_out})
            run_pipeline(preview_config, temp_dir, source_video=clip_path,
                         announce_meta=False)
            emit(f'STATE:preview_ready:{preview_out}')
        else:
            output = run_pipeline(config, temp_dir, source_video=config.inputPath)
            emit(f'STATE:done:{output}')

    except Exception as exc:
        # The raw text goes through as-is: the renderer classifies it into plain
        # language and keeps the original for a bug report, so replacing it here
        # with a generic sentence would discard the only diagnostic there is.
        emit(f'ERROR:{exc}')
        # Exit non-zero so a caller that cannot read the protocol still sees the
        # failure. Electron treats a zero exit as success and would otherwise
        # follow the ERROR line with job:done, on an export that never happened.
        raise SystemExit(1)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == '__main__':
    # Must come first, and before anything reads stdin.
    #
    # The release ships this dispatcher frozen into a single executable, and
    # the frame pool starts its workers by re-running that executable. Without
    # this call each worker runs the dispatcher again from the top: it finds
    # the stdin Electron already closed, reports "No input received on stdin."
    # on the same stdout the real job is reporting on, and the user sees that
    # error in the middle of a preview that was otherwise going fine.
    multiprocessing.freeze_support()
    main()
