"""
Multi-core parallel frame processor.
Passes file paths to workers — no large arrays go through IPC queues.
Each worker reads from disk, processes, and writes back.

Temporal inpainting is the one engine that needs more than the frame it is
given, so its workers are handed the paths of the neighbouring frames too and
write their results to a separate directory: a frame is a neighbour of the
frames around it, and painting over it while they still need to read it would
feed each reconstruction the previous one's output.

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
import shutil
import sys
from collections import OrderedDict

import cv2

import dewatermark
import recover
import temporal_core
from image_core import apply_removal, create_mask

# Module-level reference to the active Pool so external code (signal handlers)
# can call terminate() to abort in-progress frame processing.
_current_pool: 'multiprocessing.Pool | None' = None


def terminate() -> None:
    """
    Abort any active batch: the worker pool, and the ProPainter child if the
    deep engine is the one running. Only one of the two can be in flight, but
    which one is not worth tracking — both calls are no-ops when idle, and
    getting it wrong leaves a process holding a GPU after the user cancelled.
    """
    global _current_pool
    if _current_pool is not None:
        _current_pool.terminate()
        _current_pool = None

    # Imported here rather than at module scope: the deep engine is the
    # exception, and a cancel must not be the thing that first imports it.
    loaded = sys.modules.get('propainter_engine')
    if loaded is not None:
        loaded.terminate()


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

# Temporal inpainting reads several neighbouring frames and computes optical
# flow against each, so a single frame of it costs more than the pool's whole
# start-up. Anything past one frame is worth a worker.
TEMPORAL_SEQUENTIAL_FRAME_LIMIT = 1

# Temporal results are written here first and moved over the originals only
# once the batch is complete: a worker reconstructing frame N reads frames
# N±k, which must still be the frames ffmpeg extracted rather than ones an
# earlier worker has already painted. Sibling of the frames directory so the
# frame pattern ffmpeg reassembles from stays untouched.
TEMPORAL_OUTPUT_DIR = 'temporal_out'

# Frames handed to one recovery worker. The solved model travels with the job,
# and it is the size of the mark — a few hundred kilobytes. Sending it once per
# frame would pickle it thousands of times for work that takes milliseconds;
# sending it once per chunk of this many amortises it away while still leaving
# enough jobs for every core to have several.
RECOVER_CHUNK_FRAMES = 48

# Chunks below which a pool is not worth starting. Lower than the single-frame
# limit because each chunk is already dozens of frames of work.
RECOVER_SEQUENTIAL_CHUNK_LIMIT = 2

# Where scanning and solving end on the bar for a recovery run. Neither reports
# per-frame progress of its own, and a bar that sits at zero through a scan of
# several hundred frames reads as a hung job.
SCAN_PROGRESS_SHARE = 15.0
FIT_PROGRESS_SHARE = 25.0

# Where the deep engine writes its mask and the frames it produces. Beside the
# frames directory rather than in it, for the same reason as above: ffmpeg
# reassembles that directory by filename pattern and must not meet a second
# copy of every frame.
DEEP_WORK_DIR = 'propainter'

# How many decoded neighbours each worker keeps. Consecutive frames ask for
# almost the same neighbours, so even a handful turns most of the reads into
# hits; every entry is a full frame, held per worker, so this trades memory
# for decode time and the small number is deliberate.
# WATERMARK_TEMPORAL_CACHE overrides it.
TEMPORAL_CACHE_FRAMES = 4


def _cache_size() -> int:
    try:
        return max(0, int(os.environ.get('WATERMARK_TEMPORAL_CACHE', TEMPORAL_CACHE_FRAMES)))
    except ValueError:
        return TEMPORAL_CACHE_FRAMES


# Per-worker, and only ever holds source frames — see TEMPORAL_OUTPUT_DIR.
_neighbor_cache: 'OrderedDict[str, object]' = OrderedDict()


def _read_cached(path: str):
    """Decode a neighbouring frame, remembering the last few."""
    limit = _cache_size()
    if limit == 0:
        return cv2.imread(path)

    frame = _neighbor_cache.get(path)
    if frame is None:
        frame = cv2.imread(path)
        if frame is None:
            return None
        _neighbor_cache[path] = frame
        while len(_neighbor_cache) > limit:
            _neighbor_cache.popitem(last=False)
    else:
        _neighbor_cache.move_to_end(path)
    return frame


def _process_temporal_frame(args: tuple) -> 'str | None':
    """
    Worker function for temporal inpainting: read one frame, reconstruct it
    from the neighbours the dispatcher listed, and write it to `out_path`.

    Neighbours are decoded on demand. The engine walks outwards only as far as
    it needs to, so on footage that moves, most of the listed frames are never
    read at all.

    Returns the reason this frame fell back to the single-frame fill, or None
    where it was rebuilt as intended. That answer travels back through the
    pool — one short string per frame, against the whole frame this worker
    already wrote to disk rather than returned — so the dispatcher can count
    them and the user can be told once at the end.
    """
    frame_path, neighbor_paths, out_path, config, mask_params = args

    width, height, x, y, w, h = mask_params
    mask = create_mask(width, height, x, y, w, h)

    frame = cv2.imread(frame_path)
    if frame is None:
        raise IOError(f"Could not read frame: {frame_path}")

    def neighbor_at(offset: int):
        path = neighbor_paths.get(offset)
        return _read_cached(path) if path else None

    # A list rather than a nonlocal: the engine reports at most once per
    # frame, and the first reason is the one worth keeping.
    degraded: list[str] = []

    result = apply_removal(frame, mask, config, neighbor_at=neighbor_at,
                           on_degraded=degraded.append)
    cv2.imwrite(out_path, result, [cv2.IMWRITE_PNG_COMPRESSION, PNG_COMPRESSION])
    return degraded[0] if degraded else None


def _process_single_frame(args: tuple) -> 'str | None':
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
    # Nothing to report: the single-frame engines either work or raise.
    return None


def _process_recover_chunk(args: tuple) -> 'str | None':
    """
    Worker function for watermark recovery: undo the solved blend on a run of
    consecutive frames, in place.

    A chunk rather than a frame because the models travel with the job. Frames
    are written back over themselves, which is safe here in a way it is not for
    the temporal engine: recovery reads nothing but the frame it is writing, and
    `recover.schedule` has already guaranteed that no other job holds this one.

    More than one model where a frame is covered by two placements at once,
    which is what the frames around a move look like.
    """
    frame_paths, models = args

    for frame_path in frame_paths:
        frame = cv2.imread(frame_path)
        if frame is None:
            raise IOError(f"Could not read frame: {frame_path}")
        for model in models:
            frame = dewatermark.restore(frame, model)
        cv2.imwrite(frame_path, frame,
                    [cv2.IMWRITE_PNG_COMPRESSION, PNG_COMPRESSION])
    return None


def _temporal_jobs(
    frame_paths: list[str],
    config: dict,
    mask_params: tuple,
    out_dir: str,
) -> list[tuple]:
    """
    One job per frame, each carrying the paths of the neighbours its quality
    setting may ask for — its reach either side, minus whatever falls off the
    ends of the video. Listing a frame is not reading it: the engine walks
    outwards only as far as it needs to and decodes as it goes.
    """
    settings = temporal_core.quality_settings(
        config.get('temporalQuality', temporal_core.DEFAULT_QUALITY))
    total = len(frame_paths)

    jobs = []
    for index, path in enumerate(frame_paths):
        neighbors = {
            offset: frame_paths[index + offset]
            for offset in range(-settings.reach, settings.reach + 1)
            if offset != 0 and 0 <= index + offset < total
        }
        out_path = os.path.join(out_dir, os.path.basename(path))
        jobs.append((path, neighbors, out_path, config, mask_params))
    return jobs


def _commit_temporal(frame_paths: list[str], out_dir: str) -> None:
    """
    Move the reconstructed frames over the originals, once every worker has
    finished reading them. A cancelled batch never gets here, and its
    half-written directory goes with the job's temp directory.
    """
    for path in frame_paths:
        produced = os.path.join(out_dir, os.path.basename(path))
        if os.path.exists(produced):
            os.replace(produced, path)
    shutil.rmtree(out_dir, ignore_errors=True)


def _dispatch(
    worker, jobs: list[tuple], sequential_limit: int, progress_callback=None,
) -> list:
    """
    Run `worker` over `jobs`, on all available cores when there is enough work
    to be worth a pool and in this process when there is not.

    Returns whatever the workers returned, in no particular order — the pool
    is unordered and the callers only count. A worker that has nothing to say
    returns None, which is most of them.
    """
    total = len(jobs)
    # More workers than frames only pays start-up costs for processes that
    # would get one frame or none.
    workers = min(os.cpu_count() or 1, total)

    def report(done: int) -> None:
        if progress_callback:
            progress_callback(done / total * 100)

    results = []

    if total <= sequential_limit or workers == 1:
        # In-process, with OpenCV left on its own defaults: nothing else is
        # competing for the machine, and there is no pool to wait for.
        for done, job in enumerate(jobs, start=1):
            results.append(worker(job))
            report(done)
        return results

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
            for result in pool.imap_unordered(worker, jobs, chunksize=chunk_size):
                results.append(result)
                completed += 1
                report(completed)
            _current_pool = None
    finally:
        cv2.setNumThreads(previous_threads)

    return results


def _sibling_dir(frame_paths: list[str], name: str) -> str:
    """A directory beside the frames directory, created if it is not there."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(frame_paths[0])), name)
    os.makedirs(path, exist_ok=True)
    return path


def _run_deep(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    progress_callback=None,
    on_notice=None,
) -> bool:
    """
    Hand the batch to ProPainter. True where it did the work, False where the
    caller should run the optical-flow engine over the same frames instead.

    Every failure here is a fallback, never an error. The deep engine is the
    one part of this pipeline that depends on a GPU, a separate checkout and a
    half-gigabyte download, so it has more ways to be unavailable than the
    rest of the app put together — and none of them are a reason to lose an
    export the flow engine can still finish. What is *not* acceptable is doing
    that silently, so each one is reported to the caller for the UI to relay.
    """
    import propainter_engine  # noqa: PLC0415 — deliberately deferred, see terminate()

    def notice(key: str, detail: str) -> None:
        if on_notice:
            on_notice(key, detail)

    work_dir = _sibling_dir(frame_paths, DEEP_WORK_DIR)
    requested = config.get('temporalQuality', propainter_engine.DEFAULT_QUALITY)

    try:
        settings = propainter_engine.inpaint_frames(
            frame_paths, config, width, height, work_dir,
            progress_callback=progress_callback,
        )
    except propainter_engine.ProPainterError as exc:
        notice('deep_fallback', str(exc))
        return False
    except Exception as exc:
        # Deliberately broad. Everything past the engine's own errors is still
        # a reason to run the flow engine rather than to lose the export: a
        # failed weights download, an unreadable frame, a checkout that moved
        # mid-job. The class name goes in the notice so a genuine bug in here
        # is visible rather than disguised as a missing GPU.
        notice('deep_fallback', f'{type(exc).__name__}: {exc}')
        return False
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    # A card too small for the preset the user picked runs the next one down
    # rather than refusing. That is the right trade, and it is still a
    # different result from the one they asked for.
    if settings.name != requested:
        notice('deep_quality', settings.name)
    return True


def _run_recover(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    progress_callback=None,
    on_notice=None,
) -> None:
    """
    Find the mark over the whole sequence, solve it where it sits, and undo the
    blend on the frames it covers.

    Where the job carries confirmed regions — a survey the user was shown and
    agreed with, or boxes they drew — those are what runs, exactly as given.
    Otherwise the user's box is a hint, not a boundary: it says which of the
    things that hold still is the one they want gone. Where the scan finds nothing under it
    — footage too short to scan, a box drawn over nothing, a mark that moves
    with the picture — the box itself is solved as a single placement over the
    whole clip: the user did point at something, and solving what they pointed
    at is a far better answer than an export that silently did nothing.

    Frames no placement covers are left exactly as they were decoded. On a clip
    whose mark appears halfway through, the first half is the original picture
    rather than a re-encode of a guess at it.
    """
    def notice(key: str, detail: str) -> None:
        if on_notice:
            on_notice(key, detail)

    def report(value: float) -> None:
        if progress_callback:
            progress_callback(max(0.0, min(100.0, value)))

    def read(index: int):
        return cv2.imread(frame_paths[index])

    total = len(frame_paths)
    roi = config['roi']
    box = (roi['x'], roi['y'], roi['w'], roi['h'])

    # Too little footage to solve a blend from. The frames are left exactly as
    # they were decoded, which is the only honest answer: this engine recovers
    # the picture from what moves behind the mark, and here nothing has.
    # The still the app shows when a video opens is a single frame, so this is
    # the first thing recovery is asked to do on every video.
    if total < recover.MIN_SOLVE_FRAMES:
        notice('recover_too_short',
               f'{total} frame(s) is too few to solve a blend from; frames left as they are')
        report(100.0)
        return

    def solving(done: int, count: int) -> None:
        report(SCAN_PROGRESS_SHARE
               + (FIT_PROGRESS_SHARE - SCAN_PROGRESS_SHARE) * done / max(count, 1))

    # Regions the user has confirmed are not re-litigated. They were found by a
    # survey they were shown and agreed with, or drawn by hand; scanning again
    # here would be slower and could disagree with what they approved, which is
    # the one thing a confirmation step must not do.
    confirmed = config.get('regions') or []
    if confirmed:
        solved = []
        for done, region in enumerate(confirmed, start=1):
            placement = recover.Placement(
                region['start'], region['end'],
                recover.clamp_box((region['x'], region['y'], region['w'], region['h']),
                                  width, height))
            if placement.frames < recover.MIN_SOLVE_FRAMES:
                continue
            model = recover.fit_placement(read, placement)
            if recover.believable(model):
                solved.append((placement, model))
            solving(done, len(confirmed))
        skipped = len(confirmed) - len(solved)
        if skipped:
            notice('recover_region_empty',
                   f'{skipped} of {len(confirmed)} confirmed region(s) held no '
                   f'blend to undo and were left alone')
    else:
        solved = recover.locate(read, total, box, width, height, on_progress=solving)

    if not solved and not confirmed:
        # The user pointed at something, so solve what they pointed at. It is
        # the old behaviour, and a far better answer than an export that
        # silently did nothing.
        fallback = recover.Placement(0, total, recover.clamp_box(box, width, height))
        solved = [(fallback, recover.fit_placement(read, fallback))]
        notice('recover_no_mark', 'no mark found by the scan; solving the selection')

    if not solved:
        report(100.0)
        return

    placements = [placement for placement, _ in solved]
    models = [model for _, model in solved]

    # Distinct frames, not the sum of the placements' own lengths: they overlap
    # around a move, and a count larger than the video reads as a bug.
    covered = len({index for placement in placements
                   for index in range(placement.start, placement.end)})
    notice('recover_placements',
           f'{len(placements)} placement(s) over {covered}/{total} frames')
    report(FIT_PROGRESS_SHARE)

    jobs: list[tuple] = []
    for run_start, run_end, needed in recover.schedule(placements, models, total):
        for start in range(run_start, run_end, RECOVER_CHUNK_FRAMES):
            jobs.append((frame_paths[start:min(start + RECOVER_CHUNK_FRAMES, run_end)],
                         needed))

    remaining = 100.0 - FIT_PROGRESS_SHARE
    _dispatch(_process_recover_chunk, jobs, RECOVER_SEQUENTIAL_CHUNK_LIMIT,
              lambda value: report(FIT_PROGRESS_SHARE + value * remaining / 100.0))


def run_batch(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    progress_callback=None,
    on_notice=None,
) -> int:
    """
    Process every frame with the engine the config names.

    :param frame_paths: Ordered list of absolute PNG paths. The order is what
        the temporal engine reads as time, so it has to be the frame order.
    :param config: Removal config dict (method, roi, radius, …).
    :param width: Native video width (pixels).
    :param height: Native video height (pixels).
    :param progress_callback: Optional callable(float 0–100) for progress.
    :param on_notice: Optional callable(key, detail) for something the user
        should be told about the run that is not a failure — the deep engine
        falling back to the flow one, or running at a lower preset than was
        asked for.
    :returns: How many frames a failure pushed onto the single-frame fill.
        Zero for every engine but the temporal one, and for a temporal run
        where nothing went wrong.
    """
    roi = config['roi']
    mask_params = (width, height, roi['x'], roi['y'], roi['w'], roi['h'])

    if len(frame_paths) == 0:
        return 0

    if config.get('method') == 'recover':
        _run_recover(frame_paths, config, width, height, progress_callback, on_notice)
        return 0

    if config.get('method') == 'temporal':
        # The learned engine, where the job asked for it and the machine can
        # carry it. It repaints the frames in place, so a run that succeeds
        # leaves nothing for the flow engine below to do.
        if config.get('temporalEngine') == 'deep' and _run_deep(
                frame_paths, config, width, height, progress_callback, on_notice):
            return 0

        # Written beside the frames, not among them: ffmpeg reassembles the
        # directory by filename pattern and must not meet a second copy.
        out_dir = os.path.join(
            os.path.dirname(os.path.dirname(frame_paths[0])), TEMPORAL_OUTPUT_DIR)
        os.makedirs(out_dir, exist_ok=True)
        jobs = _temporal_jobs(frame_paths, config, mask_params, out_dir)
        reasons = _dispatch(_process_temporal_frame, jobs,
                            TEMPORAL_SEQUENTIAL_FRAME_LIMIT, progress_callback)
        _commit_temporal(frame_paths, out_dir)
        return sum(1 for reason in reasons if reason)

    jobs = [(fp, config, mask_params) for fp in frame_paths]
    _dispatch(_process_single_frame, jobs, SEQUENTIAL_FRAME_LIMIT, progress_callback)
    return 0
