"""
Environment validation script (Task 1.2).
Asserts cv2 is importable and ffmpeg/ffprobe are on PATH.
Exits 0 on success, 1 on failure.
"""
import shutil
import sys


def main():
    errors = []

    # Check OpenCV
    try:
        import cv2
        print(f"[OK] opencv-contrib-python {cv2.__version__}")
    except ImportError as e:
        errors.append(f"[FAIL] opencv import error: {e}")

    # Check numpy
    try:
        import numpy as np
        print(f"[OK] numpy {np.__version__}")
    except ImportError as e:
        errors.append(f"[FAIL] numpy import error: {e}")

    # Check pydantic
    try:
        import pydantic
        print(f"[OK] pydantic {pydantic.__version__}")
    except ImportError as e:
        errors.append(f"[FAIL] pydantic import error: {e}")

    # Check ffmpeg on PATH
    ffmpeg_path = shutil.which('ffmpeg')
    if ffmpeg_path:
        print(f"[OK] ffmpeg found at {ffmpeg_path}")
    else:
        errors.append("[FAIL] ffmpeg not found on PATH. Install FFmpeg and ensure it is accessible.")

    # Check ffprobe on PATH
    ffprobe_path = shutil.which('ffprobe')
    if ffprobe_path:
        print(f"[OK] ffprobe found at {ffprobe_path}")
    else:
        errors.append("[FAIL] ffprobe not found on PATH.")

    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        sys.exit(1)
    else:
        print("\nAll checks passed.")
        sys.exit(0)


if __name__ == '__main__':
    main()
