"""
Central dispatcher. Reads a JSON job payload from stdin, orchestrates the
full pipeline, and emits structured stdout messages for the Electron IPC parser.

Stdout protocol:
  PROGRESS:<float>   — numeric progress (0–100)
  STATE:<string>     — human-readable stage label
  STATE:preview_ready:<path> — quick-preview output path
  ERROR:<string>     — fatal error; Electron shows modal
  DEBUG:<string>     — ignored in production Electron build
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import tempfile
from glob import glob

from pydantic import BaseModel, field_validator

import ff_utils
import processor


# ─── Pydantic schema ────────────────────────────────────────────────────────

class ROI(BaseModel):
    x: int
    y: int
    w: int
    h: int


class JobConfig(BaseModel):
    inputPath: str
    outputPath: str
    roi: ROI
    method: str                       # inpaint | blur | solidFill | cloneStamp
    mode: str = 'full'                # full | preview
    radius: int = 3
    kernelSize: int = 51
    color: list[int] = [0, 0, 0]
    dx: int = 0
    dy: int = -50

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

def emit(msg: str) -> None:
    print(msg, flush=True)


def progress(value: float) -> None:
    emit(f'PROGRESS:{value:.1f}')


def state(label: str) -> None:
    emit(f'STATE:{label}')


# ─── Signal handler (cancel) ────────────────────────────────────────────────

def _handle_sigterm(signum, frame):
    """Abort any active worker pool, then exit (finally block cleans temp_dir)."""
    processor.terminate()
    sys.exit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)


# ─── Core pipeline ──────────────────────────────────────────────────────────

def run_pipeline(config: JobConfig, temp_dir: str, source_video: str) -> str:
    """
    Extract → process → reassemble. Returns the output file path.
    `source_video` is the file from which frames are extracted (may be a
    trimmed clip for preview mode).
    """
    frames_dir = os.path.join(temp_dir, 'frames')

    # 1. Probe metadata
    state('Probing video metadata...')
    meta = ff_utils.probe_video(source_video)
    progress(5)

    # 2. Extract frames
    state('Extracting frames...')
    frame_count = ff_utils.extract_frames(source_video, frames_dir)
    progress(20)

    # Build ordered list of frame paths
    frame_paths = sorted(glob(os.path.join(frames_dir, 'frame_*.png')))

    # 3. Process frames in parallel
    state('Reconstructing pixels...')
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

    processor.run_batch(
        frame_paths,
        removal_config,
        meta['width'],
        meta['height'],
        progress_callback=_progress_cb,
    )
    progress(80)

    # 4. Reassemble
    state('Encoding output video...')
    output_path = config.outputPath
    ff_utils.reassemble_video(
        frames_dir,
        config.inputPath,   # original for audio/metadata mux
        output_path,
        meta['fps'],
        temp_video=os.path.join(temp_dir, 'video_only.mp4'),
    )
    progress(100)
    return output_path


# ─── Entry point ────────────────────────────────────────────────────────────

def main() -> None:
    temp_dir = tempfile.mkdtemp(prefix='watermark_app_')

    try:
        raw = sys.stdin.read().strip()
        if not raw:
            raise ValueError('No input received on stdin.')

        config = JobConfig.model_validate_json(raw)

        if config.mode == 'preview_frame':
            # Probe metadata first so the UI can display width/height/fps/duration.
            meta = ff_utils.probe_video(config.inputPath)
            emit(f'STATE:meta:{json.dumps(meta)}')

            # Extract a single representative frame for the UI canvas.
            # Placed OUTSIDE temp_dir so finally:rmtree doesn't delete it
            # before Electron reads it. Electron is responsible for cleanup.
            fd, preview_png = tempfile.mkstemp(suffix='_wm_preview.png')
            os.close(fd)
            # Clamp timestamp: if video is shorter than 5 s use 0 s
            ts = min(5.0, max(0.0, meta['duration'] - 0.5))
            ff_utils.extract_preview_frame(config.inputPath, preview_png, timestamp=ts)
            emit(f'STATE:preview_ready:{preview_png}')

        elif config.mode == 'preview':
            # Extract a 3-second clip, run the full pipeline on it, and return
            # the result. Write OUTSIDE temp_dir so finally:rmtree doesn't
            # delete it before Electron reads it. Electron cleans it up.
            fd, preview_out = tempfile.mkstemp(suffix='_wm_preview_clip.mp4')
            os.close(fd)

            state('Extracting preview clip...')
            clip_path = os.path.join(temp_dir, 'preview_src.mp4')
            ff_utils.extract_clip(config.inputPath, clip_path, start=4.0, duration=3.0)
            # Run pipeline on the clip, writing to the safe external path
            preview_config = config.model_copy(update={'outputPath': preview_out})
            run_pipeline(preview_config, temp_dir, source_video=clip_path)
            emit(f'STATE:preview_ready:{preview_out}')
        else:
            output = run_pipeline(config, temp_dir, source_video=config.inputPath)
            emit(f'STATE:done:{output}')

    except Exception as exc:
        # Translate technical exceptions into user-friendly messages
        msg = str(exc)
        if 'ffprobe' in msg or 'ffmpeg' in msg:
            emit('ERROR:FFmpeg failed. The video file may be corrupted or unsupported.')
        elif 'not found' in msg.lower():
            emit(f'ERROR:{msg}')
        else:
            emit(f'ERROR:{msg}')
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
