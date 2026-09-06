"""
The job payload as it actually crosses from Electron to Python.

Ticket 77a named backslash escaping a P0 root cause: a Windows path arriving
as `D:\\\\video\\\\demo.mp4` because something escaped it more than once. It does
not happen, and these tests are here so that stays a checked fact rather than
an argument. `JSON.stringify` escapes each backslash exactly once on the way
out and `json.loads` — which is what pydantic uses — reverses exactly that on
the way in.

The Electron side is represented by the bytes it writes, generated with node
where it is available and asserted against a literal otherwise, so the test
still means something on a machine with no node.

Run with:
    backend/.venv/bin/python -m pytest tests/unit/backend/ -v
"""
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'backend'))

import pytest

import main as backend_main


# A path with everything the ticket's scenarios name at once: a drive letter,
# backslashes, Chinese, a space, and parentheses.
WINDOWS_PATH = 'D:\\视频\\My Videos\\demo_项目 (2024).mp4'
UNC_PATH = '\\\\server\\share\\视频\\clip.mp4'


def _electron_writes(payload: dict) -> bytes:
    """
    The exact bytes `child.stdin.write(JSON.stringify(payload))` produces.

    Node does the encoding, so node is asked; where it is missing, Python's
    own json is a faithful stand-in — both emit UTF-8 JSON with one level of
    backslash escaping, which is the property under test.
    """
    node = shutil.which('node')
    if node is None:
        return json.dumps(payload).encode('utf-8')
    script = 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))'
    return subprocess.run(
        [node, '-e', script, json.dumps(payload)],
        capture_output=True, check=True,
    ).stdout


def test_a_windows_path_arrives_with_the_backslashes_it_left_with():
    raw = _electron_writes({'inputPath': WINDOWS_PATH})

    decoded = json.loads(raw)['inputPath']

    assert decoded == WINDOWS_PATH
    assert decoded.count('\\') == WINDOWS_PATH.count('\\') == 3


def test_the_doubling_on_the_wire_is_json_escaping_and_not_a_second_escape():
    # The wire form genuinely contains `\\`, which is what the ticket saw and
    # read as double-escaping. It is JSON's single escape for one backslash,
    # and decoding gives one back — not two.
    raw = _electron_writes({'inputPath': 'D:\\video\\demo.mp4'})

    assert b'D:\\\\video\\\\demo.mp4' in raw
    assert json.loads(raw)['inputPath'] == 'D:\\video\\demo.mp4'


def test_a_unc_path_keeps_both_of_its_leading_backslashes():
    # The pair at the front is the one place a lost backslash changes what the
    # path means rather than merely breaking it.
    decoded = json.loads(_electron_writes({'inputPath': UNC_PATH}))['inputPath']

    assert decoded == UNC_PATH
    assert decoded.startswith('\\\\server\\share')


def test_the_payload_reader_decodes_a_chinese_path_from_the_wire_bytes(monkeypatch, tmp_path):
    # The whole trip: the bytes Electron writes, through the reader that stopped
    # trusting the console code page, into the model that validates the job.
    clip = tmp_path / '视频' / 'demo_项目 (2024).mp4'
    clip.parent.mkdir()
    clip.write_bytes(b'not really a video')

    raw = _electron_writes({
        'inputPath': str(clip),
        'outputPath': str(tmp_path / 'out.mp4'),
        'roi': {'x': 0, 'y': 0, 'w': 10, 'h': 10},
        'method': 'inpaint',
    })

    class _ByteStdin:
        def __init__(self, data: bytes):
            import io
            self.buffer = io.BytesIO(data)

        def read(self):  # pragma: no cover - the buffer is what gets used
            raise AssertionError('the reader should take the bytes, not the text')

    monkeypatch.setattr('sys.stdin', _ByteStdin(raw))

    config = backend_main.JobConfig.model_validate_json(backend_main.read_job_payload())

    assert config.inputPath == str(clip)
    assert '视频' in config.inputPath


@pytest.mark.parametrize('path_text', [
    'D:\\video\\demo.mp4',
    'D:\\视频\\demo.mp4',
    'D:\\My Videos\\project file.mp4',
    'D:\\video_(2024)\\test@demo.mp4',
    '\\\\server\\share\\video.mp4',
    '/home/user/clips/demo.mp4',
    'D:\\video\\100%_final.mp4',
])
def test_every_shape_of_path_the_ticket_names_survives_the_trip(path_text):
    # The last one is why the ticket's proposed `unquote()` step was left out:
    # `100%_final` is a legal filename, and URL-decoding it corrupts the name.
    assert json.loads(_electron_writes({'inputPath': path_text}))['inputPath'] == path_text
