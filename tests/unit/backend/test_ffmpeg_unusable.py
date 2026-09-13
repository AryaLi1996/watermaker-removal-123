"""
Telling a tool that never ran apart from a file that cannot be read.

From a Windows report: ffprobe exited 4294967295 with an empty stderr, and the
app told the user their video was corrupt. It was not — the bundled ffprobe
was a launcher that could not find the program it launches, so it never looked
at the file at all.

The discriminator is stderr. Under `-v error` ffprobe explains every file it
refuses and exits 1; saying nothing means it never got that far.

Run with:
    backend/.venv/bin/python -m pytest tests/unit/backend/ -v
"""
import os
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import pytest

import ff_utils


# Exactly what the Windows report carried: -1 as an unsigned 32-bit exit code.
WINDOWS_MINUS_ONE = 4294967295


def _failing_tool(tmp_path, *, stderr_text: str, exit_code: int) -> str:
    """A stand-in for ffprobe that fails the way we want to test."""
    script = tmp_path / 'fake_ffprobe.py'
    script.write_text(
        'import sys\n'
        f'sys.stderr.write({stderr_text!r})\n'
        f'sys.exit({exit_code})\n',
        encoding='utf-8',
    )
    return str(script)


def test_a_tool_that_fails_without_a_word_is_not_blamed_on_the_file(tmp_path):
    # The reported case: it ran, said nothing, and failed.
    script = _failing_tool(tmp_path, stderr_text='', exit_code=3)

    with pytest.raises(ff_utils.FFmpegNotUsable) as exc:
        ff_utils._run([sys.executable, script])

    said = str(exc.value)
    assert 'could not be started' in said
    # Names the tool and the status, which is what a bug report needs.
    assert 'exited with status 3' in said
    # And says where to look, which is not at the video.
    assert 'bundled FFmpeg' in said


def test_the_windows_exit_code_from_the_report_is_carried_through(tmp_path):
    script = _failing_tool(tmp_path, stderr_text='', exit_code=1)

    with pytest.raises(ff_utils.FFmpegNotUsable) as exc:
        ff_utils._run([sys.executable, script])

    # The type is what matters; the code is whatever the platform reported.
    assert isinstance(exc.value, ff_utils.FFmpegNotUsable)
    assert not isinstance(exc.value, subprocess.CalledProcessError)


def test_a_tool_that_explains_itself_is_still_an_ffmpeg_failure(tmp_path):
    # The ordinary case must not be swept into the new one: a real file
    # problem says so, and that text is what the UI classifies on.
    script = _failing_tool(
        tmp_path,
        stderr_text='[mov,mp4] moov atom not found\nclip.mp4: Invalid data found\n',
        exit_code=1,
    )

    with pytest.raises(ff_utils.FFmpegError) as exc:
        ff_utils._run([sys.executable, script])

    assert 'Invalid data found' in str(exc.value)


def test_whitespace_alone_does_not_count_as_having_explained_itself(tmp_path):
    # stderr_tail drops blank lines, so a tool that emits only newlines has
    # said nothing — and is a broken tool, not a broken file.
    script = _failing_tool(tmp_path, stderr_text='\n  \n\n', exit_code=9)

    with pytest.raises(ff_utils.FFmpegNotUsable):
        ff_utils._run([sys.executable, script])


def test_a_working_tool_is_left_alone(tmp_path):
    script = tmp_path / 'ok.py'
    script.write_text('print("fine")\n', encoding='utf-8')

    result = ff_utils._run([sys.executable, str(script)])

    assert result.returncode == 0


@pytest.mark.parametrize('exit_code', [1, 3, 127, WINDOWS_MINUS_ONE % 256 or 1])
def test_any_silent_failure_reads_the_same_way(tmp_path, exit_code):
    script = _failing_tool(tmp_path, stderr_text='', exit_code=exit_code)

    with pytest.raises(ff_utils.FFmpegNotUsable):
        ff_utils._run([sys.executable, script])


def test_a_cancel_is_not_reported_as_a_broken_installation():
    """
    The case that nearly got mislabelled.

    A cancel kills ffmpeg mid-frame, so it exits non-zero having written
    nothing — the same shape as a binary that could not start. Telling someone
    who pressed Cancel that their installation is broken would be worse than
    the generic message this replaces.
    """
    error: list[BaseException] = []

    def run_long_child():
        try:
            ff_utils._run([sys.executable, '-c', 'import time; time.sleep(30)'])
        except BaseException as exc:  # noqa: BLE001 — recorded for the assertion
            error.append(exc)

    thread = threading.Thread(target=run_long_child)
    thread.start()
    deadline = time.monotonic() + 5
    while ff_utils._active_proc is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert ff_utils._active_proc is not None, 'child never started'

    ff_utils.terminate()
    thread.join(timeout=5)

    assert error, 'the run should have failed'
    assert not isinstance(error[0], ff_utils.FFmpegNotUsable)


def test_the_next_run_after_a_cancel_is_judged_on_its_own(tmp_path):
    """A cancel must not leave the flag set and mask a genuinely broken tool."""
    ff_utils.terminate()  # no child; the flag is whatever it was
    script = _failing_tool(tmp_path, stderr_text='', exit_code=4)

    with pytest.raises(ff_utils.FFmpegNotUsable):
        ff_utils._run([sys.executable, script])
