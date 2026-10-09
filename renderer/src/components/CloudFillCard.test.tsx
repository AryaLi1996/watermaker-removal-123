/**
 * The switch for the paid filler, and the one case where it is not taken.
 *
 * The measurement behind these tests is in `backend/cloud_fill.py`: on 抖音
 * reposts the free local filler came out more accurate than the service in
 * every configuration, on 115 of 122 frames. So "the switch is on" stopped
 * being sufficient reason to upload, and these pin the consequences — no
 * endpoint, no charge, and a line that says why rather than a silent
 * downgrade.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import CloudFillCard from './CloudFillCard';
import {
  cloudEndpointFor, grantConsent, localFillerWinsOn, LOCAL_FILLER_WINS, NO_CONSENT,
} from '../cloud';
import { setLocale } from '../i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.resetModules();
});

const quota = {
  allowed: true, limit: 20, remaining: 7, used: 13,
  overagePrice: null, reason: null,
  endpoint: { url: 'https://example.invalid/fill', token: 't' },
};

describe('which platforms the local filler wins on', () => {
  it('names the one that was measured, and claims no others', () => {
    expect(LOCAL_FILLER_WINS.has('douyin')).toBe(true);
    // Absent because untested, not because the service is known to win.
    expect(LOCAL_FILLER_WINS.has('kuaishou')).toBe(false);
    expect(LOCAL_FILLER_WINS.has('xiaohongshu')).toBe(false);
  });

  it('finds the platform among the marks being removed', () => {
    expect(localFillerWinsOn([{ platform: 'douyin' }])).toBe('douyin');
    expect(localFillerWinsOn([{ platform: 'kuaishou' }])).toBeUndefined();
    expect(localFillerWinsOn([{}, { platform: undefined }])).toBeUndefined();
    expect(localFillerWinsOn([])).toBeUndefined();
  });

  it('is decided by any one listed mark, not by all of them', () => {
    // The filler is chosen once for the whole export, so a video carrying
    // both would otherwise pay the service and still get the worse result
    // exactly where the measurement says it is worse.
    expect(localFillerWinsOn([{ platform: 'kuaishou' }, { platform: 'douyin' }]))
      .toBe('douyin');
  });
});

describe('the card, on footage the local filler wins', () => {
  it('says this export stays on the machine, and why', () => {
    render(<CloudFillCard enabled consent={grantConsent()} quota={quota}
                          disabled={false} localWinsOn="douyin"
                          onToggle={() => {}} />);
    const line = screen.getByTestId('cloud-fill-local-wins');
    expect(line.textContent).toMatch(/Douyin/);
    expect(line.textContent).toMatch(/nothing is uploaded/i);
  });

  it('leaves the switch as the user set it', () => {
    // Nothing here is for the user to fix by toggling: the switch is a
    // standing preference, and this is one export.
    render(<CloudFillCard enabled consent={grantConsent()} quota={quota}
                          disabled={false} localWinsOn="douyin"
                          onToggle={() => {}} />);
    expect(screen.getByTestId<HTMLInputElement>('cloud-fill-toggle').checked).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>('cloud-fill-toggle').disabled).toBe(false);
  });

  it('does not go on to show an allowance that will not be spent', () => {
    render(<CloudFillCard enabled consent={grantConsent()} quota={quota}
                          disabled={false} localWinsOn="douyin"
                          onToggle={() => {}} />);
    expect(screen.queryByTestId('cloud-fill-quota')).toBeNull();
  });

  it('says it in Chinese too', () => {
    setLocale('zh');
    render(<CloudFillCard enabled consent={grantConsent()} quota={quota}
                          disabled={false} localWinsOn="douyin"
                          onToggle={() => {}} />);
    const line = screen.getByTestId('cloud-fill-local-wins');
    expect(line.textContent).toMatch(/抖音/);
    expect(line.textContent).not.toMatch(/\{platform\}/);
  });
});

describe('the card, otherwise', () => {
  it('shows the allowance when the service will be used', () => {
    render(<CloudFillCard enabled consent={grantConsent()} quota={quota}
                          disabled={false} onToggle={() => {}} />);
    expect(screen.queryByTestId('cloud-fill-local-wins')).toBeNull();
    expect(screen.getByTestId('cloud-fill-quota')).toBeTruthy();
  });
});

describe('whether an export uploads anything', () => {
  const agreed = grantConsent();

  it('does not, on footage the local filler wins — switch and allowance notwithstanding', () => {
    expect(cloudEndpointFor(true, agreed, quota, 'douyin')).toBeUndefined();
  });

  it('does, on footage nothing was measured against', () => {
    expect(cloudEndpointFor(true, agreed, quota)?.url)
      .toBe('https://example.invalid/fill');
  });

  it('still wants the switch, the agreement and the allowance', () => {
    expect(cloudEndpointFor(false, agreed, quota)).toBeUndefined();
    expect(cloudEndpointFor(true, NO_CONSENT, quota)).toBeUndefined();
    expect(cloudEndpointFor(true, agreed, { ...quota, allowed: false })).toBeUndefined();
    expect(cloudEndpointFor(true, agreed, null)).toBeUndefined();
  });

  it('sends nowhere when the service named no url', () => {
    expect(cloudEndpointFor(true, agreed, { ...quota, endpoint: undefined }))
      .toBeUndefined();
  });
});
