"""
FFmpeg utilities: probe, extract frames, reassemble video.
All subprocess calls use list-form args (never shell=True) to prevent injection.
"""
import json
import os
import subprocess
import tempfile
from fractions import Fraction
from typing import Optional


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a subprocess, capturing stdout/stderr, raising on failure."""
    return subprocess.run(
        cmd,
        capture_output=True,
        check=True,
    )


def probe_video(filepath: str) -> dict:
    """
    Return a dict with: width, height, fps (float), duration (float),
    video_codec, audio_codec (or None).
    Raises subprocess.CalledProcessError if ffprobe fails.
    """
    if not os.path.isfile(filepath):
        raise FileNotFoundError(f"Input video not found: {filepath}")

    result = _run([
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filepath,
    ])
    data = json.loads(result.stdout)

    video_stream = next(
        (s for s in data.get('streams', []) if s.get('codec_type') == 'video'),
        None,
    )
    audio_stream = next(
        (s for s in data.get('streams', []) if s.get('codec_type') == 'audio'),
        None,
    )

    if video_stream is None:
        raise ValueError("No video stream found in file.")

    # fps may be a fraction string like "30000/1001"
    raw_fps = video_stream.get('r_frame_rate', '30/1')
    fps = float(Fraction(raw_fps))

    duration = float(data.get('format', {}).get('duration', 0))

    return {
        'width': int(video_stream['width']),
        'height': int(video_stream['height']),
        'fps': fps,
        'duration': duration,
        'video_codec': video_stream.get('codec_name'),
        'audio_codec': audio_stream.get('codec_name') if audio_stream else None,
    }


def extract_preview_frame(input_path: str, output_path: str, timestamp: float = 5.0) -> None:
    """Extract a single frame at `timestamp` seconds as a PNG."""
    _run([
        'ffmpeg', '-y',
        '-v', 'error',
        '-ss', str(timestamp),
        '-i', input_path,
        '-frames:v', '1',
        output_path,
    ])


def extract_frames(input_path: str, output_dir: str) -> int:
    """
    Extract every frame of `input_path` as lossless PNGs into `output_dir`.
    Returns the count of extracted frames.
    """
    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, 'frame_%06d.png')
    _run([
        'ffmpeg', '-y',
        '-v', 'error',
        '-i', input_path,
        '-q:v', '1',
        '-f', 'image2',
        pattern,
    ])
    return len([f for f in os.listdir(output_dir) if f.endswith('.png')])


def extract_clip(input_path: str, output_path: str, start: float, duration: float) -> None:
    """Extract a short clip from `start` seconds for `duration` seconds."""
    _run([
        'ffmpeg', '-y',
        '-v', 'error',
        '-ss', str(start),
        '-i', input_path,
        '-t', str(duration),
        '-c', 'copy',
        output_path,
    ])


def reassemble_video(
    frames_dir: str,
    original_video: str,
    output_path: str,
    fps: float,
    temp_video: Optional[str] = None,
) -> None:
    """
    Encode processed PNGs back to MP4 (libx264, CRF 18), then mux original
    audio and metadata from `original_video` into the final output.

    The `-map 1:a:0?` flag makes audio optional — silent sources are handled.
    """
    if temp_video is None:
        temp_video = output_path + '.temp.mp4'

    frame_pattern = os.path.join(frames_dir, 'frame_%06d.png')

    # Pass 1: encode video-only
    _run([
        'ffmpeg', '-y',
        '-v', 'error',
        '-framerate', str(fps),
        '-i', frame_pattern,
        '-c:v', 'libx264',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        temp_video,
    ])

    # Pass 2: mux original audio + metadata
    _run([
        'ffmpeg', '-y',
        '-v', 'error',
        '-i', temp_video,
        '-i', original_video,
        '-map', '0:v:0',
        '-map', '1:a:0?',
        '-c', 'copy',
        '-map_metadata', '1',
        output_path,
    ])

    # Remove intermediate file
    if os.path.exists(temp_video):
        os.remove(temp_video)
