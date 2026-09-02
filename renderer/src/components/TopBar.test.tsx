/**
 * The top bar: the one line about the licence that is true on every screen.
 *
 * It replaced a strip along the bottom of the window, so what is worth
 * pinning is that nothing was lost in the move — each state still reads as
 * itself, and the two that need acting on (a trial running down, a grace
 * period) still say so rather than being folded into "subscribed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import TopBar from './TopBar';
import {
  DEMO_PLAN_ID, LOADING_STATE,
  type LicenseState, type LicenseStatus, type TrialState,
} from '../subscription';
import { setLocale } from '../i18n';

const DAY = 24 * 60 * 60 * 1000;

const trial = (over: Partial<TrialState> = {}): TrialState => ({
  used: false, active: false, start: null, end: null, msRemaining: 0, durationDays: 3, source: 'server', ...over,
});

const state = (status: LicenseStatus, over: Partial<LicenseState> = {}): LicenseState => ({
  ...LOADING_STATE, status, trial: trial(), ...over,
});

function bar(s: LicenseState, over: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const onOpenSubscription = vi.fn();
  render(
    <TopBar
      state={s}
      trialMsRemaining={s.trial.msRemaining}
      licenseMsRemaining={0}
      loading={false}
      locale="en"
      onLocaleChange={vi.fn()}
      onOpenSubscription={onOpenSubscription}
      inset={14}
      {...over}
    />,
  );
  return { onOpenSubscription };
}

const label = () => screen.getByTestId('subscription-status-top');

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('what the bar says is in force', () => {
  it('says a device with no licence is not activated', () => {
    bar(state('unlicensed'));
    expect(label()).toHaveTextContent('Not activated');
  });

  it('counts a running trial down', () => {
    bar(state('unlicensed', { trial: trial({ used: true, active: true, msRemaining: 2 * DAY }) }));
    expect(label()).toHaveTextContent(/Trial · 2 days \d{2}:\d{2} left/);
  });

  it('names the plan once one is in force', () => {
    bar(state('active', { payload: { userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: 0, issuedAt: 0 } }));
    expect(label()).toHaveTextContent('Subscribed · Yearly');
  });

  it('calls a demo licence a demo, and counts it down instead', () => {
    // Naming it as a plan would tell someone they had bought something they
    // had not, on every screen in the app.
    bar(
      state('active', { payload: { userId: 'u', planId: DEMO_PLAN_ID, licenseKey: 'DEMO', expiresAt: 0, issuedAt: 0 } }),
      { licenseMsRemaining: 6 * DAY + 3 * 60 * 60 * 1000 },
    );
    expect(label()).toHaveTextContent('Demo · 6 days 03:00 left');
  });

  it('says the grace period is running rather than only "subscribed"', () => {
    // The grace period unlocks everything, which is exactly why it has to be
    // visible: it is the last chance to notice before the features go.
    bar(state('grace_period', { graceDaysLeft: 2 }));
    expect(label()).toHaveTextContent('Grace period · 2 days left');
  });

  it('says expired once a trial or a licence has run out', () => {
    bar(state('expired', { trial: trial({ used: true }) }));
    expect(label()).toHaveTextContent('Expired');
  });

  it('claims nothing before the main process has answered', () => {
    bar(LOADING_STATE, { loading: true });
    expect(label()).toHaveTextContent('Checking…');
    expect(label()).not.toHaveTextContent('Not activated');
  });

  it('follows the language', () => {
    setLocale('zh');
    bar(state('unlicensed'));
    expect(label()).toHaveTextContent('未授权');
  });
});

describe('the account panel', () => {
  it('stays shut until the avatar is clicked', () => {
    bar(state('unlicensed'));
    expect(screen.queryByTestId('account-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('user-avatar'));
    expect(screen.getByTestId('account-panel')).toHaveTextContent('Not subscribed');
  });

  it('closes again on a second click, and on Escape', () => {
    bar(state('unlicensed'));
    const avatar = screen.getByTestId('user-avatar');

    fireEvent.click(avatar);
    fireEvent.click(avatar);
    expect(screen.queryByTestId('account-panel')).toBeNull();

    fireEvent.click(avatar);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('account-panel')).toBeNull();
  });

  it('closes when the click lands anywhere else', () => {
    // A panel that survives the next click sits over whatever the user meant
    // to look at.
    bar(state('unlicensed'));
    fireEvent.click(screen.getByTestId('user-avatar'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('account-panel')).toBeNull();
  });

  it('is the way to the subscription screen, and shuts behind itself', () => {
    const { onOpenSubscription } = bar(state('unlicensed'));

    fireEvent.click(screen.getByTestId('user-avatar'));
    fireEvent.click(screen.getByTestId('account-subscribe'));

    expect(onOpenSubscription).toHaveBeenCalled();
    expect(screen.queryByTestId('account-panel')).toBeNull();
  });
});

describe('the language picker', () => {
  it('reports the choice rather than changing it itself', () => {
    const onLocaleChange = vi.fn();
    bar(state('unlicensed'), { onLocaleChange });

    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'zh' } });
    expect(onLocaleChange).toHaveBeenCalledWith('zh');
  });
});
