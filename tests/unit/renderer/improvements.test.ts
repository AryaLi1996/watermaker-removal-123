/**
 * Unit tests for the logic behind the UI improvements: error translation,
 * time-remaining estimates, and preset storage.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { classifyError, hasTechnicalDetail } from '../../../renderer/src/errors';
import { setLocale, t } from '../../../renderer/src/i18n';
import {
  estimateSecondsRemaining,
  formatRemaining,
  recordSample,
  type ProgressSample,
} from '../../../renderer/src/eta';
import {
  BUILT_IN_PRESETS,
  DEFAULT_PARAMS,
  loadCustomPresets,
  presetFromCurrent,
  presetLabel,
  saveCustomPresets,
  type Preset,
} from '../../../renderer/src/presets';

// ─── friendlyError ───────────────────────────────────────────────────────────

describe('classifyError', () => {
  beforeEach(() => setLocale('en'));

  /** What the user would actually see for a raw failure. */
  const shown = (raw: unknown) => {
    const error = classifyError(raw);
    return error.key ? t(error.key) : error.raw;
  };

  it('turns an ffmpeg failure into something actionable', () => {
    const message = shown('ERROR:FFmpeg failed. The video file may be corrupted or unsupported.');
    expect(message).toContain('Could not read or write the video');
    expect(message).not.toContain('FFmpeg failed.');
  });

  it.each([
    ['Permission denied: /root/out.mp4', 'No permission to write there'],
    ['OSError: [Errno 28] No space left on device', 'The disk is full'],
    ['Input file not found: /tmp/gone.mp4', 'no longer where it was'],
    ['Selection (700,100,50x50) lies outside the 640x480 frame.', 'outside the video frame'],
    ['No video stream found in file.', 'no video track'],
    ['numpy.core._exceptions.MemoryError: Unable to allocate', 'Ran out of memory'],
  ])('maps %s', (raw, expected) => {
    expect(shown(raw)).toContain(expected);
  });

  // ffmpeg reports its failures with the command line attached, so the word
  // "ffmpeg" appears in the text of a disk-full or permission error too. The
  // specific cause has to win, or every such failure reads as a corrupt file.
  it.each([
    [
      "Command '['ffmpeg', '-i', 'in.mp4', 'out.mp4']' returned non-zero exit status 1. av_interleaved_write_frame(): No space left on device",
      'The disk is full',
    ],
    [
      "Command '['ffmpeg', '-y', 'out.mp4']' returned non-zero exit status 1. out.mp4: Permission denied",
      'No permission to write there',
    ],
    [
      "Command '['ffprobe', 'gone.mp4']' returned non-zero exit status 1. gone.mp4: No such file or directory",
      'no longer where it was',
    ],
  ])('reads the real cause out of an ffmpeg failure: %#', (raw, expected) => {
    expect(shown(raw)).toContain(expected);
  });

  it('still falls back to the ffmpeg message when there is no specific cause', () => {
    const raw = "Command '['ffmpeg', '-i', 'in.mkv']' returned non-zero exit status 1. Invalid data found when processing input";
    expect(shown(raw)).toContain('Could not read or write the video');
  });

  it('explains a decode that produced no frames at all', () => {
    expect(shown('No frames could be extracted from the video. The file may be corrupted or use an unsupported codec.'))
      .toContain('Could not read or write the video');
  });

  it('passes an unrecognised message through rather than inventing one', () => {
    expect(shown('Some brand new failure')).toBe('Some brand new failure');
  });

  it('says something useful when the backend gave no reason at all', () => {
    expect(shown('')).toContain('no reason');
    expect(shown(null)).toContain('no reason');
  });

  it('accepts an Error as well as a string', () => {
    expect(shown(new Error('Permission denied'))).toContain('No permission');
  });

  it('offers the raw detail only when the friendly text replaced it', () => {
    expect(hasTechnicalDetail(classifyError('Permission denied: /root/out.mp4'))).toBe(true);
    expect(hasTechnicalDetail(classifyError('Some brand new failure'))).toBe(false);
    expect(hasTechnicalDetail(classifyError(''))).toBe(false);
  });
});

// ─── estimateSecondsRemaining ────────────────────────────────────────────────

describe('progress estimates', () => {
  const at = (percent: number, seconds: number): ProgressSample => ({ percent, at: seconds * 1000 });

  it('has nothing to say from a single sample', () => {
    expect(estimateSecondsRemaining([at(10, 1)])).toBeNull();
  });

  it('estimates from the rate of recent samples', () => {
    // 10% per second → 50% left → ~5s
    const samples = [at(20, 1), at(30, 2), at(40, 3), at(50, 4)];
    expect(estimateSecondsRemaining(samples)).toBeCloseTo(5, 1);
  });

  it('stays quiet until progress is meaningful', () => {
    expect(estimateSecondsRemaining([at(0, 1), at(1, 2)])).toBeNull();
  });

  it('stops estimating at completion', () => {
    expect(estimateSecondsRemaining([at(90, 1), at(100, 2)])).toBeNull();
  });

  it('tracks a slowdown instead of averaging it away', () => {
    // Fast early, slow now: the estimate must reflect the slow phase.
    const fast = [at(10, 1), at(50, 2)];
    const slow = [at(50, 2), at(52, 12)];
    const fastEstimate = estimateSecondsRemaining(fast)!;
    const slowEstimate = estimateSecondsRemaining(slow)!;
    expect(slowEstimate).toBeGreaterThan(fastEstimate * 10);
  });
});

describe('recordSample', () => {
  it('keeps samples ordered and bounded', () => {
    let samples: ProgressSample[] = [];
    for (let i = 1; i <= 20; i += 1) samples = recordSample(samples, i * 5, i * 1000);
    expect(samples.length).toBeLessThanOrEqual(8);
    expect(samples[samples.length - 1].percent).toBe(100);
  });

  it('ignores a repeated percentage', () => {
    const first = recordSample([], 40, 1000);
    expect(recordSample(first, 40, 2000)).toBe(first);
  });

  it('restarts when progress goes backwards, as a new job does', () => {
    const running = recordSample(recordSample([], 40, 1000), 80, 2000);
    const restarted = recordSample(running, 5, 3000);
    expect(restarted).toEqual([{ percent: 5, at: 3000 }]);
  });
});

describe('formatRemaining', () => {
  beforeEach(() => setLocale('en'));

  it.each([
    [null, 'estimating…'],
    [4, 'almost done'],
    [45, '45s left'],
    [300, 'about 5 min left'],
  ])('formats %s', (seconds, expected) => {
    expect(formatRemaining(seconds as number | null, t)).toBe(expected);
  });
});

// ─── presets ─────────────────────────────────────────────────────────────────

describe('presets', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('ships built-ins that name real backend methods', () => {
    const methods = new Set(['inpaint', 'blur', 'solidFill', 'cloneStamp']);
    expect(BUILT_IN_PRESETS.length).toBeGreaterThan(0);
    setLocale('en');
    for (const preset of BUILT_IN_PRESETS) {
      expect(methods).toContain(preset.method);
      expect(presetLabel(preset, t).description).not.toHaveLength(0);
    }
  });

  it('round-trips custom presets through storage', () => {
    const mine = presetFromCurrent('My blur', 'blur', { ...DEFAULT_PARAMS, kernelSize: 31 });
    saveCustomPresets([...BUILT_IN_PRESETS, mine]);

    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1); // built-ins are not persisted
    expect(loaded[0].name).toBe('My blur');
    expect(loaded[0].params.kernelSize).toBe(31);
    expect(loaded[0].custom).toBe(true);
  });

  it('survives a corrupt storage entry instead of throwing', () => {
    window.localStorage.setItem('watermark-remover:custom-presets', '{not json');
    expect(loadCustomPresets()).toEqual([]);
  });

  it('drops entries that are not presets', () => {
    window.localStorage.setItem(
      'watermark-remover:custom-presets',
      JSON.stringify([{ nonsense: true }, { id: 'x', name: 'ok', method: 'blur', params: DEFAULT_PARAMS }]),
    );
    const loaded = loadCustomPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('x');
  });

  it('does not let a full disk break saving', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const mine: Preset = presetFromCurrent('Doomed', 'inpaint', DEFAULT_PARAMS);
    expect(() => saveCustomPresets([mine])).not.toThrow();
    setItem.mockRestore();
  });

  it('trims the name it is given', () => {
    expect(presetFromCurrent('  Spaced  ', 'blur', DEFAULT_PARAMS).name).toBe('Spaced');
  });
});
