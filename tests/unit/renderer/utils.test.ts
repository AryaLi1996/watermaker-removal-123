import { describe, it, expect } from 'vitest';
import {
  normalizeCoordinates,
  calcScaleFactor,
  formatDuration,
  defaultOutputName,
} from '../../../renderer/src/utils';

// ─── normalizeCoordinates ─────────────────────────────────────────────────────

describe('normalizeCoordinates', () => {
  it('scales up coordinates from a 0.5x UI scale', () => {
    const result = normalizeCoordinates(100, 100, 50, 50, 0.5);
    expect(result).toEqual({ x: 200, y: 200, w: 100, h: 100 });
  });

  it('handles 1:1 scale (no change)', () => {
    const result = normalizeCoordinates(10, 20, 30, 40, 1);
    expect(result).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('rounds fractional pixels', () => {
    // scale=0.333333 → 33 / 0.333333 ≈ 99.0001 → rounds to 99
    const result = normalizeCoordinates(33, 33, 10, 10, 0.333333);
    expect(result.x).toBe(99);
    expect(result.w).toBe(30);
  });

  it('scales down coordinates from a 2x UI scale', () => {
    const result = normalizeCoordinates(200, 400, 100, 200, 2);
    expect(result).toEqual({ x: 100, y: 200, w: 50, h: 100 });
  });
});

// ─── calcScaleFactor ──────────────────────────────────────────────────────────

describe('calcScaleFactor', () => {
  it('is constrained by the narrower dimension', () => {
    // 1920×1080 video into an 800×600 container →
    // scaleX = 800/1920 ≈ 0.4167, scaleY = 600/1080 ≈ 0.5556 → min = 0.4167
    const scale = calcScaleFactor(1920, 1080, 800, 600);
    expect(scale).toBeCloseTo(800 / 1920, 4);
  });

  it('returns 1 when video fits exactly', () => {
    expect(calcScaleFactor(640, 480, 640, 480)).toBe(1);
  });

  it('returns <1 when video is larger than container', () => {
    expect(calcScaleFactor(1000, 500, 400, 400)).toBeLessThan(1);
  });
});

// ─── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats 0 seconds as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats 65 seconds as 1:05', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  it('pads single-digit seconds', () => {
    expect(formatDuration(61)).toBe('1:01');
  });

  it('handles exactly 1 hour', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });
});

// ─── defaultOutputName ────────────────────────────────────────────────────────

describe('defaultOutputName', () => {
  it('appends _processed.mp4 to the base name', () => {
    expect(defaultOutputName('/home/user/video.mp4')).toBe('video_processed.mp4');
  });

  it('replaces extension correctly', () => {
    expect(defaultOutputName('/path/to/clip.mov')).toBe('clip_processed.mp4');
  });

  it('works with Windows-style paths', () => {
    expect(defaultOutputName('C:\\Videos\\myvid.avi')).toBe('myvid_processed.mp4');
  });

  it('handles file with no extension', () => {
    expect(defaultOutputName('/path/noext')).toBe('noext_processed.mp4');
  });
});
