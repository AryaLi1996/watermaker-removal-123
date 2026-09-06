"""
Windows path handling: the extended-length form, and the payload read that
does not go through the console code page.

Both exist because of the same bug report — Windows users being told a video
"may have been moved, renamed or deleted" while it sat where they left it —
and neither is reproducible on the machine these tests run on. The Windows
transformations are therefore written against `ntpath` and tested directly;
the platform switch around them is tested by faking `os.name`.

Run with:
    backend/.venv/bin/python -m pytest tests/unit/backend/ -v
"""
import builtins
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import pytest

import main as backend_main
import path_utils


def _long_windows_path(suffix: str = 'demo.mp4') -> str:
    """An ordinary-looking Windows path that happens to be past MAX_PATH."""
    deep = '\\'.join(['folder' + str(n) for n in range(40)])
    path = f'D:\\videos\\{deep}\\{suffix}'
    assert len(path) >= path_utils.WINDOWS_MAX_PATH
    return path


# ─── windows_long_path ───────────────────────────────────────────────────────

def test_a_short_path_is_left_exactly_as_it_came():
    # The prefix turns off normalisation, so it is not applied where it buys
    # nothing: below the ceiling the plain spelling is what everything sees.
    assert path_utils.windows_long_path('D:\\videos\\demo.mp4') == 'D:\\videos\\demo.mp4'


def test_a_path_past_max_path_gets_the_extended_prefix():
    long_path = _long_windows_path()
    assert path_utils.windows_long_path(long_path) == '\\\\?\\' + long_path


def test_a_long_unc_path_gets_the_unc_form_of_the_prefix():
    share = '\\\\server\\share\\' + 'x' * 300 + '.mp4'
    assert path_utils.windows_long_path(share) == '\\\\?\\UNC\\server\\share\\' + 'x' * 300 + '.mp4'


def test_forward_slashes_are_squared_up_before_the_prefix_goes_on():
    # The renderer builds the output path by joining with '/', and the
    # extended form hands whatever it is given straight to the filesystem —
    # so a slash that survived this far would reach it as a filename.
    long_path = _long_windows_path().replace('\\', '/')
    result = path_utils.windows_long_path(long_path)
    assert result.startswith('\\\\?\\D:\\videos\\')
    assert '/' not in result


def test_a_relative_segment_is_resolved_rather_than_passed_through():
    long_path = _long_windows_path('sub\\..\\demo.mp4')
    assert path_utils.windows_long_path(long_path).endswith('\\demo.mp4')
    assert '..' not in path_utils.windows_long_path(long_path)


def test_a_path_that_already_carries_the_prefix_is_not_given_a_second_one():
    already = '\\\\?\\' + _long_windows_path()
    assert path_utils.windows_long_path(already) == already


# ─── openable ────────────────────────────────────────────────────────────────

def test_openable_leaves_paths_alone_away_from_windows(monkeypatch):
    # A POSIX path can contain a backslash, and mangling one into a separator
    # would break a file that opens perfectly well today.
    monkeypatch.setattr(os, 'name', 'posix')
    weird = '/home/user/' + 'y' * 300 + '/a\\b.mp4'
    assert path_utils.openable(weird) == weird


def test_openable_applies_the_windows_form_on_windows(monkeypatch):
    monkeypatch.setattr(os, 'name', 'nt')
    long_path = _long_windows_path()
    assert path_utils.openable(long_path) == '\\\\?\\' + long_path


# ─── displayable ─────────────────────────────────────────────────────────────

def test_displayable_takes_the_prefix_back_off():
    long_path = _long_windows_path()
    assert path_utils.displayable('\\\\?\\' + long_path) == long_path


def test_displayable_restores_a_unc_path_to_its_two_backslashes():
    assert path_utils.displayable('\\\\?\\UNC\\server\\share\\a.mp4') == '\\\\server\\share\\a.mp4'


def test_displayable_leaves_an_ordinary_path_untouched():
    assert path_utils.displayable('/home/user/clip.mp4') == '/home/user/clip.mp4'
    assert path_utils.displayable('D:\\videos\\demo.mp4') == 'D:\\videos\\demo.mp4'


def test_openable_and_displayable_round_trip(monkeypatch):
    monkeypatch.setattr(os, 'name', 'nt')
    for original in (_long_windows_path(), 'D:\\videos\\demo.mp4'):
        assert path_utils.displayable(path_utils.openable(original)) == original


# ─── read_job_payload ────────────────────────────────────────────────────────

class _ByteStdin:
    """A stdin whose text side decodes with a legacy code page, as on Windows."""

    def __init__(self, raw: bytes, encoding: str):
        self.buffer = io.BytesIO(raw)
        self._encoding = encoding

    def read(self) -> str:
        return self.buffer.read().decode(self._encoding)


def test_a_chinese_path_survives_a_legacy_console_encoding(monkeypatch):
    # The bug this fixes: Electron writes UTF-8, a cp936 console decodes it as
    # cp936, and the path names a directory that does not exist.
    payload = json.dumps({'inputPath': 'D:\\视频\\demo.mp4'}, ensure_ascii=False)
    monkeypatch.setattr('sys.stdin', _ByteStdin(payload.encode('utf-8'), 'cp936'))

    parsed = json.loads(backend_main.read_job_payload())

    assert parsed['inputPath'] == 'D:\\视频\\demo.mp4'


def test_a_text_only_stdin_is_still_read(monkeypatch):
    # A caller that supplied its own stream has already chosen the decoding.
    monkeypatch.setattr('sys.stdin', io.StringIO('  {"inputPath": "/tmp/a.mp4"}  '))
    assert json.loads(backend_main.read_job_payload())['inputPath'] == '/tmp/a.mp4'


def test_an_empty_stdin_reads_as_empty_either_way(monkeypatch):
    monkeypatch.setattr('sys.stdin', _ByteStdin(b'   \n', 'utf-8'))
    assert not backend_main.read_job_payload()
    monkeypatch.setattr('sys.stdin', io.StringIO('   \n'))
    assert not backend_main.read_job_payload()


# ─── the input path validator ────────────────────────────────────────────────

def _job(**overrides) -> dict:
    job = {
        'inputPath': '/tmp/in.mp4',
        'outputPath': '/tmp/out.mp4',
        'roi': {'x': 0, 'y': 0, 'w': 10, 'h': 10},
        'method': 'inpaint',
    }
    job.update(overrides)
    return job


def test_an_unreadable_input_is_reported_as_unreadable_not_as_missing(tmp_path, monkeypatch):
    # The distinction is the whole point: a file that is there and will not
    # open sends the user looking for a file that never moved. A share lock is
    # not reproducible here, so what is faked is the refusal it produces — the
    # check has to be an open for that to be the thing that fails.
    clip = tmp_path / 'clip.mp4'
    clip.write_bytes(b'x')
    real_open = builtins.open

    def refuse(path, *args, **kwargs):
        if str(path) == str(clip):
            raise PermissionError(13, 'Permission denied')
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, 'open', refuse)

    with pytest.raises(Exception) as exc:
        backend_main.JobConfig(**_job(inputPath=str(clip)))

    assert 'could not be read' in str(exc.value)
    # The reason the OS gave is kept: it is what a bug report needs.
    assert 'Permission denied' in str(exc.value)


def test_a_missing_input_still_reports_that_it_is_missing(tmp_path):
    with pytest.raises(Exception) as exc:
        backend_main.JobConfig(**_job(inputPath=str(tmp_path / 'gone.mp4')))

    assert 'Input file not found' in str(exc.value)


def test_a_readable_input_passes_and_keeps_its_spelling(tmp_path):
    clip = tmp_path / 'clip.mp4'
    clip.write_bytes(b'x')
    # Away from Windows `openable` is the identity, so nothing about the path
    # the rest of the pipeline sees changes.
    assert backend_main.JobConfig(**_job(inputPath=str(clip))).inputPath == str(clip)
