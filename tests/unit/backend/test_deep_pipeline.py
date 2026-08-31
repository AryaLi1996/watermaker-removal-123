"""
How the deep engine joins the pipeline: the routing in processor.run_batch and
the decision in main.

The engine itself is stubbed here. What these tests are about is the seam —
that a job which asks for the deep engine gets it, that a job which cannot
have it still produces a finished video, and that neither happens quietly.
"""
import os
import sys

import cv2
import numpy as np
import pytest

import gpu
import main
import processor
import propainter_engine

ROI = {'x': 10, 'y': 10, 'w': 50, 'h': 30}

DEEP_CONFIG = {
    'method': 'temporal',
    'roi': ROI,
    'radius': 3,
    'temporalQuality': 'balanced',
    'temporalEngine': 'deep',
}


def write_frames(directory: str, count: int) -> list[str]:
    os.makedirs(directory, exist_ok=True)
    paths = []
    for index in range(count):
        frame = np.full((240, 320, 3), 120, dtype=np.uint8)
        frame[10:40, 10:60] = 255
        frame[10:40:4, 10:60] = 0
        path = os.path.join(directory, f'frame_{index:06d}.png')
        cv2.imwrite(path, frame)
        paths.append(path)
    return paths


def frames_dir(tmp_path) -> list[str]:
    return write_frames(str(tmp_path / 'job' / 'frames'), 4)


# ─── Routing ────────────────────────────────────────────────────────────────

def test_a_deep_job_goes_to_propainter(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    calls = []

    def fake_inpaint(frame_paths, config, width, height, work_dir, **kwargs):
        calls.append((list(frame_paths), width, height))
        return propainter_engine.PRESETS['balanced']

    monkeypatch.setattr(propainter_engine, 'inpaint_frames', fake_inpaint)
    assert processor.run_batch(paths, DEEP_CONFIG, 320, 240) == 0
    assert calls and calls[0][0] == paths


def test_the_flow_engine_does_not_run_after_a_successful_deep_run(tmp_path, monkeypatch):
    """It would paint over the model's work with a worse reconstruction."""
    paths = frames_dir(tmp_path)
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda *a, **k: propainter_engine.PRESETS['balanced'])
    monkeypatch.setattr(processor, '_dispatch',
                        lambda *a, **k: pytest.fail('the flow engine ran anyway'))

    processor.run_batch(paths, DEEP_CONFIG, 320, 240)


def test_a_flow_job_never_reaches_the_deep_engine(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda *a, **k: pytest.fail('the deep engine ran'))

    flow = dict(DEEP_CONFIG, temporalEngine='flow')
    processor.run_batch(paths, flow, 320, 240)


def test_the_engine_choice_is_ignored_by_the_single_frame_methods(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda *a, **k: pytest.fail('the deep engine ran'))

    processor.run_batch(paths, {'method': 'blur', 'roi': ROI, 'kernelSize': 21,
                                'temporalEngine': 'deep'}, 320, 240)


# ─── Falling back ───────────────────────────────────────────────────────────

def test_a_failed_deep_run_finishes_the_job_on_the_flow_engine(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    before = [cv2.imread(p)[10:40, 10:60].copy() for p in paths]

    def explode(*args, **kwargs):
        raise propainter_engine.ProPainterError('CUDA out of memory')

    monkeypatch.setattr(propainter_engine, 'inpaint_frames', explode)
    processor.run_batch(paths, DEEP_CONFIG, 320, 240)

    for path, original in zip(paths, before):
        assert not np.array_equal(cv2.imread(path)[10:40, 10:60], original), \
            'the frames were left with the watermark on them'


def test_a_failed_deep_run_says_why(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    notices = []

    def explode(*args, **kwargs):
        raise propainter_engine.ProPainterError('CUDA out of memory')

    monkeypatch.setattr(propainter_engine, 'inpaint_frames', explode)
    processor.run_batch(paths, DEEP_CONFIG, 320, 240, on_notice=lambda k, d: notices.append((k, d)))

    assert notices, 'an export that used a different engine must say so'
    key, detail = notices[0]
    assert key == 'deep_fallback'
    assert 'out of memory' in detail


def test_any_other_failure_is_a_fallback_too(tmp_path, monkeypatch):
    """
    A failed weights download or an unreadable frame is still a reason to run
    the flow engine, not to lose an export it can finish.
    """
    paths = frames_dir(tmp_path)
    notices = []

    def explode(*args, **kwargs):
        raise IOError('Could not download ProPainter.pth: no route to host')

    monkeypatch.setattr(propainter_engine, 'inpaint_frames', explode)
    processor.run_batch(paths, DEEP_CONFIG, 320, 240,
                        on_notice=lambda k, d: notices.append((k, d)))

    assert notices and notices[0][0] == 'deep_fallback'
    # And the notice names what actually happened, rather than guessing.
    assert 'no route to host' in notices[0][1]
    assert 'OSError' in notices[0][1] or 'IOError' in notices[0][1]


def test_a_downgraded_preset_is_reported(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    notices = []
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda *a, **k: propainter_engine.PRESETS['fast'])

    processor.run_batch(paths, dict(DEEP_CONFIG, temporalQuality='high'), 320, 240,
                        on_notice=lambda k, d: notices.append((k, d)))
    assert ('deep_quality', 'fast') in notices


def test_the_preset_that_was_asked_for_is_not_reported(tmp_path, monkeypatch):
    paths = frames_dir(tmp_path)
    notices = []
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda *a, **k: propainter_engine.PRESETS['balanced'])

    processor.run_batch(paths, DEEP_CONFIG, 320, 240,
                        on_notice=lambda k, d: notices.append((k, d)))
    assert notices == []


def test_the_work_directory_is_cleaned_up(tmp_path, monkeypatch):
    """It holds a copy of every frame; leaving it doubles the job's disk use."""
    paths = frames_dir(tmp_path)
    seen = []

    def note_dir(frame_paths, config, width, height, work_dir, **kwargs):
        seen.append(work_dir)
        return propainter_engine.PRESETS['balanced']

    monkeypatch.setattr(propainter_engine, 'inpaint_frames', note_dir)
    processor.run_batch(paths, DEEP_CONFIG, 320, 240)

    assert seen and not os.path.exists(seen[0])


def test_the_work_directory_is_beside_the_frames_not_among_them(tmp_path, monkeypatch):
    """ffmpeg reassembles the frames directory by pattern; a second copy breaks it."""
    paths = frames_dir(tmp_path)
    seen = []
    monkeypatch.setattr(propainter_engine, 'inpaint_frames',
                        lambda fp, c, w, h, work_dir, **k: seen.append(work_dir)
                        or propainter_engine.PRESETS['balanced'])

    processor.run_batch(paths, DEEP_CONFIG, 320, 240)
    assert os.path.dirname(seen[0]) != os.path.dirname(paths[0])


def test_cancelling_takes_the_child_down(monkeypatch):
    stopped = []
    monkeypatch.setitem(sys.modules, 'propainter_engine', propainter_engine)
    monkeypatch.setattr(propainter_engine, 'terminate', lambda: stopped.append(True))

    processor.terminate()
    assert stopped == [True]


# ─── Choosing the engine ────────────────────────────────────────────────────

def job(**overrides) -> main.JobConfig:
    base = dict(inputPath=os.path.abspath(__file__), outputPath='/dev/null',
                roi=ROI, method='temporal', useDeepLearning=True)
    base.update(overrides)
    return main.JobConfig(**base)


def test_the_flow_engine_is_the_default():
    assert main.resolve_temporal_engine(job(useDeepLearning=False)) == 'flow'


def test_another_method_never_gets_the_deep_engine():
    assert main.resolve_temporal_engine(job(method='inpaint')) == 'flow'


def test_opening_a_file_never_probes_for_a_gpu(monkeypatch):
    """
    A still for the canvas processes no frames. Probing there would put a GPU
    probe and an OpenCV import in front of opening a file.
    """
    monkeypatch.setattr(propainter_engine, 'availability',
                        lambda *a: pytest.fail('the GPU was probed to open a file'))
    assert main.resolve_temporal_engine(job(mode='preview_frame')) == 'flow'


def test_the_deep_engine_is_used_where_it_is_available(monkeypatch):
    monkeypatch.setattr(propainter_engine, 'availability',
                        lambda *a: propainter_engine.AVAILABLE)
    assert main.resolve_temporal_engine(job()) == 'deep'


def test_an_unavailable_deep_engine_falls_back_before_any_work(monkeypatch, capsys):
    monkeypatch.setattr(
        propainter_engine, 'availability',
        lambda *a: propainter_engine.Availability(False, 'deep.needsGpu', 'no CUDA device'))

    assert main.resolve_temporal_engine(job()) == 'flow'
    assert 'STATE:deep_fallback:no CUDA device' in capsys.readouterr().out


def test_a_notice_is_one_line_whatever_the_detail_says(capsys):
    """The stdout protocol is line-based; a second line reaches nobody."""
    main.report_deep_notice('deep_fallback', 'first line\nsecond line')
    out = capsys.readouterr().out.strip()
    assert out.count('\n') == 0
    assert 'second line' in out


def test_a_deep_preview_runs_the_quick_preset_whatever_the_dial_says():
    assert main.temporal_quality_for(job(mode='preview', temporalQuality='high'), 'deep') \
        == main.DEEP_PREVIEW_QUALITY


def test_a_deep_export_runs_the_preset_that_was_chosen():
    assert main.temporal_quality_for(job(temporalQuality='high'), 'deep') == 'high'


def test_the_flow_engine_keeps_its_own_preview_behaviour():
    """The renderer already caps this one; the backend must not double-guess it."""
    assert main.temporal_quality_for(job(mode='preview', temporalQuality='high'), 'flow') \
        == 'high'


def test_the_cpu_bar_does_not_refuse_a_gpu_job(monkeypatch):
    """
    A two-core machine with a big graphics card runs the deep engine faster
    than an eight-core one runs the flow engine. Refusing it for want of cores
    would refuse the fastest job the app can do.
    """
    monkeypatch.setattr(main.os, 'cpu_count', lambda: 2)
    with pytest.raises(ValueError):
        main.check_temporal_supported()

    monkeypatch.setattr(propainter_engine, 'availability',
                        lambda *a: propainter_engine.AVAILABLE)
    assert main.resolve_temporal_engine(job()) == 'deep'


def test_the_job_field_defaults_to_off():
    """An older renderer that never heard of the switch keeps its behaviour."""
    assert main.JobConfig(inputPath=os.path.abspath(__file__), outputPath='/dev/null',
                          roi=ROI, method='temporal').useDeepLearning is False


def test_the_gpu_probe_is_never_the_reason_a_job_fails(monkeypatch):
    """A machine that cannot be probed is a machine that runs the flow engine."""
    monkeypatch.setattr(gpu, '_cached', None, raising=False)
    monkeypatch.setattr(gpu, '_probe_torch', lambda: None)
    monkeypatch.setattr(gpu.shutil, 'which', lambda _: None)
    assert main.resolve_temporal_engine(job()) == 'flow'
