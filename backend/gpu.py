"""
What this machine can offer a CUDA workload, asked once and cached.

The learned inpainting engine is the only thing here that needs a GPU, and it
needs a fairly specific answer: not "is there a graphics card" but "how many
megabytes of video memory can a model actually allocate". Everything downstream
— which preset runs, whether the deep engine is offered at all, what the
sidebar says — is a comparison against that number, so it is worth getting from
the most authoritative source available rather than guessing from a device
name.

Two sources, in order of trust:

  1. ``torch.cuda``. If PyTorch is installed it is the same runtime the model
     will use, so what it reports is what the model will get — including the
     case where a driver exists but the build is CPU-only, which no amount of
     looking at the hardware would reveal.
  2. ``nvidia-smi``. Present on any machine with a working NVIDIA driver, and
     the only source when PyTorch has not been installed yet — which is the
     normal state of a fresh install, and exactly when the UI has to decide
     whether to offer the feature.

Neither being available is a perfectly ordinary answer, not an error: most of
this app's users are on a laptop with no discrete GPU, and they get the
optical-flow engine that has always been here.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class GpuInfo:
    """What one CUDA device offers, or the absence of one."""

    available: bool
    #: Marketing name, for the sidebar. Empty where nothing was found.
    name: str = ''
    #: Total video memory in MB. Total rather than free: free memory swings
    #: with whatever else is on screen, and refusing a preset because a
    #: browser had a video open would be unpredictable in the worst way.
    memory_total_mb: int = 0
    #: CUDA runtime version as reported, e.g. '12.4'. Diagnostic only.
    cuda_version: str = ''
    #: Which of the two probes answered — 'torch', 'nvidia-smi', or ''.
    source: str = ''
    #: Why there is no usable device, for a diagnostic line. Empty when there
    #: is one.
    reason: str = ''

    def to_dict(self) -> dict:
        return asdict(self)


NO_GPU = GpuInfo(available=False, reason='no CUDA device found')

# How long nvidia-smi gets to answer. It is a fast call on a healthy machine
# and a hang on a wedged driver, and this runs while the user waits for a file
# to open.
SMI_TIMEOUT_SECONDS = 5


def _probe_torch() -> GpuInfo | None:
    """
    Ask PyTorch, where it is installed. None means "could not answer" — a
    missing install or a CPU-only build — and lets the next probe try.
    """
    try:
        import torch  # noqa: PLC0415 — optional dependency, probed for
    except Exception:  # ImportError, but a broken install raises other things
        return None

    try:
        if not torch.cuda.is_available():
            return None
        index = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(index)
        return GpuInfo(
            available=True,
            name=props.name,
            memory_total_mb=int(props.total_memory) // (1024 * 1024),
            cuda_version=torch.version.cuda or '',
            source='torch',
        )
    except Exception:
        # A driver mismatch raises out of is_available() on some builds. That
        # is a machine that cannot run the model, but nvidia-smi may still
        # describe it, so fall through rather than deciding here.
        return None


def _probe_nvidia_smi() -> GpuInfo | None:
    """Ask the NVIDIA driver directly. None where it is not installed."""
    smi = shutil.which('nvidia-smi')
    if not smi:
        return None

    try:
        result = subprocess.run(
            [smi, '--query-gpu=name,memory.total,driver_version',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=SMI_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None

    # One line per device; the first is the one torch would pick by default.
    first = result.stdout.strip().splitlines()[0]
    fields = [part.strip() for part in first.split(',')]
    if len(fields) < 2:
        return None
    try:
        memory = int(float(fields[1]))
    except ValueError:
        return None

    return GpuInfo(
        available=True,
        name=fields[0],
        memory_total_mb=memory,
        # The driver version is not the CUDA runtime version, and saying so
        # would be wrong. Left empty; torch fills it in when it is there.
        cuda_version='',
        source='nvidia-smi',
    )


def _detect() -> GpuInfo:
    for probe in (_probe_torch, _probe_nvidia_smi):
        found = probe()
        if found is not None:
            return found
    return NO_GPU


_cached: GpuInfo | None = None


def detect(refresh: bool = False) -> GpuInfo:
    """
    The GPU this process may use.

    Cached: the answer cannot change while the app is running, and both probes
    cost real time — the torch import is seconds on a cold filesystem.

    ``WATERMARK_FORCE_NO_GPU=1`` reports no device whatever the machine has,
    which is how the CPU path is exercised on a machine that has one.
    """
    global _cached
    if os.environ.get('WATERMARK_FORCE_NO_GPU') == '1':
        return GpuInfo(available=False, reason='disabled by WATERMARK_FORCE_NO_GPU')
    if refresh or _cached is None:
        _cached = _detect()
    return _cached
