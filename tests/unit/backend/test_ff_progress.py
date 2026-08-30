"""
Unit tests for the progress and timeout layer in backend/ff_utils.py.

These drive stand-in "ffmpeg" scripts rather than the real thing: what is
under test is how ffmpeg's `-progress` output is turned into a moving bar and
what happens to a call that never comes back, neither of which needs a video —
and both of which have to hold on a machine with no ffmpeg installed.
"""
import sys
import textwrap
import time

import pytest

import ff_utils


@pytest.fixture(autouse=True)
def interpreter_safe_progress_args(monkeypatch):
    """
    Stand in for ffmpeg's `-progress` flags with options the interpreter
    accepts and ignores.

    ff_utils puts those flags straight after the binary, and the binary in
    these tests is the interpreter running the stub below — which would try
    to parse `-progress` as one of its own options. Swapping them keeps the
    stub an ordinary Python script, runnable on Windows as well as POSIX.
    Where the real flags go is covered on its own, below.
    """
    monkeypatch.setattr(ff_utils, '_PROGRESS_ARGS', ['-X', 'utf8'])


def _stub(tmp_path, body: str) -> str:
    """A Python script that stands in for the ffmpeg binary."""
    path = tmp_path / 'fake_ffmpeg.py'
    path.write_text(textwrap.dedent(body))
    return str(path)


def _cmd(script: str, *args: str) -> list[str]:
    return [sys.executable, script, *args]


# ─── progress reporting ──────────────────────────────────────────────────────

COUNTS_TO_TEN = """
    import sys
    sys.stdout.write(' '.join(sys.argv[1:]) + '\\n')
    for frame in range(1, 11):
        sys.stdout.write('bitrate=N/A\\n')
        sys.stdout.write(f'frame={frame}\\n')
        sys.stdout.flush()
    sys.stdout.write('progress=end\\n')
"""


def test_a_long_call_reports_where_it_is(tmp_path):
    """The whole point: a stage of minutes moves the bar while it runs."""
    seen = []
    ff_utils._run_reporting(_cmd(_stub(tmp_path, COUNTS_TO_TEN)), 10, seen.append)

    assert seen, 'nothing was reported for a call that announced ten frames'
    assert seen == sorted(seen), 'progress went backwards'
    assert seen[-1] == pytest.approx(1.0)
    assert all(0 < value <= 1 for value in seen)


def test_it_asks_ffmpeg_for_progress_only_when_it_can_use_it(tmp_path):
    """
    A fraction needs a denominator. With no frame count to measure against —
    a probe of a file whose duration ffprobe did not report — the call is run
    the plain way rather than with an option whose output nothing reads.
    """
    script = _stub(tmp_path, COUNTS_TO_TEN)

    with_progress = ff_utils._run_reporting(_cmd(script), 10, lambda _: None)
    assert with_progress.returncode == 0

    without = ff_utils._run_reporting(_cmd(script), None, lambda _: None)
    # The plain runner captures stdout, so the arguments the stub echoed back
    # are readable here; the reporting one consumes stdout for progress. The
    # stub echoes what it was given, and a plain run adds nothing to it.
    assert without.stdout.decode().splitlines()[0] == ''


def test_the_progress_options_go_where_ffmpeg_expects_them(monkeypatch):
    """
    `-progress` is a global option: it belongs between the binary and the
    first of the call's own arguments, not appended after the output file
    where ffmpeg would read it as an option to the output.
    """
    monkeypatch.undo()  # this one wants the real flags

    class Stopped(Exception):
        pass

    seen = []

    def fake_popen(cmd):
        seen.append(cmd)
        raise Stopped

    monkeypatch.setattr(ff_utils, '_popen', fake_popen)
    with pytest.raises(Stopped):
        ff_utils._run_reporting(['ffmpeg', '-i', 'in.mp4', 'out.mp4'], 10, lambda _: None)

    assert seen == [['ffmpeg', '-progress', 'pipe:1', '-nostats', '-i', 'in.mp4', 'out.mp4']]


def test_a_report_that_overruns_its_estimate_stops_at_the_end(tmp_path):
    """
    The frame count is the caller's estimate from duration x fps, and a
    variable-frame-rate file has more frames than that. A bar that ran past
    100% would be worse than one that sat at it.
    """
    seen = []
    ff_utils._run_reporting(_cmd(_stub(tmp_path, COUNTS_TO_TEN)), 4, seen.append)
    assert max(seen) == pytest.approx(1.0)


def test_a_failure_still_says_what_the_tool_said(tmp_path):
    """
    stderr is drained on a thread while stdout is read for progress; losing it
    would leave a disk-full or permission failure indistinguishable from any
    other non-zero exit.
    """
    script = _stub(tmp_path, """
        import sys
        sys.stdout.write('frame=1\\n')
        sys.stdout.flush()
        sys.stderr.write('No space left on device\\n')
        sys.exit(1)
    """)

    with pytest.raises(ff_utils.FFmpegError) as failure:
        ff_utils._run_reporting(_cmd(script), 10, lambda _: None)
    assert 'No space left on device' in str(failure.value)


def test_a_flood_of_stderr_does_not_wedge_the_call(tmp_path):
    """
    A child whose stderr pipe fills up blocks until someone empties it, and
    the reader here is busy with stdout. Enough output to overflow the pipe
    buffer several times over proves the drain thread is doing its job.
    """
    script = _stub(tmp_path, """
        import sys
        for frame in range(1, 51):
            sys.stderr.write('x' * 20_000 + '\\n')
            sys.stdout.write(f'frame={frame}\\n')
            sys.stdout.flush()
    """)

    seen = []
    ff_utils._run_reporting(_cmd(script), 50, seen.append)
    assert seen[-1] == pytest.approx(1.0)


# ─── timeouts ────────────────────────────────────────────────────────────────

HANGS = """
    import time
    time.sleep(60)
"""


def test_a_call_that_never_answers_is_stopped(tmp_path):
    """
    A probe or a still is the only thing between the user and the canvas. One
    that hangs used to spin until the renderer's own 90-second timeout, with
    the ffmpeg process left running behind it.
    """
    started = time.monotonic()
    with pytest.raises(ff_utils.FFmpegTimeout) as failure:
        ff_utils._run(_cmd(_stub(tmp_path, HANGS)), timeout=0.5)

    assert time.monotonic() - started < 30
    # The renderer classifies failures by matching on this text.
    assert 'timed out' in str(failure.value)


def test_a_timed_out_call_leaves_no_process_behind(tmp_path):
    """An orphan keeps burning CPU and writing into a temp dir being deleted."""
    with pytest.raises(ff_utils.FFmpegTimeout):
        ff_utils._run(_cmd(_stub(tmp_path, HANGS)), timeout=0.5)
    assert ff_utils._active_proc is None


def test_a_prompt_call_is_not_touched_by_its_ceiling(tmp_path):
    script = _stub(tmp_path, "print('done')")
    result = ff_utils._run(_cmd(script), timeout=30)
    assert result.returncode == 0


def test_the_probe_and_still_carry_a_ceiling():
    """
    Both run while the user waits on a spinner with nothing else happening;
    neither does work proportional to the length of the video.
    """
    assert 0 < ff_utils.PROBE_TIMEOUT <= ff_utils.STILL_TIMEOUT
    assert ff_utils.STILL_TIMEOUT <= ff_utils.CLIP_TIMEOUT


def test_an_export_stage_is_left_unbounded(tmp_path, monkeypatch):
    """
    A long export legitimately spends minutes extracting and encoding. A
    ceiling there would kill the job it was meant to protect.
    """
    calls = []
    monkeypatch.setattr(ff_utils, '_run', lambda cmd, timeout=None: calls.append(timeout))
    ff_utils.extract_frames(str(tmp_path / 'in.mp4'), str(tmp_path / 'frames'))
    assert calls == [None]
