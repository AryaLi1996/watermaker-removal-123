/**
 * The notice shown when the temporal engine could not rebuild every frame,
 * and what it does to the panel that carries it.
 *
 * Beside the component rather than under tests/unit/renderer: rendering one
 * needs @testing-library/react, and only files inside the renderer root can
 * resolve the renderer's own packages (see useVideoLoader.test.ts, which sits
 * beside its hook for the same reason).
 *
 * The count reaches the renderer over its own IPC channel (covered in
 * tests/e2e/job-protocol.spec.ts) and is produced by the backend (covered in
 * tests/unit/backend). What is left, and what these cover, is whether the
 * user is actually told — and whether the telling survives long enough to
 * read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import TemporalFallbackNote from './TemporalFallbackNote';
import DonePanel from './DonePanel';
import { setLocale, t } from '../i18n';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale('en');
});

describe('TemporalFallbackNote', () => {
  it('says how many frames fell back, and out of how many', () => {
    render(<TemporalFallbackNote report={{ degraded: 7, total: 90 }} />);
    const note = screen.getByTestId('temporal-fallback-note');
    expect(note.textContent).toContain('7');
    expect(note.textContent).toContain('90');
  });

  it('is absent when there is nothing to report', () => {
    render(<TemporalFallbackNote report={null} />);
    expect(screen.queryByTestId('temporal-fallback-note')).toBeNull();
  });

  it('is absent rather than saying "0 frames", which would alarm for nothing', () => {
    render(<TemporalFallbackNote report={{ degraded: 0, total: 90 }} />);
    expect(screen.queryByTestId('temporal-fallback-note')).toBeNull();
  });

  it('follows the chosen language', () => {
    setLocale('zh');
    render(<TemporalFallbackNote report={{ degraded: 2, total: 30 }} />);
    expect(screen.getByTestId('temporal-fallback-note').textContent)
      .toBe(t('status.temporalFallback', { degraded: 2, total: 30 }));
  });
});

describe('DonePanel with a caveat', () => {
  const noop = () => {};

  it('shows the notice beside the finished file', () => {
    render(
      <DonePanel
        outputPath="/tmp/clip_processed.mp4"
        temporalFallback={{ degraded: 7, total: 90 }}
        onReveal={noop}
        onReset={noop}
      />,
    );
    expect(screen.getByTestId('temporal-fallback-note')).toBeTruthy();
  });

  it('stops dismissing itself, so the notice can be read', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(
      <DonePanel
        outputPath="/tmp/clip_processed.mp4"
        temporalFallback={{ degraded: 7, total: 90 }}
        onReveal={noop}
        onReset={onReset}
      />,
    );

    // Well past the five seconds an ordinary export gets.
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(onReset).not.toHaveBeenCalled();
    // …and there is a way out that does not involve waiting.
    expect(screen.getByTestId('btn-done-dismiss')).toBeTruthy();
  });

  it('still dismisses itself when the export was clean', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(
      <DonePanel outputPath="/tmp/clip_processed.mp4" onReveal={noop} onReset={onReset} />,
    );

    expect(screen.queryByTestId('temporal-fallback-note')).toBeNull();
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(onReset).toHaveBeenCalled();
  });

  it('treats a report of zero as no report at all', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(
      <DonePanel
        outputPath="/tmp/clip_processed.mp4"
        temporalFallback={{ degraded: 0, total: 90 }}
        onReveal={noop}
        onReset={onReset}
      />,
    );

    act(() => { vi.advanceTimersByTime(6_000); });
    expect(onReset).toHaveBeenCalled();
  });
});
