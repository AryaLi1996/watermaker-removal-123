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
  const onToggleDrawnBox = vi.fn();
  render(
    <FindingsPanel
      findings={[MARK, SUBTITLE]}
      scanning={false}
      failed={false}
      selected={new Set([0])}
      drawnBoxChosen={false}
      crowded={null}
      disabled={false}
      onToggle={onToggle}
      onToggleDrawnBox={onToggleDrawnBox}
      onRescan={onRescan}
      {...props}
    />,
  );
  return { onToggle, onRescan, onToggleDrawnBox };
}

function checkbox(testId: string): HTMLInputElement {
  return screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
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
    // By row rather than by every checkbox on screen: the box the user drew is
    // one too, and it is not one of the survey's answers.
    expect([0, 1, 2].map((i) => checkbox(`finding-${i}`).checked))
      .toEqual([true, false, false]);
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

describe('the box the user drew', () => {
  it('is offered alongside the survey, not instead of it', () => {
    // The gap this closes: a clip with two watermarks and one thing the survey
    // missed. Before, a drawn box replaced the findings, so there was no way
    // to ask for all three.
    panel({ selected: new Set([0]), drawnBoxChosen: true });
    expect(checkbox('finding-0').checked).toBe(true);
    expect(checkbox('finding-drawn-box').checked).toBe(true);
  });

  it('arrives unticked', () => {
    // There is always a box on the canvas, including one nobody has moved. A
    // row that arrived ticked would quietly take a corner out of every video.
    panel();
    expect(checkbox('finding-drawn-box').checked).toBe(false);
  });

  it('is offered even when the survey found nothing', () => {
    // Unticked the backend takes the box as a hint; ticked it solves the box
    // as drawn. The second is what the user wants once the scan has disagreed
    // with them.
    panel({ findings: [] });
    expect(screen.getByTestId('findings-empty')).toBeTruthy();
    expect(screen.getByTestId('finding-drawn-box')).toBeTruthy();
  });

  it('is not offered while the scan is still running', () => {
    panel({ scanning: true });
    expect(screen.queryByTestId('finding-drawn-box')).toBeNull();
  });

  it('reports a tick without touching the findings', () => {
    const { onToggleDrawnBox, onToggle } = panel();
    fireEvent.click(checkbox('finding-drawn-box'));
    expect(onToggleDrawnBox).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('cannot be ticked while a job holds the app', () => {
    // The attribute, not a click that does nothing: `fireEvent` dispatches on a
    // disabled input regardless, so asserting the handler was not called would
    // be a test of jsdom rather than of this component.
    panel({ disabled: true });
    expect(checkbox('finding-drawn-box').disabled).toBe(true);
  });
});

describe('when the check could not tell watermarks from scenery', () => {
  it('says so rather than letting an empty list speak for it', () => {
    // A list with nothing ticked otherwise reads as "these were all judged not
    // to be marks", which is the opposite of what happened.
    panel({ crowded: 21 });
    const said = screen.getByTestId('findings-crowded').textContent ?? '';
    expect(said).toContain('21');
  });

  it('says nothing in the ordinary case', () => {
    panel();
    expect(screen.queryByTestId('findings-crowded')).toBeNull();
  });

  it('still lists everything it found', () => {
    // The findings are the useful part even when the app will not tick them:
    // the user can recognise their own platform's mark in the list.
    panel({ crowded: 21, selected: new Set() });
    expect(screen.getByTestId('finding-0')).toBeTruthy();
    expect(checkbox('finding-0').checked).toBe(false);
  });
});
