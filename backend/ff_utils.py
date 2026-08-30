"""
FFmpeg utilities: probe, extract frames, reassemble video.
All subprocess calls use list-form args (never shell=True) to prevent injection.
"""
import json
import os
import subprocess
import tempfile
import threading
from fractions import Fraction
from typing import Callable, Optional


# The ffmpeg/ffprobe child currently running, so a cancel can stop it. Without
# this, SIGTERM unwinds the Python process while ffmpeg keeps running as an
# orphan — burning CPU and writing into a temp dir that has just been deleted.
_active_proc: Optional[subprocess.Popen] = None


def ffmpeg_bin() -> str:
    """
    The ffmpeg to run. A packaged app points FFMPEG_PATH at the copy shipped
    beside it; a development run falls back to whatever is on PATH.
    """
    return os.environ.get('FFMPEG_PATH') or 'ffmpeg'


def ffprobe_bin() -> str:
    """The ffprobe to run — see ffmpeg_bin()."""
    return os.environ.get('FFPROBE_PATH') or 'ffprobe'


# How much of ffmpeg's stderr to carry in an error message. Enough for the line
# that names the real cause, short enough to stay readable in a dialog.
_STDERR_LINES = 4
_STDERR_CHARS = 500


def stderr_tail(stderr: Optional[bytes]) -> str:
    """The last few meaningful lines of a child's stderr, as text."""
    if not stderr:
        return ''
    text = stderr.decode('utf-8', errors='replace')
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return ' | '.join(lines[-_STDERR_LINES:])[:_STDERR_CHARS]


class FFmpegError(subprocess.CalledProcessError):
    """
    A failed ffmpeg/ffprobe call that reports what the tool actually said.

    CalledProcessError stringifies to the exit status alone, so the reason —
    "No space left on device", "Permission denied", "Invalid data found" — was
    captured and then dropped. The UI classifies failures by matching on this
    text, so without it a full disk is indistinguishable from a corrupt file.
    """

    def __str__(self) -> str:
        detail = stderr_tail(self.stderr)
        return f'{super().__str__()} {detail}' if detail else super().__str__()


class FFmpegTimeout(RuntimeError):
    """
    A call that never came back, and was killed rather than waited on.

    The wording matters: the renderer classifies failures by matching on this
    text, and "timed out" is what it turns into "the job took too long" rather
    than into a generic ffmpeg failure.
    """

    def __init__(self, cmd: list[str], timeout: float):
        self.cmd = cmd
        self.timeout = timeout
        tool = os.path.basename(cmd[0]) if cmd else 'ffmpeg'
        super().__init__(f'{tool} timed out after {timeout:g}s and was stopped.')


# Ceilings for the calls that run while the user waits on a spinner with
# nothing else happening. None of them does work proportional to the length of
# the video — a probe reads headers, a still decodes one frame — so a minute of
# silence means stuck, not slow, and saying so beats an indefinite spinner.
# The long stages of an export (extract, encode) are deliberately unbounded:
# there a wait of many minutes is the job doing exactly what it was asked to.
PROBE_TIMEOUT = 30.0
STILL_TIMEOUT = 60.0
CLIP_TIMEOUT = 120.0


def _popen(cmd: list[str]) -> subprocess.Popen:
    """Start a child, registering it so a cancel can stop it."""
    global _active_proc
    proc = subprocess.Popen(
        cmd,
        # ffmpeg reads stdin by default and would otherwise inherit this
        # process's — the pipe Electron writes the job payload to. A child
        # that drains or closes it corrupts the one channel the dispatcher
        # has for its own input, which is how a run ends up reporting
        # "No input received on stdin." for a payload that was sent.
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    _active_proc = proc
    return proc


def _run(cmd: list[str], timeout: Optional[float] = None) -> subprocess.CompletedProcess:
    """
    Run a subprocess, capturing stdout/stderr, raising on failure.

    `timeout` kills a child that outstays it; without the kill the process
    would keep running as an orphan while the caller reports the failure.
    """
    global _active_proc
    proc = _popen(cmd)
    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise FFmpegTimeout(cmd, timeout) from None
    finally:
        _active_proc = None

    if proc.returncode != 0:
        raise FFmpegError(proc.returncode, cmd, stdout, stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


# Asking ffmpeg to report where it is, on a pipe of its own. Without it the
# only thing the UI learns about a stage that runs for minutes is when it
# started and when it ended, which is a progress bar that sits still.
# `-nostats` drops the human-readable version, which would otherwise be
# interleaved into stderr and reported as part of a failure.
_PROGRESS_ARGS = ['-progress', 'pipe:1', '-nostats']

# Don't report a move smaller than this fraction of the stage: ffmpeg writes a
# block per stats period, and forwarding every one of them as a PROGRESS line
# costs more than the pixel it would move.
_PROGRESS_STEP = 0.004


def _run_reporting(
    cmd: list[str],
    expected_frames: Optional[int],
    on_progress: Optional[Callable[[float], None]],
) -> subprocess.CompletedProcess:
    """
    Run ffmpeg with `_PROGRESS_ARGS`, calling `on_progress(fraction)` (0–1) as
    frames go by.

    Falls back to a plain run when there is no callback or no frame count to
    measure against — a fraction needs a denominator.

    stderr is drained by a thread rather than after the fact: this reads
    stdout to the end, and a child whose stderr pipe fills up in the meantime
    blocks forever waiting for someone to empty it.
    """
    if on_progress is None or not expected_frames:
        return _run(cmd)

    global _active_proc
    proc = _popen([cmd[0], *_PROGRESS_ARGS, *cmd[1:]])
    captured: list[bytes] = []

    def drain() -> None:
        assert proc.stderr is not None
        captured.append(proc.stderr.read())

    collector = threading.Thread(target=drain, daemon=True)
    collector.start()

    reported = 0.0
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode('utf-8', errors='replace').strip()
            if not line.startswith('frame='):
                continue
            try:
                done = int(line.split('=', 1)[1])
            except ValueError:  # ffmpeg writes 'frame=N/A' before the first one
                continue
            fraction = min(1.0, done / expected_frames)
            if fraction - reported >= _PROGRESS_STEP:
                reported = fraction
                on_progress(fraction)
        proc.stdout.close()
        proc.wait()
        collector.join(timeout=5)
    finally:
        _active_proc = None

    stderr = b''.join(chunk for chunk in captured if chunk)
    if proc.returncode != 0:
        raise FFmpegError(proc.returncode, cmd, b'', stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, b'', stderr)


def terminate() -> None:
    """Stop the ffmpeg/ffprobe child, if one is running. Safe to call anytime."""
    proc = _active_proc
    if proc is not None and proc.poll() is None:
        proc.terminate()


def probe_video(filepath: str) -> dict:
    """
    Return a dict with: width, height, fps (float), duration (float),
    video_codec, audio_codec (or None).
    Raises subprocess.CalledProcessError if ffprobe fails.
    """
    if not os.path.isfile(filepath):
        raise FileNotFoundError(f"Input video not found: {filepath}")

    result = _run([
        ffprobe_bin(),
        # 'error' rather than 'quiet': the JSON goes to stdout either way, and
        # a quiet ffprobe fails with an empty stderr and nothing to report.
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filepath,
    ], timeout=PROBE_TIMEOUT)
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


# PNG deflate level for the frames on disk. They live for one job inside a
# temp directory, so compressing them hard buys nothing and costs real time:
# level 1 writes a 1080p frame several times faster than the default 6, and
# PNG is lossless at every level, so no quality is traded for it.
PNG_COMPRESSION = 1


def extract_preview_frame(input_path: str, output_path: str, timestamp: float = 5.0) -> None:
    """
    Extract a single frame at `timestamp` seconds as a PNG.

    This is the one thing standing between the user picking a file and seeing
    it, so it does as little as possible: `-ss` before `-i` seeks the input
    rather than decoding up to the timestamp, `-an` skips the audio track
    entirely, and the still is written at the cheap PNG level.
    """
    _run([
        ffmpeg_bin(), '-y',
        '-v', 'error',
        '-ss', str(timestamp),
        '-i', input_path,
        '-an',
        '-frames:v', '1',
        '-compression_level', str(PNG_COMPRESSION),
        output_path,
    ], timeout=STILL_TIMEOUT)


def extract_frames(
    input_path: str,
    output_dir: str,
    expected_frames: Optional[int] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> int:
    """
    Extract every frame of `input_path` as lossless PNGs into `output_dir`.
    Returns the count of extracted frames.

    On a long video this is minutes of work, so it reports as it goes:
    `on_progress` is called with the fraction done, measured against
    `expected_frames` (the caller's frame count from the probe — ffmpeg does
    not know the total either, and estimating it here would mean a second
    pass over the file).
    """
    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, 'frame_%06d.png')
    _run_reporting([
        ffmpeg_bin(), '-y',
        '-v', 'error',
        '-i', input_path,
        '-compression_level', str(PNG_COMPRESSION),
        '-f', 'image2',
        pattern,
    ], expected_frames, on_progress)
    return len([f for f in os.listdir(output_dir) if f.endswith('.png')])


def extract_clip(input_path: str, output_path: str, start: float, duration: float) -> None:
    """Extract a short clip from `start` seconds for `duration` seconds."""
    _run([
        ffmpeg_bin(), '-y',
        '-v', 'error',
        '-ss', str(start),
        '-i', input_path,
        '-t', str(duration),
        '-c', 'copy',
        output_path,
    ], timeout=CLIP_TIMEOUT)


# Audio codecs an MP4 container accepts without re-encoding. Anything else
# (vorbis or opus from a .mkv/.webm, flac, raw pcm) has to be transcoded, or
# the mux fails outright and the user loses the whole render.
MP4_AUDIO_CODECS = frozenset({'aac', 'mp3', 'ac3', 'eac3', 'alac'})


def audio_args_for(audio_codec: Optional[str]) -> list[str]:
    """
    Pick the audio arguments for the final mux: copy when the source codec
    already fits in MP4, otherwise transcode to AAC.
    """
    if audio_codec is None or audio_codec in MP4_AUDIO_CODECS:
        return ['-c:a', 'copy']
    return ['-c:a', 'aac', '-b:a', '192k']


# x264 settings per purpose. An export is a file the user keeps, so it is
# encoded for quality; a preview is watched once and thrown away, where the
# minutes 'medium' spends chasing the last of the bitrate are the whole
# complaint about how long a preview takes.
EXPORT_ENCODE = {'preset': 'medium', 'crf': '18'}
PREVIEW_ENCODE = {'preset': 'veryfast', 'crf': '23'}


def reassemble_video(
    frames_dir: str,
    original_video: str,
    output_path: str,
    fps: float,
    temp_video: Optional[str] = None,
    audio_codec: Optional[str] = None,
    encode: Optional[dict] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> None:
    """
    Encode processed PNGs back to MP4 (libx264), then mux original audio and
    metadata from `original_video` into the final output.

    The `-map 1:a:0?` flag makes audio optional — silent sources are handled.
    `audio_codec` is the source's codec name from probe_video(); pass it to
    avoid a second probe. Audio is copied when MP4 accepts it, else re-encoded.
    `encode` selects the x264 preset/CRF — EXPORT_ENCODE by default.
    `on_progress` is called with the fraction of the encode done; the mux that
    follows it is a stream copy of seconds, not worth a share of the bar.
    """
    if temp_video is None:
        temp_video = output_path + '.temp.mp4'
    settings = encode or EXPORT_ENCODE

    frame_pattern = os.path.join(frames_dir, 'frame_%06d.png')
    # The frames on disk are exactly what the encode will consume, so unlike
    # the extraction this stage knows its own total without being told.
    total_frames = len([f for f in os.listdir(frames_dir) if f.endswith('.png')])

    # Pass 1: encode video-only
    _run_reporting([
        ffmpeg_bin(), '-y',
        '-v', 'error',
        '-framerate', str(fps),
        '-i', frame_pattern,
        '-c:v', 'libx264',
        '-preset', settings['preset'],
        '-crf', settings['crf'],
        '-pix_fmt', 'yuv420p',
        temp_video,
    ], total_frames, on_progress)

    # Pass 2: mux original audio + metadata
    _run([
        ffmpeg_bin(), '-y',
        '-v', 'error',
        '-i', temp_video,
        '-i', original_video,
        '-map', '0:v:0',
        '-map', '1:a:0?',
        '-c:v', 'copy',
        *audio_args_for(audio_codec),
        '-map_metadata', '1',
        output_path,
    ])

    # Remove intermediate file
    if os.path.exists(temp_video):
        os.remove(temp_video)
