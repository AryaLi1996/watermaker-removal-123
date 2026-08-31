"""
Unit tests for backend/gpu.py.

No test here needs a GPU, and none may be skipped on a machine without one:
the answers this module gives on a machine *without* a card are the ones the
whole fallback path depends on.
"""
import subprocess

import pytest

import gpu


@pytest.fixture(autouse=True)
def clear_cache():
    """The probe is cached for the process; each test starts from nothing."""
    gpu._cached = None
    yield
    gpu._cached = None


SMI_LINE = 'NVIDIA GeForce RTX 4090, 24564, 550.54.14\n'


def _fake_smi(stdout: str, returncode: int = 0):
    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr='')
    return run


def test_reports_no_device_where_neither_probe_answers(monkeypatch):
    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: None)

    info = gpu.detect()
    assert info.available is False
    assert info.memory_total_mb == 0
    assert info.reason, 'an unavailable GPU has to say why'


def test_reads_name_and_memory_from_nvidia_smi(monkeypatch):
    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', _fake_smi(SMI_LINE))

    info = gpu.detect()
    assert info.available is True
    assert info.name == 'NVIDIA GeForce RTX 4090'
    assert info.memory_total_mb == 24564
    assert info.source == 'nvidia-smi'


def test_takes_the_first_device_where_there_are_several(monkeypatch):
    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run',
                        _fake_smi(SMI_LINE + 'NVIDIA T400, 4096, 550.54.14\n'))

    assert gpu.detect().memory_total_mb == 24564


@pytest.mark.parametrize('stdout,returncode', [
    ('', 0),                    # a driver that answered with nothing
    ('garbage\n', 0),           # a format we do not understand
    ('name, notanumber\n', 0),  # a memory figure we cannot compare against
    (SMI_LINE, 9),              # a driver that failed
])
def test_unusable_smi_output_is_no_device(monkeypatch, stdout, returncode):
    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', _fake_smi(stdout, returncode))

    assert gpu.detect().available is False


def test_a_hanging_driver_is_no_device_rather_than_a_hang(monkeypatch):
    def timeout(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, gpu.SMI_TIMEOUT_SECONDS)

    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', timeout)

    assert gpu.detect().available is False


def test_torch_is_preferred_over_the_driver(monkeypatch):
    """It is the runtime the model will actually use."""
    from_torch = gpu.GpuInfo(True, 'Torch card', 8192, '12.4', 'torch')
    monkeypatch.setattr(gpu, '_probe_torch', lambda: from_torch)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', _fake_smi(SMI_LINE))

    assert gpu.detect().source == 'torch'


def test_the_answer_is_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(gpu, '_probe_torch', lambda: calls.append(1) or None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: None)

    gpu.detect()
    gpu.detect()
    assert len(calls) == 1

    gpu.detect(refresh=True)
    assert len(calls) == 2


def test_the_override_reports_no_device_whatever_the_machine_has(monkeypatch):
    monkeypatch.setenv('WATERMARK_FORCE_NO_GPU', '1')
    monkeypatch.setattr(gpu, '_probe_torch',
                        lambda: gpu.GpuInfo(True, 'card', 99999, '12.4', 'torch'))

    info = gpu.detect()
    assert info.available is False
    assert 'WATERMARK_FORCE_NO_GPU' in info.reason


# ─── The torch probe ────────────────────────────────────────────────────────
#
# PyTorch is not a dependency of this app and is not installed in its
# virtualenv, so a fake one stands in. What is being tested is not torch: it is
# that the three answers it can give — a working card, a CPU-only build, and a
# broken install — are told apart, since only the first may run a model.

class _FakeProperties:
    def __init__(self, name: str, total_memory: int):
        self.name = name
        self.total_memory = total_memory


def install_fake_torch(monkeypatch, *, available=True, raises=False):
    import types

    torch = types.ModuleType('torch')
    torch.version = types.SimpleNamespace(cuda='12.4')
    cuda = types.SimpleNamespace(
        is_available=(lambda: (_ for _ in ()).throw(RuntimeError('driver mismatch')))
        if raises else (lambda: available),
        current_device=lambda: 0,
        get_device_properties=lambda index: _FakeProperties(
            'NVIDIA GeForce RTX 4090', 24 * 1024 * 1024 * 1024),
    )
    torch.cuda = cuda
    monkeypatch.setitem(__import__('sys').modules, 'torch', torch)
    return torch


def test_torch_reports_the_device_it_would_run_on(monkeypatch):
    install_fake_torch(monkeypatch)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: None)

    info = gpu.detect()
    assert info.available is True
    assert info.memory_total_mb == 24576
    assert info.cuda_version == '12.4'
    assert info.source == 'torch'


def test_a_cpu_only_build_is_no_device_however_the_hardware_looks(monkeypatch):
    """Only torch can tell us this, which is why it is asked first."""
    install_fake_torch(monkeypatch, available=False)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: None)

    assert gpu.detect().available is False


def test_a_broken_torch_install_falls_through_to_the_driver(monkeypatch):
    install_fake_torch(monkeypatch, raises=True)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: '/usr/bin/nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', _fake_smi(SMI_LINE))

    assert gpu.detect().source == 'nvidia-smi'
