"""
Stand-in for backend/main.py used by the IPC protocol E2E tests.

Reads the same JSON job payload from stdin and emits the same stdout protocol,
so the Electron parser can be exercised without ffmpeg or OpenCV. The payload's
`scenario` key selects what to emit.
"""
import json
import signal
import sys
import time


def emit(msg: str) -> None:
    print(msg, flush=True)


def _sigterm(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _sigterm)

payload = json.loads(sys.stdin.read() or '{}')
scenario = payload.get('scenario', 'success')

if scenario == 'success':
    emit('STATE:meta:' + json.dumps({'width': 640, 'height': 480, 'fps': 30, 'duration': 3}))
    emit('PROGRESS:50.0')
    emit('STATE:Reconstructing pixels...')
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
elif scenario == 'preview':
    emit(f"STATE:preview_ready:{payload.get('outputPath', '')}")
elif scenario == 'error':
    emit('ERROR:Something went wrong in the backend')
    sys.exit(1)
elif scenario == 'hang':
    while True:
        time.sleep(0.1)
