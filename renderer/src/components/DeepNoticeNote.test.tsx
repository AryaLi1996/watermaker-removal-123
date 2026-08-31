/**
 * The notice shown when the learned engine did something other than what the
 * settings describe, and what it does to the panel that carries it.
 *
 * Beside the component for the same reason as `TemporalFallbackNote.test.tsx`:
 * rendering one needs @testing-library/react, which only files inside the
 * renderer root can resolve.
 *
 * The notice reaches the renderer over its own IPC channel (covered in
 * tests/e2e/job-protocol.spec.ts) and is produced by the backend (covered in
 * tests/unit/backend/test_deep_pipeline.py). What is left, and what these
 * cover, is whether the user is actually told.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import DeepNoticeNote from './DeepNoticeNote';
import DonePanel from './DonePanel';
import { setLocale, t } from '../i18n';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale('en');
});

describe('DeepNoticeNote', () => {
  it('says nothing when the engine did what was asked', () => {
    render(<DeepNoticeNote notice={null} />);
    expect(screen.queryByTestId('deep-notice')).toBeNull();
  });

  it('names the engine that actually ran, and why', () => {
    render(<DeepNoticeNote notice={{ kind: 'fallback', detail: 'no CUDA device found' }} />);
    expect(screen.getByTestId('deep-notice')).toHaveTextContent(t('deep.fallbackTitle'));
    // The backend's own sentence is the difference between "fix it" and
    // "give up", and it is what goes into a bug report.
    expect(screen.getByTestId('deep-notice-detail')).toHaveTextContent('no CUDA device found');
  });

  it('names the preset that ran when the card could not carry the one chosen', () => {
    render(<DeepNoticeNote notice={{ kind: 'quality', detail: 'balanced' }} />);
    const notice = screen.getByTestId('deep-notice');
    expect(notice).toHaveTextContent(t('quality.balanced'));
    // The detail there is just the preset name, already said above.
    expect(screen.queryByTestId('deep-notice-detail')).toBeNull();
  });

  it('translates with the rest of the interface', () => {
    setLocale('zh');
    render(<DeepNoticeNote notice={{ kind: 'fallback', detail: 'no CUDA device' }} />);
    expect(screen.getByTestId('deep-notice')).toHaveTextContent(t('deep.fallbackTitle'));
  });
});

describe('DonePanel with a deep-engine notice', () => {
  it('carries the notice, so it is not only on a screen that has gone', () => {
    render(
      <DonePanel
        outputPath="/tmp/out.mp4"
        deepNotice={{ kind: 'fallback', detail: 'no CUDA device found' }}
        onReveal={() => {}}
        onReset={() => {}}
      />,
    );
    expect(screen.getByTestId('deep-notice')).toBeInTheDocument();
  });

  it('stops the panel dismissing itself before the notice can be read', () => {
    // There is nowhere else to go and find it again.
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(
      <DonePanel
        outputPath="/tmp/out.mp4"
        deepNotice={{ kind: 'fallback', detail: 'no CUDA device found' }}
        onReveal={() => {}}
        onReset={onReset}
      />,
    );

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onReset).not.toHaveBeenCalled();
  });

  it('still dismisses itself on an export with nothing to report', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    render(<DonePanel outputPath="/tmp/out.mp4" onReveal={() => {}} onReset={onReset} />);

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onReset).toHaveBeenCalled();
  });
});
