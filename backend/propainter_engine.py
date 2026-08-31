"""
The learned tier of temporal fill: ProPainter, driven as a subprocess.

`temporal_core` recovers the background behind a mark from the frames either
side of it, which works whenever the picture moved. When it did not — a
locked-off camera over a still background, a logo over a plain sky — there is
no frame in the video that ever showed those pixels, and no amount of optical
flow will find them. A learned model can invent them plausibly, and ProPainter
is the best of the open ones: flow-guided propagation for the pixels that do
exist somewhere, a transformer for the ones that do not.

It is a separate program, not a library, and this module keeps it that way.
That is a deliberate boundary:

  * It wants PyTorch and CUDA — well over a gigabyte of wheels this app does
    not otherwise need, and which cannot be frozen into the installer.
  * It allocates most of a GPU's memory and, at the wrong settings, dies of
    it. A subprocess dying is a fallback; this process dying is a lost export.
  * Its command line is its API, and a stable one, so driving it costs less
    than vendoring it and tracking its internals.

So: this app extracts frames as it always does, writes a mask, hands both to
ProPainter, and pastes what comes back over the selection. Everything outside
the mark keeps the resolution and the bytes ffmpeg extracted — the model works
at a resolution its memory budget allows, and only the rectangle it repainted
is scaled back up. A run that cannot start, or that fails, is not fatal: the
caller falls back to the optical-flow engine and says so.

Where ProPainter lives is not this app's decision. ``WATERMARK_PROPAINTER_HOME``
names a checkout; otherwise ``backend/ProPainter`` is used if someone cloned it
there. It is never downloaded automatically — a multi-gigabyte clone is not
something an app should do to a user's disk without being asked.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from glob import glob

import cv2
import numpy as np

import gpu as gpu_probe
import mask_generator
import propainter_weights


# ─── Settings ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Settings:
    """One point on the speed/quality dial, and what it costs in memory."""

    name: str
    #: What the model runs at. Not the video's resolution: memory goes with
    #: pixel count, and the repainted rectangle is scaled back to native size
    #: on the way out, so this trades detail inside the mark for a run that
    #: fits on the card.
    width: int
    height: int
    #: Half precision. Halves the memory for a difference invisible at these
    #: resolutions, and is off only at the top setting where there is room.
    fp16: bool
    #: How many neighbouring frames the transformer attends to directly.
    neighbor_length: int
    #: How far apart the global reference frames are sampled.
    ref_stride: int
    #: Frames held on the GPU at once. This, not the video's length, is what
    #: decides whether a run fits: a ten-minute video is processed in chunks
    #: of this many frames.
    subvideo_length: int
    #: RAFT refinement iterations.
    raft_iter: int
    #: The card this preset needs, in MB. From the authors' own measurements
    #: for the resolution and chunk length above, rounded up — a preset that
    #: fits in theory and OOMs in practice costs the user the whole run.
    min_vram_mb: int


PRESETS: dict[str, Settings] = {
    'fast': Settings(
        name='fast', width=576, height=320, fp16=True,
        neighbor_length=6, ref_stride=15, subvideo_length=40, raft_iter=10,
        min_vram_mb=4096,
    ),
    'balanced': Settings(
        name='balanced', width=720, height=480, fp16=True,
        neighbor_length=10, ref_stride=10, subvideo_length=60, raft_iter=20,
        min_vram_mb=8192,
    ),
    'high': Settings(
        name='high', width=1280, height=720, fp16=True,
        neighbor_length=14, ref_stride=8, subvideo_length=50, raft_iter=20,
        min_vram_mb=20480,
    ),
}

DEFAULT_QUALITY = 'balanced'

#: Slowest last. The order a downgrade walks back through.
QUALITY_ORDER = ('fast', 'balanced', 'high')


def settings_for(quality: str) -> Settings:
    """The preset a quality name asks for, before the machine gets a say."""
    try:
        return PRESETS[quality]
    except KeyError:
        raise ValueError(
            f"Unknown ProPainter quality {quality!r}; expected one of "
            f"{', '.join(QUALITY_ORDER)}."
        ) from None


def select_settings(quality: str, info: 'gpu_probe.GpuInfo | None' = None) -> Settings | None:
    """
    The best preset this card can actually carry, at or below the one asked
    for. None where even the cheapest will not fit — the caller's cue to fall
    back to the optical-flow engine.

    Downgrading rather than refusing is the point: someone with an 8GB card
    who leaves the dial at "high" should get a slightly softer result, not an
    out-of-memory error twenty minutes into an export.
    """
    info = gpu_probe.detect() if info is None else info
    if not info.available:
        return None

    wanted = settings_for(quality)
    # Walk down from what was asked for, never up: a user who picked 'fast'
    # picked it for the speed.
    for name in reversed(QUALITY_ORDER[:QUALITY_ORDER.index(wanted.name) + 1]):
        candidate = PRESETS[name]
        if info.memory_total_mb >= candidate.min_vram_mb:
            return candidate
    return None


# ─── Availability ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Availability:
    """Whether a ProPainter run can be started here, and why not if it cannot."""

    available: bool
    #: A key the renderer translates, or '' when it is available. Keys rather
    #: than prose for the same reason the stage labels are keys: the UI is
    #: bilingual and this process has no business picking the language.
    reason_key: str = ''
    #: One line of detail for a log or a bug report, in English.
    detail: str = ''


AVAILABLE = Availability(True)


def home() -> str:
    """
    The ProPainter checkout this app should drive.

    An explicit ``WATERMARK_PROPAINTER_HOME`` wins; otherwise the conventional
    spot beside the backend, which is where the install instructions put it.
    """
    override = os.environ.get('WATERMARK_PROPAINTER_HOME')
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ProPainter')


def inference_script(root: str | None = None) -> str:
    """Path to the entry point this module shells out to."""
    return os.path.join(root or home(), 'inference_propainter.py')


def interpreter() -> str:
    """
    The Python that can import torch.

    Not this one, in general: the shipped app is a frozen executable with no
    interpreter to offer, and even in a dev checkout the backend's virtualenv
    deliberately does not carry PyTorch. ``WATERMARK_PROPAINTER_PYTHON`` names
    it; failing that, a virtualenv inside the checkout is the documented
    layout; failing that, whatever ``python3`` is on PATH.
    """
    override = os.environ.get('WATERMARK_PROPAINTER_PYTHON')
    if override:
        return override

    root = home()
    for relative in (os.path.join('.venv', 'bin', 'python'),
                     os.path.join('.venv', 'Scripts', 'python.exe')):
        candidate = os.path.join(root, relative)
        if os.path.isfile(candidate):
            return candidate

    # A frozen build's sys.executable is the app itself, which would re-enter
    # this dispatcher rather than run a script.
    if getattr(sys, 'frozen', False):
        return 'python3'
    return sys.executable


def availability(info: 'gpu_probe.GpuInfo | None' = None) -> Availability:
    """
    Whether the deep engine can run here. Checked before a job starts, and
    again by the UI so the switch is not offered where it cannot work.

    Missing weights are *not* a reason: they are downloaded on first use, and
    refusing the feature until the user has already used it would be a fine
    joke and a poor design.
    """
    root = home()
    if not os.path.isfile(inference_script(root)):
        return Availability(
            False, 'deep.notInstalled',
            f'no ProPainter checkout at {root}',
        )

    info = gpu_probe.detect() if info is None else info
    if not info.available:
        return Availability(False, 'deep.needsGpu', info.reason or 'no CUDA device')

    smallest = PRESETS[QUALITY_ORDER[0]]
    if info.memory_total_mb < smallest.min_vram_mb:
        return Availability(
            False, 'deep.needsVram',
            f'{info.memory_total_mb}MB of video memory, '
            f'{smallest.min_vram_mb}MB needed',
        )
    return AVAILABLE


# ─── Command ────────────────────────────────────────────────────────────────

def build_command(
    frames_dir: str,
    mask_path: str,
    output_dir: str,
    settings: Settings,
    frame_count: int,
    root: str | None = None,
) -> list[str]:
    """
    The argv for one run.

    Built as a list and returned rather than run, so the interesting part —
    which flags a preset turns into — is testable without a GPU.

    ProPainter takes the frames as a directory and the mask as a single file,
    which it broadcasts over every frame. `--save_frames` is what this app
    actually consumes; the mp4 it also writes is ignored, since the real
    encode happens later against the original audio and frame rate.
    """
    root = root or home()
    # Never ask for a chunk longer than the video: the model allocates for the
    # chunk size it is given, so a 30-frame preview at subvideo_length 60
    # reserves twice the memory it can possibly use.
    subvideo = max(1, min(settings.subvideo_length, frame_count or settings.subvideo_length))

    command = [
        interpreter(), inference_script(root),
        '--video', frames_dir,
        '--mask', mask_path,
        '--output', output_dir,
        '--width', str(settings.width),
        '--height', str(settings.height),
        '--neighbor_length', str(settings.neighbor_length),
        '--ref_stride', str(settings.ref_stride),
        '--subvideo_length', str(subvideo),
        '--raft_iter', str(settings.raft_iter),
        '--save_frames',
    ]
    if settings.fp16:
        command.append('--fp16')
    return command


# ─── Progress ───────────────────────────────────────────────────────────────

# What each phase of a run is worth on this engine's own 0–100. Measured
# roughly on a 300-frame clip: the flow estimate and the transformer dominate
# and everything else is noise, but the two minutes of model loading before
# either starts still has to move the bar or the export looks hung.
_BANDS: tuple[tuple[str, tuple[str, ...], float, float], ...] = (
    ('loading', ('loading model', 'network [', 'pretrained model', 'loading frames'), 0.0, 8.0),
    ('flow', ('computing flow', 'raft', 'optical flow'), 8.0, 40.0),
    ('completion', ('flow completion', 'completing flow'), 40.0, 55.0),
    ('propagation', ('image propagation', 'feature propagation'), 55.0, 68.0),
    ('inpainting', ('inpainting', 'transformer'), 68.0, 96.0),
    ('saving', ('saving', 'writing'), 96.0, 100.0),
)

# tqdm writes "  45%|███ | 9/20 [..." and rewrites the same line with a
# carriage return, so a "line" here can carry several updates. The last
# percentage in it is the current one.
_PERCENT = re.compile(r'(\d{1,3})%\|')
_FRACTION = re.compile(r'(\d+)/(\d+)\s*\[')


class ProgressMapper:
    """
    Turns ProPainter's console chatter into a number between 0 and 100.

    Two things make this less fragile than parsing another program's output
    usually is. It never goes backwards, so a phrase matched out of order
    cannot make the bar jump back; and an unrecognised line moves nothing at
    all, so a version that renames a phase is slower to report rather than
    wrong. The bands are the contract, not the strings.
    """

    def __init__(self) -> None:
        self._band = _BANDS[0]
        self._value = 0.0

    @property
    def value(self) -> float:
        return self._value

    def feed(self, line: str) -> float | None:
        """
        Absorb one line of output. Returns the new percentage where it moved
        and None where it did not, so a caller can skip reporting.
        """
        lowered = line.lower()

        for band in _BANDS:
            if any(marker in lowered for marker in band[1]):
                # Only ever forward: phases are announced in order, and a
                # stray mention of an earlier one must not rewind the bar.
                if _BANDS.index(band) > _BANDS.index(self._band):
                    self._band = band
                break

        _, _, start, end = self._band
        fraction = self._fraction(lowered)
        # A phase announcement with no count of its own still moves the bar to
        # where that phase begins; tqdm on the same line refines it.
        target = start if fraction is None else start + fraction * (end - start)
        return self._advance(target)

    @staticmethod
    def _fraction(line: str) -> float | None:
        """How far through the current phase this line says we are, 0–1."""
        counts = _FRACTION.findall(line)
        if counts:
            done, total = counts[-1]
            if int(total) > 0:
                return min(1.0, int(done) / int(total))
        percents = _PERCENT.findall(line)
        if percents:
            return min(1.0, int(percents[-1]) / 100)
        return None

    def _advance(self, value: float) -> float | None:
        if value <= self._value:
            return None
        self._value = min(100.0, value)
        return self._value


# ─── Running ────────────────────────────────────────────────────────────────

# The live child, so a SIGTERM from Electron can take it down with us. A run
# left behind holds a GPU and writes into a temp directory this process is
# about to delete.
_current: 'subprocess.Popen | None' = None

# How long the child gets to exit on its own after a terminate before it is
# killed. It has CUDA memory to release; a second is generous for that and
# short enough that a cancel still feels immediate.
TERMINATE_GRACE_SECONDS = 1.0


def terminate() -> None:
    """Abort a run in flight. Safe to call when there is none."""
    global _current
    child = _current
    _current = None
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
        try:
            child.wait(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            child.kill()
    except OSError:
        pass  # already gone


def _popen_kwargs() -> dict:
    """
    Start the child in its own process group.

    ProPainter's data loader forks workers of its own. Without a group of
    their own, killing the parent leaves them holding the GPU, and on POSIX a
    Ctrl-C delivered to this app's group would reach them before we could
    stop it.
    """
    if os.name == 'nt':
        return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
    return {'start_new_session': True}


class ProPainterError(RuntimeError):
    """A run that could not be started or did not finish."""


def run(
    command: list[str],
    cwd: str,
    on_progress: Callable[[float], None] | None = None,
    on_log: Callable[[str], None] | None = None,
) -> None:
    """
    Run one ProPainter invocation to completion, reporting progress as it
    talks.

    Raises `ProPainterError` with the child's own last words on a non-zero
    exit — a CUDA out-of-memory message is the single most useful thing this
    module can hand the layer above, and replacing it with "inference failed"
    would throw away the one line that says what to change.
    """
    global _current
    mapper = ProgressMapper()
    tail: list[str] = []

    try:
        child = subprocess.Popen(
            command, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, errors='replace',
            **_popen_kwargs(),
        )
    except OSError as exc:
        raise ProPainterError(f'Could not start ProPainter: {exc}') from exc

    _current = child
    try:
        assert child.stdout is not None
        for raw in child.stdout:
            line = raw.rstrip()
            if not line:
                continue
            if on_log:
                on_log(line)
            # Enough to explain a failure, bounded so a chatty run cannot
            # grow this without limit.
            tail.append(line)
            del tail[:-20]
            value = mapper.feed(line)
            if value is not None and on_progress:
                on_progress(value)
        code = child.wait()
    finally:
        if _current is child:
            _current = None

    if code != 0:
        raise ProPainterError(_failure_message(code, tail))


def _failure_message(code: int, tail: list[str]) -> str:
    """One line naming why the run failed, from the child's last output."""
    for line in reversed(tail):
        lowered = line.lower()
        if 'out of memory' in lowered:
            return (
                'ProPainter ran out of GPU memory. Try a lower quality '
                f'setting or a shorter clip. ({line.strip()})'
            )
        if 'error' in lowered or 'traceback' in lowered:
            return f'ProPainter failed: {line.strip()}'
    return f'ProPainter exited with status {code}.'


# ─── Reading the result back ────────────────────────────────────────────────

def output_frames(output_dir: str) -> list[str]:
    """
    The frames a finished run wrote, in order.

    ProPainter puts them under ``<output>/<name>/frames/``, where ``<name>``
    is the basename of the input it was given. Globbed rather than
    reconstructed: that layout is its choice, not ours, and a version that
    changes it should fail loudly here rather than silently return nothing.
    """
    found = sorted(glob(os.path.join(output_dir, '*', 'frames', '*.png')))
    if not found:
        found = sorted(glob(os.path.join(output_dir, '**', '*.png'), recursive=True))
    return found


def _feather_alpha(shape: tuple[int, int], rect: tuple[int, int, int, int],
                   feather: int) -> np.ndarray:
    """
    A 0–1 blend map: fully the repainted frame inside the mask rectangle,
    fully the original a `feather` band outside it.

    Without this the paste has a hard edge exactly where the model's
    reconstruction meets the untouched picture, and a one-pixel step in
    brightness there is more visible than the watermark was.
    """
    x, y, w, h = rect
    alpha = np.zeros(shape, dtype=np.float32)
    alpha[y:y + h, x:x + w] = 1.0
    if feather > 0:
        # An odd kernel, and wide enough that the ramp actually spans the band.
        size = feather * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (size, size), 0)
    return alpha


# How wide the blend band is, relative to how far the mask was grown past the
# selection. Wider than the growth: the seam wants to land on background the
# model reconstructed, not on the edge of what it reconstructed.
FEATHER_RATIO = 2


def composite(
    frame_paths: list[str],
    produced: list[str],
    width: int,
    height: int,
    roi: dict,
) -> None:
    """
    Paste each repainted rectangle back over the frame it came from.

    Only the rectangle. The model ran at its own resolution and everything it
    returns is a resample of the original; taking the whole frame from it
    would soften a 4K video to 720p to remove a logo in one corner.
    """
    if len(produced) != len(frame_paths):
        raise ProPainterError(
            f'ProPainter returned {len(produced)} frames for '
            f'{len(frame_paths)} inputs.'
        )

    rect = mask_generator.mask_rect(
        width, height, roi['x'], roi['y'], roi['w'], roi['h'])
    x, y, w, h = rect
    feather = max(1, mask_generator.grow_pixels(w, h) * FEATHER_RATIO)
    alpha = _feather_alpha((height, width), rect, feather)

    # The paste only touches the rectangle plus its blend band, so everything
    # is cropped to that: a full-frame blend on a 4K video is tens of
    # milliseconds a frame spent on pixels that cannot change.
    px0, py0 = max(0, x - feather), max(0, y - feather)
    px1, py1 = min(width, x + w + feather), min(height, y + h + feather)
    patch_alpha = alpha[py0:py1, px0:px1, None]

    for original_path, produced_path in zip(frame_paths, produced):
        original = cv2.imread(original_path)
        repainted = cv2.imread(produced_path)
        if original is None or repainted is None:
            raise ProPainterError(f'Could not read frame: {produced_path}')
        if repainted.shape[:2] != (height, width):
            repainted = cv2.resize(repainted, (width, height),
                                   interpolation=cv2.INTER_CUBIC)

        region = original[py0:py1, px0:px1].astype(np.float32)
        incoming = repainted[py0:py1, px0:px1].astype(np.float32)
        blended = region * (1.0 - patch_alpha) + incoming * patch_alpha
        original[py0:py1, px0:px1] = np.clip(blended, 0, 255).astype(np.uint8)

        cv2.imwrite(original_path, original,
                    [cv2.IMWRITE_PNG_COMPRESSION, 1])


# ─── Entry point ────────────────────────────────────────────────────────────

def inpaint_frames(
    frame_paths: list[str],
    config: dict,
    width: int,
    height: int,
    work_dir: str,
    progress_callback: Callable[[float], None] | None = None,
    log_callback: Callable[[str], None] | None = None,
) -> Settings:
    """
    Repaint the selection out of every frame, in place, and return the preset
    that actually ran (which may be below the one asked for — see
    `select_settings`).

    Raises `ProPainterError` for anything that stops the run. The caller
    decides what to do about it; this module never quietly does something else
    instead, because "the deep engine silently did not run" is indistinguishable
    from "the deep engine is not very good" from where the user is sitting.
    """
    if not frame_paths:
        return settings_for(config.get('temporalQuality', DEFAULT_QUALITY))

    ready = availability()
    if not ready.available:
        raise ProPainterError(ready.detail or 'ProPainter is not available here.')

    settings = select_settings(config.get('temporalQuality', DEFAULT_QUALITY))
    if settings is None:
        raise ProPainterError('No ProPainter preset fits this GPU.')

    root = home()
    propainter_weights.ensure(
        root,
        on_progress=(lambda name, pct: log_callback(f'downloading {name} {pct:.0f}%'))
        if log_callback else None,
    )

    mask_path = os.path.join(work_dir, 'mask.png')
    mask_generator.write_static_mask(mask_path, width, height, config['roi'])

    output_dir = os.path.join(work_dir, 'propainter_out')
    os.makedirs(output_dir, exist_ok=True)

    frames_dir = os.path.dirname(frame_paths[0])
    command = build_command(frames_dir, mask_path, output_dir, settings,
                            len(frame_paths), root)
    run(command, cwd=root, on_progress=progress_callback, on_log=log_callback)

    produced = output_frames(output_dir)
    composite(frame_paths, produced, width, height, config['roi'])
    return settings
