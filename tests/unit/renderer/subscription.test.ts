/**
 * Unit tests for the subscription domain: what each plan costs, what state a
 * stored record is in at a given moment, and what that state unlocks.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyPurchase,
  entitlementsFor,
  formatRemaining,
  isPaidPlan,
  MONTHLY_PRICE,
  planById,
  planDiscountKey,
  planNameKey,
  planPriceKey,
  PLANS,
  priceFor,
  remainingParts,
  startTrial,
  statusNameKey,
  statusOf,
  TRIAL_DAYS,
  type Subscription,
} from '../../../renderer/src/subscription';
import { collectKeys, setLocale, t } from '../../../renderer/src/i18n';
import en from '../../../renderer/src/i18n/en.json';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

describe('plans', () => {
  it('prices every plan off the monthly rate at its discount', () => {
    expect(MONTHLY_PRICE).toBe(99);
    expect(planById('monthly').price).toBe(99);
    expect(planById('quarterly').price).toBe(282);
    expect(planById('halfyear').price).toBe(534);
    expect(planById('yearly').price).toBe(1009);
  });

  it('rounds a price down to the yuan', () => {
    // 99 × 12 × 0.85 is 1009.80: charging 1010 would be more than the
    // advertised 15% off, and the card is specified to read 1009.
    expect(priceFor(12, 0.85)).toBe(1009);
    expect(priceFor(1, 1)).toBe(99);
  });

  it('offers four plans, cheapest commitment first', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['monthly', 'quarterly', 'halfyear', 'yearly']);
    expect(PLANS.map((p) => p.months)).toEqual([1, 3, 6, 12]);
  });

  it('badges the quarterly plan as the recommended one', () => {
    expect(planById('quarterly').badgeKey).toBe('subscription.badgePopular');
    expect(planById('monthly').badgeKey).toBeNull();
  });

  it('works out what a discounted plan costs per month', () => {
    expect(planById('yearly').monthlyEquivalent).toBeCloseTo(84.1, 1);
    expect(planById('yearly').monthlyEquivalent).toBeLessThan(MONTHLY_PRICE);
  });

  it('names every plan in both languages', () => {
    for (const plan of PLANS) {
      for (const locale of ['en', 'zh'] as const) {
        setLocale(locale);
        for (const key of [planNameKey(plan.id), planDiscountKey(plan.id), planPriceKey(plan.id)]) {
          expect(t(key, { price: plan.price }), `${key} in ${locale}`).not.toContain('subscription.');
        }
      }
    }
  });

  it('defines every subscription string it renders', () => {
    // The page reads keys built from a plan id; a missing one would surface
    // to the user as the key itself.
    const keys = collectKeys(en);
    for (const plan of PLANS) {
      for (const key of [planNameKey(plan.id), planDiscountKey(plan.id), planPriceKey(plan.id)]) {
        expect(keys, key).toContain(key);
      }
    }
    expect(keys).toContain('subscription.barTrial');
    expect(keys).toContain('subscription.paySuccess');
  });
});

describe('the trial', () => {
  it('runs for three days from the first launch', () => {
    const trial = startTrial(NOW);
    expect(trial.plan).toBe('trial');
    expect(Date.parse(trial.endDate) - Date.parse(trial.startDate)).toBe(TRIAL_DAYS * DAY);
    expect(trial.autoRenew).toBe(false);
  });

  it('reports as running, with time left, while it lasts', () => {
    const status = statusOf(startTrial(NOW), NOW + DAY);
    expect(status.trialing).toBe(true);
    expect(status.subscribed).toBe(false);
    expect(status.expired).toBe(false);
    expect(status.msRemaining).toBe(2 * DAY);
  });

  it('reports as run out once the end date passes, with nothing to write back', () => {
    const trial = startTrial(NOW);
    const status = statusOf(trial, NOW + 4 * DAY);
    expect(status.plan).toBe('none');
    expect(status.trialing).toBe(false);
    expect(status.expired).toBe(true);
    expect(status.msRemaining).toBe(0);
    // The record itself is untouched: expiry is a fact about the date.
    expect(trial.plan).toBe('trial');
  });
});

describe('buying a plan', () => {
  it('runs from now for as many months as the plan covers', () => {
    const bought = applyPurchase(null, 'quarterly', NOW);
    expect(bought.plan).toBe('quarterly');
    expect(bought.autoRenew).toBe(true);
    expect(bought.endDate).toBe(new Date('2026-06-01T12:00:00.000Z').toISOString());
  });

  it('replaces a trial rather than adding to it', () => {
    const bought = applyPurchase(startTrial(NOW), 'monthly', NOW);
    expect(bought.endDate).toBe(new Date('2026-04-01T12:00:00.000Z').toISOString());
  });

  it('carries over the days left on a paid plan when renewing early', () => {
    const monthly = applyPurchase(null, 'monthly', NOW);
    // Renew a fortnight in: the remaining two weeks must not be lost.
    const renewed = applyPurchase(monthly, 'monthly', NOW + 14 * DAY);
    expect(Date.parse(renewed.endDate)).toBeGreaterThan(Date.parse(monthly.endDate));
    expect(renewed.endDate).toBe(new Date('2026-05-01T12:00:00.000Z').toISOString());
  });

  it('starts from today when the previous plan has already run out', () => {
    const expired: Subscription = applyPurchase(null, 'monthly', NOW - 90 * DAY);
    const renewed = applyPurchase(expired, 'monthly', NOW);
    expect(renewed.endDate).toBe(new Date('2026-04-01T12:00:00.000Z').toISOString());
  });

  it('reports as subscribed for the plan that was bought', () => {
    const status = statusOf(applyPurchase(null, 'yearly', NOW), NOW + 30 * DAY);
    expect(status.plan).toBe('yearly');
    expect(status.subscribed).toBe(true);
    expect(status.autoRenew).toBe(true);
    expect(isPaidPlan(status.plan)).toBe(true);
  });
});

describe('reading a record', () => {
  it('treats no record at all as nothing running', () => {
    const status = statusOf(null, NOW);
    expect(status.plan).toBe('none');
    expect(status.expired).toBe(false);
    expect(status.subscribed).toBe(false);
  });

  it('treats an unreadable end date as run out rather than as forever', () => {
    const broken: Subscription = { plan: 'yearly', startDate: 'x', endDate: 'not a date', autoRenew: true };
    expect(statusOf(broken, NOW).subscribed).toBe(false);
    expect(statusOf(broken, NOW).expired).toBe(true);
  });

  it('keeps the plan running after auto-renewal is cancelled', () => {
    const bought = applyPurchase(null, 'halfyear', NOW);
    const status = statusOf({ ...bought, autoRenew: false }, NOW + DAY);
    expect(status.subscribed).toBe(true);
    expect(status.autoRenew).toBe(false);
  });
});

describe('entitlements', () => {
  it('withholds the paid features from a trial and from nobody at all', () => {
    for (const record of [startTrial(NOW), null]) {
      const limits = entitlementsFor(statusOf(record, NOW));
      expect(limits.temporalFill).toBe(false);
      expect(limits.deepLearning).toBe(false);
      expect(limits.maxPreviewSeconds).toBe(1);
      expect(limits.batchLimit).toBe(5);
    }
  });

  it('unlocks them for a paid plan', () => {
    const limits = entitlementsFor(statusOf(applyPurchase(null, 'monthly', NOW), NOW));
    expect(limits.temporalFill).toBe(true);
    expect(limits.deepLearning).toBe(true);
    expect(limits.maxPreviewSeconds).toBe(Infinity);
    expect(limits.batchLimit).toBe(Infinity);
  });

  it('takes them away again the moment a plan runs out', () => {
    const bought = applyPurchase(null, 'monthly', NOW);
    expect(entitlementsFor(statusOf(bought, NOW + 60 * DAY)).temporalFill).toBe(false);
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

describe('naming the state', () => {
  beforeEach(() => setLocale('en'));

  it('names a paid plan, a trial and an ended one', () => {
    expect(statusNameKey(statusOf(applyPurchase(null, 'yearly', NOW), NOW))).toBe('subscription.planYearly');
    expect(statusNameKey(statusOf(startTrial(NOW), NOW))).toBe('subscription.statusTrial');
    expect(statusNameKey(statusOf(startTrial(NOW), NOW + 5 * DAY))).toBe('subscription.statusExpired');
    expect(statusNameKey(statusOf(null, NOW))).toBe('subscription.statusNone');
  });
});
