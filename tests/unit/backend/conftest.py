"""
Shared fixtures for the backend tests that need real media.

ffmpeg builds the fixtures, so these tests exercise the same code paths the
app uses instead of mocking the subprocess layer away.
"""
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import path_utils


def _ffmpeg_available() -> bool:
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
        subprocess.run(['ffprobe', '-version'], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


# Media tests need the same ffmpeg the app shells out to; skip rather than fail
# where it is not installed.
requires_ffmpeg = pytest.mark.skipif(
    not _ffmpeg_available(),
    reason='ffmpeg/ffprobe not installed',
)


@pytest.fixture(scope='session')
def existing_file(tmp_path_factory) -> str:
    """
    Any real file on disk, for tests that only need JobConfig's existence
    check to pass. Needs no ffmpeg, so those tests run everywhere.
    """
    path = tmp_path_factory.mktemp('files') / 'clip.mp4'
    path.write_bytes(b'not really a video')
    return str(path)


def _synth_video(path: str, *, seconds: int = 1, fps: int = 10,
                 size: str = '320x240', audio: str | None = 'aac') -> str:
    """Render a small synthetic clip; `audio` None makes it silent."""
    if not _ffmpeg_available():
        pytest.skip('ffmpeg/ffprobe not installed')
    cmd = [
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'lavfi', '-i', f'testsrc=size={size}:rate={fps}:duration={seconds}',
    ]
    if audio:
        cmd += ['-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}',
                '-c:a', audio, '-shortest']
    cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]
    subprocess.run(cmd, capture_output=True, check=True)
    return path


@pytest.fixture(scope='session')
def sample_video(tmp_path_factory) -> str:
    """A 1-second 320x240 clip with an AAC track."""
    path = str(tmp_path_factory.mktemp('media') / 'sample.mp4')
    return _synth_video(path)


@pytest.fixture(scope='session')
def silent_video(tmp_path_factory) -> str:
    """The same clip with no audio stream at all."""
    path = str(tmp_path_factory.mktemp('media') / 'silent.mp4')
    return _synth_video(path, audio=None)


@pytest.fixture
def deep_path_video(sample_video) -> str:
    """
    A real clip sitting at a path past Windows' MAX_PATH.

    Copied rather than rendered into place: building the tree and writing the
    file are setup, and doing them through `path_utils.openable` keeps the
    fixture working on Windows, where neither is possible in the plain
    spelling. That leaves ffprobe and ffmpeg as the only things the test
    itself puts through the extended-length form — which is the part nothing
    covered before, and the part the whole exercise is for.

    Cleaned up here rather than left to `tmp_path`, whose own removal would
    hit the same ceiling.
    """
    root = tempfile.mkdtemp(prefix='wm_deep_')
    deep = root
    # Comfortably past the ceiling once the filename is on the end, so the
    # test is not sitting on the boundary it is checking.
    while len(deep) < path_utils.WINDOWS_MAX_PATH + 40:
        deep = os.path.join(deep, 'a_folder_with_a_long_name')
    os.makedirs(path_utils.openable(deep), exist_ok=True)

    target = os.path.join(deep, 'clip.mp4')
    shutil.copyfile(sample_video, path_utils.openable(target))
    try:
        yield target
    finally:
        shutil.rmtree(path_utils.openable(root), ignore_errors=True)


def _first_available_encoder(candidates: tuple[str, ...]) -> str | None:
    """
    Return the first encoder this ffmpeg build actually has.

    Builds differ: Homebrew's ffmpeg ships without libvorbis, so a fixture that
    hard-codes one encoder fails on macOS while passing on Linux.
    """
    try:
        listing = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'],
                                 capture_output=True, check=True).stdout.decode()
    except (OSError, subprocess.CalledProcessError):
        return None
    return next((name for name in candidates if f' {name} ' in listing), None)


@pytest.fixture(scope='session')
def nonmp4_audio_video(tmp_path_factory) -> str:
    """
    A .mkv whose audio codec MP4 cannot carry, so the mux has to transcode.

    flac is a native ffmpeg encoder and present nearly everywhere; opus and
    vorbis stand in where a build lacks it.
    """
    codec = _first_available_encoder(('flac', 'libopus', 'libvorbis'))
    if codec is None:
        pytest.skip('no non-MP4 audio encoder available in this ffmpeg build')
    path = str(tmp_path_factory.mktemp('media') / f'{codec}.mkv')
    return _synth_video(path, audio=codec)
