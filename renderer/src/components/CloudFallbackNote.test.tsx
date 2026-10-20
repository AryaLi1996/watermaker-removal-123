/**
 * The note that tells a user the filler they paid for did not run.
 *
 * This was silent. `processor.py` emitted `cloud_fallback`, `main.py` left it
 * out of `UI_NOTICE_KEYS`, so it went to the debug channel — while the app
 * already carried a translated sentence for it that nothing rendered. These
 * pin the behaviour that replaces that silence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import CloudFallbackNote from './CloudFallbackNote';
import DonePanel from './DonePanel';
import { setLocale } from '../i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.useRealTimers();
  vi.resetModules();
});

describe('the cloud fallback note', () => {
  it('says how many frames the other filler finished', () => {
    render(<CloudFallbackNote report={{ count: 12, detail: '' }} />);
    expect(screen.getByTestId('cloud-fallback-note').textContent).toMatch(/12/);
  });

  it('says it in Chinese too, with nothing left unsubstituted', () => {
    setLocale('zh');
    render(<CloudFallbackNote report={{ count: 12, detail: '' }} />);
    const text = screen.getByTestId('cloud-fallback-note').textContent ?? '';
    expect(text).toMatch(/12/);
    expect(text).toMatch(/本机/);
    expect(text).not.toMatch(/[{}]/);
  });

  it('carries the reason, which is what tells "try again" from "stop paying"', () => {
    render(<CloudFallbackNote report={{ count: 4, detail: 'HTTP 503 from the service' }} />);
    expect(screen.getByTestId('cloud-fallback-detail').textContent)
      .toBe('HTTP 503 from the service');
  });

  it('shows no reason where the backend gave none', () => {
    render(<CloudFallbackNote report={{ count: 4, detail: '' }} />);
    expect(screen.queryByTestId('cloud-fallback-detail')).toBeNull();
  });

  it('stays out of the way when nothing fell back', () => {
    // Both cases: no notice at all, and a notice whose count is zero. The
    // second is the one a careless backend sends.
    render(<CloudFallbackNote report={null} />);
    expect(screen.queryByTestId('cloud-fallback-note')).toBeNull();
    cleanup();
    render(<CloudFallbackNote report={{ count: 0, detail: '' }} />);
    expect(screen.queryByTestId('cloud-fallback-note')).toBeNull();
  });
});

describe('the done panel, when the cloud filler fell back', () => {
  it('shows the note', () => {
    render(<DonePanel outputPath="/tmp/out.mp4" cloudFallback={{ count: 7, detail: '' }}
                      onReveal={() => {}} onReset={() => {}} />);
    expect(screen.getByTestId('cloud-fallback-note')).toBeTruthy();
  });

  it('stops dismissing itself, so the news does not vanish in five seconds', () => {
    // There is nowhere else the user could go to find this out again.
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(<DonePanel outputPath="/tmp/out.mp4" cloudFallback={{ count: 7, detail: '' }}
                      onReveal={() => {}} onReset={onReset} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onReset).not.toHaveBeenCalled();
  });

  it('still dismisses itself on an export with nothing to report', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(<DonePanel outputPath="/tmp/out.mp4" onReveal={() => {}} onReset={onReset} />);
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(onReset).toHaveBeenCalled();
  });
});
