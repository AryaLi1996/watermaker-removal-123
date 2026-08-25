#!/usr/bin/env python3
"""
Freeze the Python backend into a single self-contained executable.

A packaged Electron app ships neither the venv nor a readable copy of
backend/main.py (it would live inside app.asar, which child processes cannot
read), so the release carries this binary instead and runs it directly.

Usage:
    backend/.venv/bin/python scripts/build_backend.py

Output:
    backend/dist/watermark-backend[.exe]
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

# Windows picks a legacy code page for stdout (cp1252 on the CI runners), and
# the status line below is not encodable in it — printing it raised
# UnicodeEncodeError and failed the release build *after* the freeze had
# already succeeded. Ask for UTF-8 and never let an unprintable character be
# the thing that fails a build.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, 'backend')
DIST = os.path.join(BACKEND, 'dist')
WORK = os.path.join(BACKEND, 'build')
NAME = 'watermark-backend'


def main() -> int:
    entry = os.path.join(BACKEND, 'main.py')
    if not os.path.isfile(entry):
        print(f'ERROR: backend entry point not found: {entry}', file=sys.stderr)
        return 1

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print('ERROR: PyInstaller is not installed in this environment.\n'
              '       backend/.venv/bin/pip install -r backend/requirements.txt',
              file=sys.stderr)
        return 1

    # A stale build directory makes PyInstaller reuse outdated analysis.
    shutil.rmtree(WORK, ignore_errors=True)

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--onefile',
        '--noconfirm',
        '--clean',
        '--name', NAME,
        '--distpath', DIST,
        '--workpath', WORK,
        '--specpath', WORK,
        # main.py imports these as top-level modules, not as a package
        '--paths', BACKEND,
        entry,
    ]
    print('==> ' + ' '.join(cmd))
    result = subprocess.run(cmd, cwd=BACKEND)
    if result.returncode != 0:
        return result.returncode

    produced = os.path.join(DIST, NAME + ('.exe' if os.name == 'nt' else ''))
    if not os.path.isfile(produced):
        print(f'ERROR: expected {produced} to exist', file=sys.stderr)
        return 1

    size_mb = os.path.getsize(produced) / (1024 * 1024)
    print(f'✅ Backend frozen: {produced} ({size_mb:.0f} MB)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
