"""
Multi-core parallel frame processor.
Passes file paths to workers — no large arrays go through IPC queues.
Each worker reads from disk, processes, and writes back.
"""
import multiprocessing
import os

import cv2

from image_core import apply_removal, create_mask

# Module-level reference to the active Pool so external code (signal handlers)
# can call terminate() to abort in-progress frame processing.
_current_pool: 'multiprocessing.Pool | None' = None


def terminate() -> None:
    """Abort any active parallel batch by terminating the worker pool."""
    global _current_pool
    if _current_pool is not None:
        _current_pool.terminate()
        _current_pool = None


def _process_single_frame(args: tuple) -> None:
    """
    Worker function: read one PNG, apply removal, write back.
    Designed for starmap — receives a pre-built tuple for pickle compatibility.
    """
    frame_path, config, mask_params = args

    # Rebuild the mask inside the worker (masks are small, cheap to recreate)
    width, height, x, y, w, h = mask_params
    mask = create_mask(width, height, x, y, w, h)

    frame = cv2.imread(frame_path)
    if frame is None:
        raise IOError(f"Could not read frame: {frame_path}")

    result = apply_removal(frame, mask, config)
    cv2.imwrite(frame_path, result)


def run_batch(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    progress_callback=None,
) -> None:
    """
    Process all frames in parallel using all available CPU cores.

    :param frame_paths: Ordered list of absolute PNG paths.
    :param config: Removal config dict (method, roi, radius, …).
    :param width: Native video width (pixels).
    :param height: Native video height (pixels).
    :param progress_callback: Optional callable(float 0–100) for progress.
    """
    roi = config['roi']
    mask_params = (width, height, roi['x'], roi['y'], roi['w'], roi['h'])
    jobs = [(fp, config, mask_params) for fp in frame_paths]

    total = len(jobs)
    cpu_count = os.cpu_count() or 1

    # Use a pool of workers; submit in chunks so we can report progress
    chunk_size = max(1, total // (cpu_count * 4))
    completed = 0

    with multiprocessing.Pool(processes=cpu_count) as pool:
        global _current_pool
        _current_pool = pool
        for _ in pool.imap_unordered(_process_single_frame, jobs, chunksize=chunk_size):
            completed += 1
            if progress_callback:
                progress_callback(completed / total * 100)
        _current_pool = None
