"""
Stand-in for backend/main.py used by the IPC protocol E2E tests.

Reads the same JSON job payload from stdin and emits the same stdout protocol,
so the Electron parser can be exercised without ffmpeg or OpenCV. The payload's
`scenario` key selects what to emit; when it is absent (the renderer's own
payloads), the job `mode` decides.
"""
import base64
import json
import os
import signal
import sys
import tempfile
import time


# A 1x1 PNG the renderer can actually load as the preview still.
FRAME_PNG = os.path.join(tempfile.gettempdir(), 'fake_backend_frame.png')
_PNG_BYTES = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)


def _write_frame() -> None:
    with open(FRAME_PNG, 'wb') as fh:
        fh.write(_PNG_BYTES)


def emit(msg: str) -> None:
    print(msg, flush=True)


def _sigterm(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _sigterm)

payload = json.loads(sys.stdin.read() or '{}')

# The renderer sends real job payloads with no `scenario` key; derive one from
# the job mode so the app's own flows (preview frame, preview clip, export) work.
scenario = payload.get('scenario')
if scenario is None:
    mode = payload.get('mode', 'full')
    scenario = 'frame' if mode == 'preview_frame' else 'preview' if mode == 'preview' else 'success'

if scenario == 'success':
    emit('STATE:meta:' + json.dumps({'width': 640, 'height': 480, 'fps': 30, 'duration': 3}))
    emit('PROGRESS:50.0')
    emit('STATE:stage:processing')
    emit(f"STATE:done:{payload.get('outputPath', '')}")
elif scenario == 'split_line':
    # Write a message in two writes with no newline between them, so Electron
    # only sees a complete line after the second chunk arrives.
    sys.stdout.write('PROG')
    sys.stdout.flush()
    time.sleep(0.3)
    sys.stdout.write('RESS:73.5\n')
    sys.stdout.flush()
    emit(f"STATE:done:{payload.get('outputPath', '')}")
elif scenario == 'frame':
    # What backend/main.py emits for a preview_frame job: its stages, the
    # metadata, and a still.
    emit('STATE:stage:probing')
    emit('STATE:meta:' + json.dumps({
        'width': 640, 'height': 480, 'fps': 30, 'duration': 3,
        'videoCodec': 'h264', 'audioCodec': None,
    }))
    emit('STATE:stage:extractingStill')
    _write_frame()
    emit(f'STATE:preview_ready:{FRAME_PNG}')
elif scenario == 'preview':
    emit(f"STATE:preview_ready:{payload.get('outputPath', '')}")
elif scenario == 'temporal_fallback':
    # A temporal export where some frames could not be rebuilt from their
    # neighbours: the count is reported once, after the per-frame work and
    # before the finished file is announced.
    emit('STATE:meta:' + json.dumps({'width': 640, 'height': 480, 'fps': 30, 'duration': 3}))
    emit('STATE:stage:temporalProcessing')
    emit('PROGRESS:94.0')
    emit('STATE:temporal_fallback:7/90')
    emit(f"STATE:done:{payload.get('outputPath', '')}")
elif scenario == 'deep_notice':
    # A job that asked for the learned engine and did not get it, or did not
    # get the preset it asked for. Both notices carry free text, so both have
    # to reach their own channel rather than the status line.
    emit('STATE:meta:' + json.dumps({'width': 640, 'height': 480, 'fps': 30, 'duration': 3}))
    emit('STATE:stage:deepProcessing')
    emit('STATE:deep_quality:balanced')
    emit('STATE:deep_fallback:CUDA out of memory: tried to allocate 2.00 GiB')
    emit(f"STATE:done:{payload.get('outputPath', '')}")
elif scenario == 'error':
    emit('ERROR:Something went wrong in the backend')
    sys.exit(1)
elif scenario == 'hang':
    while True:
        time.sleep(0.1)
