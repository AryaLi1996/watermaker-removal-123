/**
 * The confirmation step: what the survey found, and which of it gets removed.
 *
 * The backend's side of this — finding the regions and deciding what each one
 * is — is covered in tests/unit/backend/test_survey.py. What is left, and what
 * these cover, is the promise the classification is only worth anything for:
 * that nothing the user made is removed without them saying so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import FindingsPanel from './FindingsPanel';
import type { Finding } from '../types';
import { setLocale, t } from '../i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    x: 10, y: 10, w: 100, h: 40, start: 0, end: 6,
    kind: 'watermark', proposed: true, coverage: 0.3, ...over,
  };
}

const MARK = finding();
const SUBTITLE = finding({ kind: 'subtitle', proposed: false, y: 400, start: 2, end: 9 });
const OTHER = finding({ kind: 'other', proposed: false, y: 200, start: 4, end: 8 });

function panel(props: Partial<Parameters<typeof FindingsPanel>[0]> = {}) {
  const onToggle = vi.fn();
  const onRescan = vi.fn();
  render(
    <FindingsPanel
      findings={[MARK, SUBTITLE]}
      scanning={false}
      failed={false}
      selected={new Set([0])}
      disabled={false}
      onToggle={onToggle}
      onRescan={onRescan}
      {...props}
    />,
  );
  return { onToggle, onRescan };
}

describe('FindingsPanel', () => {
  it('shows the marks and keeps everything else behind a disclosure', () => {
    panel();
    expect(screen.getByTestId('finding-0')).toBeTruthy();
    // The subtitle is index 1 and is not a mark, so it is not on screen yet.
    expect(screen.queryByTestId('finding-1')).toBeNull();
    expect(screen.getByTestId('findings-toggle-rest')).toBeTruthy();
  });

  it('shows the rest when asked', () => {
    panel();
    fireEvent.click(screen.getByTestId('findings-toggle-rest'));
    expect(screen.getByTestId('finding-1')).toBeTruthy();
  });

  it('ticks what the backend proposed and nothing else', () => {
    panel({ findings: [MARK, SUBTITLE, OTHER], selected: new Set([0]) });
    fireEvent.click(screen.getByTestId('findings-toggle-rest'));
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
  });

  it('reports a tick to the caller rather than deciding for itself', () => {
    const { onToggle } = panel();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onToggle).toHaveBeenCalledWith(0);
  });

  it('says it is working rather than showing an empty list', () => {
    panel({ scanning: true, findings: [] });
    expect(screen.getByTestId('findings-scanning')).toBeTruthy();
  });

  it('tells the user what to do when it found nothing', () => {
    panel({ findings: [] });
    expect(screen.getByTestId('findings-empty').textContent).toBe(t('findings.none'));
  });

  it('says a failed check failed, rather than that there was nothing there', () => {
    panel({ findings: [], failed: true });
    expect(screen.getByTestId('findings-empty').textContent).toBe(t('findings.failed'));
  });

  it('offers to look again when it found nothing', () => {
    const { onRescan } = panel({ findings: [] });
    fireEvent.click(screen.getByTestId('findings-rescan'));
    expect(onRescan).toHaveBeenCalled();
  });

  it('says so when it found things but no watermark among them', () => {
    panel({ findings: [SUBTITLE, OTHER], selected: new Set() });
    expect(screen.getByTestId('findings-no-marks')).toBeTruthy();
  });

  it('reads in the language the user picked', () => {
    setLocale('zh');
    panel();
    expect(screen.getByText(t('findings.watermark'))).toBeTruthy();
  });
});
