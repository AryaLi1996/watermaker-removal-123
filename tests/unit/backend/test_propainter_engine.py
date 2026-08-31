"""
Unit tests for backend/propainter_engine.py.

None of these need a GPU or a ProPainter checkout, and that is the point: the
parts of this engine that decide *whether and how* to run — the preset the
card can carry, the flags a preset becomes, the meaning of the child's
output, what happens when it fails — are exactly the parts a machine with a
GPU would never exercise the interesting branches of.

The one place a real subprocess is used is `run`, where the whole contract is
"drive another program and survive what it does". A stub Python script stands
in for ProPainter there: it is the same pipe, the same exit codes and the same
kill, and it runs on every platform in milliseconds.
"""
import os
import subprocess
import sys
import textwrap
import time

import cv2
import numpy as np
import pytest

import gpu
import propainter_engine as engine

ROI = {'x': 40, 'y': 30, 'w': 60, 'h': 20}


def card(memory_mb: int) -> gpu.GpuInfo:
    return gpu.GpuInfo(True, 'Test card', memory_mb, '12.4', 'torch')


NO_CARD = gpu.GpuInfo(False, reason='no CUDA device found')


# ─── Presets and the downgrade ──────────────────────────────────────────────

def test_every_preset_is_named_after_its_key():
    for name, settings in engine.PRESETS.items():
        assert settings.name == name


def test_presets_get_more_expensive_in_order():
    """The dial has to mean something, in both directions."""
    memory = [engine.PRESETS[name].min_vram_mb for name in engine.QUALITY_ORDER]
    pixels = [engine.PRESETS[name].width * engine.PRESETS[name].height
              for name in engine.QUALITY_ORDER]
    assert memory == sorted(memory)
    assert pixels == sorted(pixels)


def test_unknown_quality_names_the_ones_that_exist():
    with pytest.raises(ValueError) as exc:
        engine.settings_for('ultra')
    assert 'balanced' in str(exc.value)


def test_a_big_card_gets_what_was_asked_for():
    assert engine.select_settings('high', card(24000)).name == 'high'
    assert engine.select_settings('fast', card(24000)).name == 'fast', \
        'a card with room to spare must not silently upgrade the dial'


def test_a_small_card_steps_down_rather_than_refusing():
    assert engine.select_settings('high', card(12000)).name == 'balanced'
    assert engine.select_settings('high', card(6000)).name == 'fast'
    assert engine.select_settings('balanced', card(6000)).name == 'fast'


def test_a_card_below_the_smallest_preset_gets_nothing():
    """The caller's cue to fall back to the optical-flow engine."""
    assert engine.select_settings('fast', card(2048)) is None
    assert engine.select_settings('high', card(2048)) is None


def test_no_card_gets_nothing():
    assert engine.select_settings('balanced', NO_CARD) is None


# ─── Availability ───────────────────────────────────────────────────────────

@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """A directory that looks enough like a ProPainter checkout to be found."""
    root = tmp_path / 'ProPainter'
    root.mkdir()
    (root / 'inference_propainter.py').write_text('')
    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(root))
    return str(root)


def test_a_missing_checkout_is_reported_as_not_installed(tmp_path, monkeypatch):
    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(tmp_path / 'nowhere'))
    result = engine.availability(card(24000))
    assert result.available is False
    assert result.reason_key == 'deep.notInstalled'
    assert result.detail


def test_no_gpu_is_reported_separately_from_a_missing_checkout(checkout):
    result = engine.availability(NO_CARD)
    assert result.available is False
    assert result.reason_key == 'deep.needsGpu'


def test_a_card_too_small_says_so_and_names_the_numbers(checkout):
    result = engine.availability(card(2048))
    assert result.available is False
    assert result.reason_key == 'deep.needsVram'
    assert '2048' in result.detail


def test_a_complete_install_is_available(checkout):
    assert engine.availability(card(24000)).available is True


def test_missing_weights_do_not_make_it_unavailable(checkout):
    """They are downloaded on first use; refusing until then is circular."""
    assert not os.path.isdir(os.path.join(checkout, 'weights'))
    assert engine.availability(card(24000)).available is True


def test_home_follows_the_override(tmp_path, monkeypatch):
    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(tmp_path / 'elsewhere'))
    assert engine.home() == str(tmp_path / 'elsewhere')


def test_home_defaults_beside_the_backend(monkeypatch):
    monkeypatch.delenv('WATERMARK_PROPAINTER_HOME', raising=False)
    assert os.path.basename(engine.home()) == 'ProPainter'


def test_the_interpreter_follows_the_override(monkeypatch):
    monkeypatch.setenv('WATERMARK_PROPAINTER_PYTHON', '/opt/torch/bin/python')
    assert engine.interpreter() == '/opt/torch/bin/python'


# ─── The command ────────────────────────────────────────────────────────────

def command_for(quality: str, frame_count: int = 300) -> list[str]:
    return engine.build_command('/frames', '/mask.png', '/out',
                                engine.PRESETS[quality], frame_count, '/pp')


def flag(command: list[str], name: str) -> str:
    return command[command.index(name) + 1]


def test_the_command_names_the_inputs_and_the_output():
    command = command_for('balanced')
    assert flag(command, '--video') == '/frames'
    assert flag(command, '--mask') == '/mask.png'
    assert flag(command, '--output') == '/out'
    assert command[1] == os.path.join('/pp', 'inference_propainter.py')


def test_frames_are_asked_for_because_the_encode_happens_here():
    assert '--save_frames' in command_for('fast')


def test_a_preset_becomes_its_flags():
    settings = engine.PRESETS['high']
    command = command_for('high')
    assert flag(command, '--width') == str(settings.width)
    assert flag(command, '--height') == str(settings.height)
    assert flag(command, '--neighbor_length') == str(settings.neighbor_length)
    assert flag(command, '--ref_stride') == str(settings.ref_stride)
    assert flag(command, '--raft_iter') == str(settings.raft_iter)


def test_half_precision_follows_the_preset():
    assert ('--fp16' in command_for('fast')) is engine.PRESETS['fast'].fp16
    assert ('--fp16' in command_for('high')) is engine.PRESETS['high'].fp16


def test_the_chunk_is_never_longer_than_the_video():
    """The model allocates for the chunk it is told about, used or not."""
    assert flag(command_for('balanced', frame_count=12), '--subvideo_length') == '12'


def test_a_long_video_keeps_the_presets_chunk():
    settings = engine.PRESETS['balanced']
    assert flag(command_for('balanced', frame_count=9000), '--subvideo_length') \
        == str(settings.subvideo_length)


def test_an_unknown_frame_count_falls_back_to_the_preset():
    assert flag(command_for('fast', frame_count=0), '--subvideo_length') \
        == str(engine.PRESETS['fast'].subvideo_length)


# ─── Progress ───────────────────────────────────────────────────────────────

def test_progress_starts_at_nothing_and_ends_at_everything():
    mapper = engine.ProgressMapper()
    assert mapper.value == 0.0
    mapper.feed('Saving frames 100%|##| 10/10 [00:01]')
    assert mapper.value == 100.0


def test_progress_follows_the_phases_in_order():
    mapper = engine.ProgressMapper()
    seen = []
    for line in ('Loading model from: weights/ProPainter.pth',
                 'Computing flow  10/10 [00:02]',
                 'Flow completion 4/4 [00:01]',
                 'Feature propagation 3/3 [00:01]',
                 'Inpainting 20/20 [00:30]'):
        seen.append(mapper.feed(line))
    reported = [v for v in seen if v is not None]
    assert reported == sorted(reported)
    assert reported[-1] > 90


def test_progress_within_a_phase_tracks_the_count():
    mapper = engine.ProgressMapper()
    mapper.feed('Computing flow 0/10 [')
    start = mapper.value
    mapper.feed('Computing flow 5/10 [')
    half = mapper.value
    mapper.feed('Computing flow 10/10 [')
    assert start < half < mapper.value


def test_a_tqdm_percentage_is_read_where_there_is_no_count():
    mapper = engine.ProgressMapper()
    mapper.feed('Computing flow')
    before = mapper.value
    mapper.feed('  50%|#####     | ')
    assert mapper.value > before


def test_progress_never_goes_backwards():
    mapper = engine.ProgressMapper()
    mapper.feed('Inpainting 10/10 [')
    high = mapper.value
    assert mapper.feed('Computing flow 1/10 [') is None
    assert mapper.value == high


def test_unrecognised_output_moves_nothing():
    mapper = engine.ProgressMapper()
    mapper.feed('Inpainting 5/10 [')
    before = mapper.value
    assert mapper.feed('Setting up PyTorch plugin "upfirdn2d"...') is None
    assert mapper.value == before


# ─── Running a child ────────────────────────────────────────────────────────

def stub_script(tmp_path, body: str) -> str:
    path = tmp_path / 'stub.py'
    path.write_text(textwrap.dedent(body))
    return str(path)


def test_run_reports_the_progress_the_child_prints(tmp_path):
    script = stub_script(tmp_path, '''
        print('Computing flow 1/2 [')
        print('Inpainting 2/2 [')
    ''')
    seen = []
    engine.run([sys.executable, script], cwd=str(tmp_path), on_progress=seen.append)
    assert seen == sorted(seen) and seen[-1] > 50


def test_run_raises_with_the_childs_own_last_words(tmp_path):
    script = stub_script(tmp_path, '''
        import sys
        print('RuntimeError: something specific went wrong')
        sys.exit(1)
    ''')
    with pytest.raises(engine.ProPainterError) as exc:
        engine.run([sys.executable, script], cwd=str(tmp_path))
    assert 'something specific went wrong' in str(exc.value)


def test_an_out_of_memory_failure_says_what_to_change(tmp_path):
    script = stub_script(tmp_path, '''
        import sys
        print('torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB')
        sys.exit(1)
    ''')
    with pytest.raises(engine.ProPainterError) as exc:
        engine.run([sys.executable, script], cwd=str(tmp_path))
    message = str(exc.value)
    assert 'out of GPU memory' in message
    assert 'quality' in message, 'the message has to name the fix'


def test_a_silent_failure_still_names_the_status(tmp_path):
    script = stub_script(tmp_path, 'import sys; sys.exit(3)')
    with pytest.raises(engine.ProPainterError) as exc:
        engine.run([sys.executable, script], cwd=str(tmp_path))
    assert '3' in str(exc.value)


def test_a_command_that_cannot_start_is_an_engine_error(tmp_path):
    with pytest.raises(engine.ProPainterError):
        engine.run([str(tmp_path / 'no-such-binary')], cwd=str(tmp_path))


def test_terminate_stops_a_run_in_flight(tmp_path):
    """A cancelled export must not leave a process holding the GPU."""
    script = stub_script(tmp_path, '''
        import time
        print('Inpainting 1/1000 [', flush=True)
        time.sleep(60)
    ''')

    import threading
    error: list[BaseException] = []

    def go():
        try:
            engine.run([sys.executable, script], cwd=str(tmp_path))
        except BaseException as exc:  # the kill surfaces as a non-zero exit
            error.append(exc)

    worker = threading.Thread(target=go)
    worker.start()
    # Wait for the child to actually exist before killing it.
    deadline = time.monotonic() + 10
    while engine._current is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert engine._current is not None, 'the child was never registered'

    engine.terminate()
    worker.join(timeout=15)
    assert not worker.is_alive(), 'terminate did not stop the run'
    assert engine._current is None


def test_terminate_is_safe_when_nothing_is_running():
    engine.terminate()
    engine.terminate()


# ─── Reading the result back ────────────────────────────────────────────────

def write_frames(directory, count, colour=90):
    os.makedirs(directory, exist_ok=True)
    paths = []
    for index in range(count):
        frame = np.full((240, 320, 3), colour, dtype=np.uint8)
        # A striped "watermark" over the selection, so a paste is visible.
        frame[30:50, 40:100] = 255
        path = os.path.join(directory, f'frame_{index:06d}.png')
        cv2.imwrite(path, frame)
        paths.append(path)
    return paths


def test_output_frames_are_found_in_propainters_own_layout(tmp_path):
    produced = tmp_path / 'out' / 'frames' / 'frames'
    produced.mkdir(parents=True)
    for index in (2, 0, 1):
        cv2.imwrite(str(produced / f'{index:04d}.png'),
                    np.zeros((4, 4, 3), dtype=np.uint8))

    found = engine.output_frames(str(tmp_path / 'out'))
    assert len(found) == 3
    assert found == sorted(found), 'frames must come back in order'


def test_composite_paints_over_the_selection(tmp_path):
    frames = write_frames(str(tmp_path / 'frames'), 2)
    produced = write_frames(str(tmp_path / 'produced'), 2, colour=90)
    # The "repainted" frames have the mark gone: flat background everywhere.
    for path in produced:
        cv2.imwrite(path, np.full((240, 320, 3), 90, dtype=np.uint8))

    engine.composite(frames, produced, 320, 240, ROI)

    middle = cv2.imread(frames[0])[35:45, 50:90]
    assert np.all(np.abs(middle.astype(int) - 90) <= 2), 'the mark is still there'


def test_composite_leaves_the_rest_of_the_frame_alone(tmp_path):
    """The model ran at its own resolution; only its rectangle may be used."""
    frames = write_frames(str(tmp_path / 'frames'), 1)
    produced = [str(tmp_path / 'repainted.png')]
    cv2.imwrite(produced[0], np.zeros((240, 320, 3), dtype=np.uint8))

    engine.composite(frames, produced, 320, 240, ROI)

    far = cv2.imread(frames[0])[150:230, 150:300]
    assert np.all(far == 90)


def test_composite_scales_a_smaller_result_back_up(tmp_path):
    """The preset resolution is not the video's; the paste has to bridge that."""
    frames = write_frames(str(tmp_path / 'frames'), 1)
    produced = [str(tmp_path / 'small.png')]
    cv2.imwrite(produced[0], np.full((120, 160, 3), 90, dtype=np.uint8))

    engine.composite(frames, produced, 320, 240, ROI)
    middle = cv2.imread(frames[0])[35:45, 50:90]
    assert np.all(np.abs(middle.astype(int) - 90) <= 2)


def test_composite_refuses_a_frame_count_that_does_not_match(tmp_path):
    """A short run would otherwise leave the tail of the video untouched."""
    frames = write_frames(str(tmp_path / 'frames'), 3)
    produced = write_frames(str(tmp_path / 'produced'), 2)
    with pytest.raises(engine.ProPainterError):
        engine.composite(frames, produced, 320, 240, ROI)


def test_composite_blends_rather_than_stamping(tmp_path):
    """A hard seam is more visible than the watermark was."""
    frames = write_frames(str(tmp_path / 'frames'), 1)
    produced = [str(tmp_path / 'white.png')]
    cv2.imwrite(produced[0], np.full((240, 320, 3), 255, dtype=np.uint8))

    engine.composite(frames, produced, 320, 240, ROI)
    frame = cv2.imread(frames[0])
    # Somewhere in the band around the selection there must be a value that is
    # neither the original background nor the incoming patch.
    band = frame[20:65, 30:115].astype(int)
    assert np.any((band > 95) & (band < 250))


# ─── The entry point ────────────────────────────────────────────────────────

def test_inpaint_frames_refuses_where_the_engine_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(tmp_path / 'nowhere'))
    frames = write_frames(str(tmp_path / 'frames'), 2)
    with pytest.raises(engine.ProPainterError):
        engine.inpaint_frames(frames, {'roi': ROI}, 320, 240, str(tmp_path))


def test_inpaint_frames_does_nothing_with_no_frames(tmp_path):
    assert engine.inpaint_frames([], {'roi': ROI}, 320, 240, str(tmp_path))


# ─── End to end, against a stand-in for the model ───────────────────────────

STUB_INFERENCE = '''
    """A stand-in for inference_propainter.py: same argv, same output layout."""
    import argparse
    import os
    import sys

    import cv2
    import numpy as np

    parser = argparse.ArgumentParser()
    parser.add_argument('--video')
    parser.add_argument('--mask')
    parser.add_argument('--output')
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    parser.add_argument('--neighbor_length', type=int)
    parser.add_argument('--ref_stride', type=int)
    parser.add_argument('--subvideo_length', type=int)
    parser.add_argument('--raft_iter', type=int)
    parser.add_argument('--save_frames', action='store_true')
    parser.add_argument('--fp16', action='store_true')
    args = parser.parse_args()

    # The weights have to be on disk by the time the model is asked to load.
    weights = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weights')
    for name in ('ProPainter.pth', 'recurrent_flow_completion.pth', 'raft-things.pth'):
        assert os.path.isfile(os.path.join(weights, name)), name

    frames = sorted(f for f in os.listdir(args.video) if f.endswith('.png'))
    mask = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    assert mask is not None, 'no mask was written'

    out = os.path.join(args.output, os.path.basename(args.video), 'frames')
    os.makedirs(out, exist_ok=True)
    print('Loading model from: weights/ProPainter.pth')
    for index, name in enumerate(frames):
        print(f'Inpainting {index + 1}/{len(frames)} [')
        # "Repainted": the flat background, at the resolution we were told to
        # work at rather than the video's.
        cv2.imwrite(os.path.join(out, f'{index:04d}.png'),
                    np.full((args.height, args.width, 3), 90, dtype=np.uint8))
'''


@pytest.fixture
def installed(tmp_path, monkeypatch):
    """A checkout whose inference script is the stub above, with weights."""
    root = tmp_path / 'ProPainter'
    (root / 'weights').mkdir(parents=True)
    for name in ('ProPainter.pth', 'recurrent_flow_completion.pth', 'raft-things.pth'):
        (root / 'weights' / name).write_bytes(b'fake')
    (root / 'inference_propainter.py').write_text(textwrap.dedent(STUB_INFERENCE))

    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(root))
    monkeypatch.setenv('WATERMARK_PROPAINTER_PYTHON', sys.executable)
    monkeypatch.setattr(engine.gpu_probe, 'detect', lambda *a, **k: card(24000))
    return root


def test_a_whole_run_repaints_the_frames_in_place(installed, tmp_path):
    frames = write_frames(str(tmp_path / 'job' / 'frames'), 3)
    work = tmp_path / 'job' / 'work'
    work.mkdir()
    seen = []

    settings = engine.inpaint_frames(frames, {'roi': ROI, 'temporalQuality': 'fast'},
                                     320, 240, str(work), progress_callback=seen.append)

    assert settings.name == 'fast'
    assert seen == sorted(seen) and seen[-1] > 50, 'the bar has to move'
    for path in frames:
        middle = cv2.imread(path)[35:45, 50:90]
        assert np.all(np.abs(middle.astype(int) - 90) <= 2), f'{path} still has the mark'


def test_a_whole_run_leaves_the_rest_of_the_frame_at_full_resolution(installed, tmp_path):
    """The model worked at 576x320; the video is 320x240 and stays its own."""
    frames = write_frames(str(tmp_path / 'job' / 'frames'), 2)
    work = tmp_path / 'job' / 'work'
    work.mkdir()

    engine.inpaint_frames(frames, {'roi': ROI, 'temporalQuality': 'fast'},
                          320, 240, str(work))

    frame = cv2.imread(frames[0])
    assert frame.shape == (240, 320, 3)
    assert np.all(frame[150:230, 150:300] == 90)


def test_a_run_that_dies_is_an_engine_error_not_a_crash(installed, tmp_path):
    (installed / 'inference_propainter.py').write_text(
        'import sys; print("RuntimeError: CUDA out of memory"); sys.exit(1)')
    frames = write_frames(str(tmp_path / 'job' / 'frames'), 2)
    work = tmp_path / 'job' / 'work'
    work.mkdir()

    with pytest.raises(engine.ProPainterError) as exc:
        engine.inpaint_frames(frames, {'roi': ROI}, 320, 240, str(work))
    assert 'out of GPU memory' in str(exc.value)


def test_the_preset_is_stepped_down_to_the_card_before_the_run(installed, tmp_path, monkeypatch):
    monkeypatch.setattr(engine.gpu_probe, 'detect', lambda *a, **k: card(6000))
    frames = write_frames(str(tmp_path / 'job' / 'frames'), 2)
    work = tmp_path / 'job' / 'work'
    work.mkdir()

    settings = engine.inpaint_frames(frames, {'roi': ROI, 'temporalQuality': 'high'},
                                     320, 240, str(work))
    assert settings.name == 'fast', 'the caller has to be told which preset ran'


def test_prepared_weights_are_used_rather_than_downloaded(tmp_path, monkeypatch):
    """The offline install: the run must not reach for the network."""
    root = tmp_path / 'ProPainter'
    root.mkdir()
    (root / 'inference_propainter.py').write_text(textwrap.dedent(STUB_INFERENCE))
    prepared = tmp_path / 'prepared'
    prepared.mkdir()
    for name in ('ProPainter.pth', 'recurrent_flow_completion.pth', 'raft-things.pth'):
        (prepared / name).write_bytes(b'fake')

    monkeypatch.setenv('WATERMARK_PROPAINTER_HOME', str(root))
    monkeypatch.setenv('WATERMARK_PROPAINTER_PYTHON', sys.executable)
    monkeypatch.setenv('WATERMARK_PROPAINTER_WEIGHTS', str(prepared))
    monkeypatch.setattr(engine.gpu_probe, 'detect', lambda *a, **k: card(24000))
    monkeypatch.setattr(
        engine.propainter_weights, '_download_one',
        lambda *a, **k: pytest.fail('a prepared install must not download'))

    frames = write_frames(str(tmp_path / 'job' / 'frames'), 1)
    work = tmp_path / 'job' / 'work'
    work.mkdir()
    engine.inpaint_frames(frames, {'roi': ROI, 'temporalQuality': 'fast'},
                          320, 240, str(work))
