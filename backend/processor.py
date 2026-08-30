"""
Multi-core parallel frame processor.
Passes file paths to workers — no large arrays go through IPC queues.
Each worker reads from disk, processes, and writes back.

A batch of a handful of frames is run in this process instead, where a pool
could not pay for itself. The bar for that is low on purpose: measured on a
4-core machine over the 30 frames of a one-second preview, a pool took 1.2s
against 4.2s sequential — and 1.4s when its workers were started the slow
way (spawn, a fresh interpreter and a fresh OpenCV import each), which is how
the packaged mac and Windows builds start them. Short does not mean cheap:
the frames are the same size either way.
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


def opencv_thread_count() -> int:
    """
    How many threads each OpenCV call may use inside a pool worker.

    The pool already occupies every core, but OpenCV defaults to spawning
    threads up to the core count *within each worker* — N workers each trying
    to use N cores. Pinning one thread per worker measured ~6% faster, both
    for the parallel stage alone and end to end.

    WATERMARK_CV_THREADS overrides the count; 0 leaves OpenCV's default alone.
    """
    try:
        return int(os.environ.get('WATERMARK_CV_THREADS', '1'))
    except ValueError:
        return 1


# PNG deflate level for a processed frame written back to the temp directory.
# Matches ff_utils.PNG_COMPRESSION: level 1 writes several times faster than
# OpenCV's default 3 and PNG is lossless either way.
PNG_COMPRESSION = 1

# Below this many frames a pool cannot pay for itself: a couple of frames are
# done in the time the first worker takes to come up. Anything more goes to
# the pool, including a short preview — see the module docstring for the
# measurements behind that.
SEQUENTIAL_FRAME_LIMIT = 4


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
    cv2.imwrite(frame_path, result, [cv2.IMWRITE_PNG_COMPRESSION, PNG_COMPRESSION])


def run_batch(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    progress_callback=None,
) -> None:
    """
    Process every frame, on all available cores when there are enough frames
    to be worth a worker pool and in this process when there are not.

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
    if total == 0:
        return
    # More workers than frames only pays start-up costs for processes that
    # would get one frame or none.
    workers = min(os.cpu_count() or 1, total)

    def report(done: int) -> None:
        if progress_callback:
            progress_callback(done / total * 100)

    if total <= SEQUENTIAL_FRAME_LIMIT or workers == 1:
        # In-process, with OpenCV left on its own defaults: nothing else is
        # competing for the machine, and there is no pool to wait for.
        for done, job in enumerate(jobs, start=1):
            _process_single_frame(job)
            report(done)
        return

    # Apply the thread setting *before* forking, never inside the workers:
    # calling into OpenCV's threading machinery after a fork deadlocks a child
    # when the parent already has a warm thread pool. Forked children inherit
    # whatever the parent had.
    previous_threads = cv2.getNumThreads()
    threads = opencv_thread_count()
    if threads > 0:
        cv2.setNumThreads(threads)

    # Submit in chunks so progress is reported as work completes.
    chunk_size = max(1, total // (workers * 4))
    completed = 0

    try:
        with multiprocessing.Pool(processes=workers) as pool:
            global _current_pool
            _current_pool = pool
            for _ in pool.imap_unordered(_process_single_frame, jobs, chunksize=chunk_size):
                completed += 1
                report(completed)
            _current_pool = None
    finally:
        cv2.setNumThreads(previous_threads)
