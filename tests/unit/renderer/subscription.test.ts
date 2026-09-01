/**
 * The renderer's side of the subscription: what a license state unlocks, what
 * it is called, and how it is formatted.
 *
 * Deliberately thin. The dates, the prices and the token all belong to the
 * main process and the license service — anything this file could assert
 * about them would be a second opinion, which is how two answers start to
 * disagree.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  entitlementsFor,
  formatPrice,
  formatRemaining,
  isLicensed,
  LOADING_STATE,
  PLAN_ORDER,
  planBadgeKey,
  planNameKey,
  planTaglineKey,
  remainingParts,
  serviceLang,
  statusNameKey,
  type LicenseState,
  type LicenseStatus,
  type Plan,
  type TrialState,
} from '../../../renderer/src/subscription';
import { collectKeys, setLocale, t } from '../../../renderer/src/i18n';
import en from '../../../renderer/src/i18n/en.json';

const DAY = 24 * 60 * 60 * 1000;

const trial = (over: Partial<TrialState> = {}): TrialState => ({
  used: false, active: false, start: null, end: null, msRemaining: 0, durationDays: 3, source: 'none', ...over,
});

const state = (status: LicenseStatus, over: Partial<LicenseState> = {}): LicenseState => ({
  ...LOADING_STATE, status, trial: trial(), ...over,
});

describe('what a state unlocks', () => {
  it('counts the grace period as licensed, so an outage does not lock anyone out', () => {
    expect(isLicensed('active')).toBe(true);
    expect(isLicensed('grace_period')).toBe(true);
    expect(isLicensed('expired')).toBe(false);
    expect(isLicensed('unlicensed')).toBe(false);
    expect(isLicensed('loading')).toBe(false);
  });

  it('unlocks the paid features for a license', () => {
    const limits = entitlementsFor(state('active'));
    expect(limits.temporalFill).toBe(true);
    expect(limits.deepLearning).toBe(true);
    expect(limits.maxPreviewSeconds).toBe(Infinity);
    expect(limits.batchLimit).toBe(Infinity);
  });

  it('keeps them through the grace period', () => {
    expect(entitlementsFor(state('grace_period')).temporalFill).toBe(true);
  });

  it('withholds them from a trial with no allowance to spend', () => {
    // The trial buys time to evaluate the basics. It now also gets a metered
    // run or two of temporal fill, but only when the main process hands one
    // over: with no allowance in sight this is the free tier, as it always
    // was — which is also what an older main process gets.
    for (const s of [state('unlicensed', { trial: trial({ used: true, active: true }) }), state('unlicensed'), state('expired')]) {
      const limits = entitlementsFor(s);
      expect(limits.temporalFill).toBe(false);
      expect(limits.deepLearning).toBe(false);
      expect(limits.maxPreviewSeconds).toBe(1);
      expect(limits.batchLimit).toBe(5);
    }
  });

  it('withholds them while the state is still being read', () => {
    expect(entitlementsFor(LOADING_STATE).temporalFill).toBe(false);
  });

  describe('the trial\'s metered temporal fill', () => {
    const trialing = state('unlicensed', { trial: trial({ used: true, active: true }) });
    const allowance = (over = {}) => ({ allowed: true, remaining: 3, limit: 3, limited: true, ...over });

    it('lends temporal fill to a trial that still has runs left', () => {
      const limits = entitlementsFor(trialing, allowance());
      expect(limits.temporalFill).toBe(true);
      // The learned engine is temporal fill's other implementation, not a
      // feature of its own: metering one and withholding the other would
      // offer a method that cannot run its faster path for no visible reason.
      expect(limits.deepLearning).toBe(true);
    });

    it('lends nothing else with it', () => {
      // An allowance of exports is not a subscription: the preview cap and
      // the batch limit stay where the free tier put them.
      const limits = entitlementsFor(trialing, allowance());
      expect(limits.maxPreviewSeconds).toBe(1);
      expect(limits.batchLimit).toBe(5);
    });

    it('takes it back once the runs are spent', () => {
      const limits = entitlementsFor(trialing, allowance({ allowed: false, remaining: 0 }));
      expect(limits.temporalFill).toBe(false);
      expect(limits.deepLearning).toBe(false);
    });

    it('leaves a subscriber on the paid tier regardless of the count', () => {
      // A subscriber is not "0 of 3 used"; the allowance does not apply.
      const limits = entitlementsFor(state('active'), allowance({ allowed: false, remaining: 0 }));
      expect(limits.temporalFill).toBe(true);
      expect(limits.maxPreviewSeconds).toBe(Infinity);
    });
  });
});

describe('naming the state', () => {
  beforeEach(() => setLocale('en'));

  it('names the plan while it is running', () => {
    const licensed = state('active', {
      payload: { userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: 0, issuedAt: 0 },
    });
    expect(statusNameKey(licensed)).toBe('subscription.planYearly');
    expect(t(statusNameKey(licensed))).toBe('Yearly');
  });

  it('distinguishes the grace period from an expiry', () => {
    expect(statusNameKey(state('grace_period'))).toBe('subscription.statusGrace');
    expect(statusNameKey(state('expired'))).toBe('subscription.statusExpired');
  });

  it('names the trial while it runs, and after it has been used', () => {
    expect(statusNameKey(state('unlicensed', { trial: trial({ used: true, active: true }) })))
      .toBe('subscription.statusTrial');
    expect(statusNameKey(state('unlicensed', { trial: trial({ used: true, active: false }) })))
      .toBe('subscription.statusTrialEnded');
  });

  it('says nothing definite before the first answer arrives', () => {
    expect(statusNameKey(LOADING_STATE)).toBe('subscription.statusLoading');
  });

  it('falls back to "not subscribed" for a device with no trial record', () => {
    expect(statusNameKey(state('unlicensed'))).toBe('subscription.statusNone');
  });
});

describe('plan labels', () => {
  it('name and describe every plan the service offers, in both languages', () => {
    for (const id of PLAN_ORDER) {
      for (const locale of ['en', 'zh'] as const) {
        setLocale(locale);
        expect(t(planNameKey(id)), `${id} in ${locale}`).not.toContain('subscription.');
        expect(t(planTaglineKey(id)), `${id} tagline in ${locale}`).not.toContain('subscription.');
      }
    }
  });

  it('badges the recommended plans and leaves the entry one plain', () => {
    expect(planBadgeKey('monthly')).toBeNull();
    expect(planBadgeKey('quarterly')).toBe('subscription.badgePopular');
    expect(planBadgeKey('annual')).toBe('subscription.badgeBest');
  });

  it('defines every key the page builds from a plan id', () => {
    const keys = collectKeys(en);
    for (const id of PLAN_ORDER) {
      expect(keys, planNameKey(id)).toContain(planNameKey(id));
      expect(keys, planTaglineKey(id)).toContain(planTaglineKey(id));
    }
  });
});

describe('prices', () => {
  const plan = (over: Partial<Plan>): Pick<Plan, 'price' | 'currency'> =>
    ({ price: 99, currency: 'cny', ...over }) as Plan;

  it('render yuan with the symbol people expect', () => {
    expect(formatPrice(plan({}), 'zh')).toBe('¥99');
    expect(formatPrice(plan({}), 'en')).toBe('¥99');
  });

  it('render another currency the service might be configured with', () => {
    // The client hardcodes no amount, so it must not hardcode one currency
    // either: a re-configured service should not need a client release.
    expect(formatPrice(plan({ price: 14, currency: 'usd' }), 'en')).toContain('14');
  });

  it('survive a currency code that means nothing', () => {
    expect(formatPrice(plan({ price: 5, currency: 'zzz' }), 'en')).toContain('5');
  });
});

describe('the countdown', () => {
  beforeEach(() => setLocale('en'));

  it('breaks the time left into days, hours and minutes', () => {
    expect(remainingParts(2 * DAY + 14 * 3600_000 + 23 * 60_000)).toEqual({ days: 2, hours: 14, minutes: 23 });
    expect(remainingParts(-1)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  it('reads as days and a clock while there are days left', () => {
    expect(formatRemaining(2 * DAY + 14 * 3600_000 + 23 * 60_000, t)).toBe('2 days 14:23 left');
    setLocale('zh');
    expect(formatRemaining(2 * DAY + 14 * 3600_000 + 23 * 60_000, t)).toContain('2 天');
  });

  it('drops to the clock alone on the last day', () => {
    expect(formatRemaining(3 * 3600_000 + 5 * 60_000, t)).toBe('03:05 left');
  });
});

describe('talking to the service', () => {
  it('sends the language tag it localises payment methods by', () => {
    expect(serviceLang('zh')).toBe('zh-CN');
    expect(serviceLang('en')).toBe('en-US');
  });
});
