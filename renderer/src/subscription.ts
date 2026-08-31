/**
 * Subscription plans, trial state, and what each of them unlocks.
 *
 * Everything here is pure: it takes a stored record and a clock and answers
 * questions about them. Where the record is kept — a JSON file the main
 * process owns, or localStorage when the app runs without one — is
 * `useSubscription`'s problem, not this file's.
 */

/** What the user is paying for, or `none` once nothing is paying. */
export type PlanId = 'trial' | 'monthly' | 'quarterly' | 'halfyear' | 'yearly' | 'none';

/** The plans that can be bought. `trial` and `none` are states, not products. */
export type PaidPlanId = 'monthly' | 'quarterly' | 'halfyear' | 'yearly';

export type PaymentMethod = 'wechat' | 'alipay';

/** The record that is persisted, and the only thing that survives a restart. */
export interface Subscription {
  plan: PlanId;
  /** ISO date the plan (or trial) began. */
  startDate: string;
  /** ISO date it runs out. */
  endDate: string;
  autoRenew: boolean;
}

export interface Plan {
  id: PaidPlanId;
  /** How long a purchase covers. */
  months: number;
  /** Multiplier off the monthly rate: 1 is full price, 0.85 is 15% off. */
  multiplier: number;
  /** Total price in yuan, discount already applied. */
  price: number;
  /** Price per month at this plan's rate, for the comparison line. */
  monthlyEquivalent: number;
  /** A badge over the card, where the plan has one. Translation key. */
  badgeKey: string | null;
}

/** The list price everything else is derived from. */
export const MONTHLY_PRICE = 99;

/** How long a new install gets before it has to pay. */
export const TRIAL_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The price of `months` at `multiplier`, in whole yuan.
 *
 * Rounded down, not to nearest: the ticket's own figures are the floor of the
 * exact price (¥534.60 → ¥534, ¥1009.80 → ¥1009), and those are the numbers
 * the cards are specified to show. Rounding up by four jiao would also be
 * charging more than the advertised discount.
 */
export function priceFor(months: number, multiplier: number): number {
  return Math.floor(MONTHLY_PRICE * months * multiplier);
}

function plan(id: PaidPlanId, months: number, multiplier: number, badgeKey: string | null): Plan {
  const price = priceFor(months, multiplier);
  return {
    id,
    months,
    multiplier,
    price,
    monthlyEquivalent: Math.round((price / months) * 10) / 10,
    badgeKey,
  };
}

/** The four cards, cheapest commitment first. */
export const PLANS: Plan[] = [
  plan('monthly', 1, 1, null),
  plan('quarterly', 3, 0.95, 'subscription.badgePopular'),
  plan('halfyear', 6, 0.9, 'subscription.badgeValue'),
  plan('yearly', 12, 0.85, 'subscription.badgeBest'),
];

export function planById(id: PaidPlanId): Plan {
  const found = PLANS.find((p) => p.id === id);
  // Every PaidPlanId has a card; the throw is for a plan id read back from
  // storage that the type system never saw.
  if (!found) throw new Error(`Unknown plan: ${id}`);
  return found;
}

/** Whether a stored plan id is one someone paid for. */
export function isPaidPlan(id: PlanId): id is PaidPlanId {
  return id !== 'trial' && id !== 'none';
}

/** The record a first run starts from: a trial, beginning now. */
export function startTrial(now: number = Date.now()): Subscription {
  return {
    plan: 'trial',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
    autoRenew: false,
  };
}

/**
 * The record after a successful payment.
 *
 * Time left on an active plan is carried over rather than thrown away —
 * renewing early should never cost the user days. A trial has no money in it,
 * so it is simply replaced.
 */
export function applyPurchase(
  current: Subscription | null,
  planId: PaidPlanId,
  now: number = Date.now(),
): Subscription {
  const { months } = planById(planId);
  const carriedEnd = current && isPaidPlan(current.plan) ? Date.parse(current.endDate) : NaN;
  const from = Number.isFinite(carriedEnd) && carriedEnd > now ? carriedEnd : now;
  const end = new Date(from);
  end.setMonth(end.getMonth() + months);
  return {
    plan: planId,
    startDate: new Date(now).toISOString(),
    endDate: end.toISOString(),
    autoRenew: true,
  };
}

/** What the app actually acts on: the stored record read against the clock. */
export interface SubscriptionStatus {
  /** The plan in force now — `none` once a trial or a paid plan has run out. */
  plan: PlanId;
  /** True while a paid plan is running. */
  subscribed: boolean;
  /** True while the free trial is running. */
  trialing: boolean;
  /** True when a trial or plan has run out and nothing replaced it. */
  expired: boolean;
  /** Milliseconds until the current plan or trial ends; 0 when nothing is running. */
  msRemaining: number;
  autoRenew: boolean;
  /** The stored end date, for the "expires on" line. Null when nothing is running. */
  endDate: string | null;
}

const NOTHING: SubscriptionStatus = {
  plan: 'none',
  subscribed: false,
  trialing: false,
  expired: false,
  msRemaining: 0,
  autoRenew: false,
  endDate: null,
};

/**
 * Read a stored record against the clock.
 *
 * A record whose end date has passed reports as `none`: expiry is a fact
 * about the date, not a state anything has to write back, so a clock that
 * crosses midnight while the app is open takes effect on the next tick with
 * nothing to save.
 */
export function statusOf(
  record: Subscription | null,
  now: number = Date.now(),
): SubscriptionStatus {
  if (!record || record.plan === 'none') return { ...NOTHING, expired: !!record };

  const end = Date.parse(record.endDate);
  // An unparseable date is treated as run out rather than as forever.
  const msRemaining = Number.isFinite(end) ? end - now : 0;
  if (msRemaining <= 0) {
    return { ...NOTHING, expired: true, autoRenew: record.autoRenew, endDate: record.endDate };
  }

  return {
    plan: record.plan,
    subscribed: isPaidPlan(record.plan),
    trialing: record.plan === 'trial',
    expired: false,
    msRemaining,
    autoRenew: record.autoRenew,
    endDate: record.endDate,
  };
}

/** Days, hours and minutes left, for the countdown. */
export interface Remaining {
  days: number;
  hours: number;
  minutes: number;
}

export function remainingParts(ms: number): Remaining {
  const clamped = Math.max(0, ms);
  return {
    days: Math.floor(clamped / DAY_MS),
    hours: Math.floor((clamped % DAY_MS) / (60 * 60 * 1000)),
    minutes: Math.floor((clamped % (60 * 60 * 1000)) / (60 * 1000)),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2 days 14:23" in whichever language, via the caller's `t`. */
export function formatRemaining(
  ms: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const { days, hours, minutes } = remainingParts(ms);
  const clock = `${pad(hours)}:${pad(minutes)}`;
  return days > 0
    ? t('subscription.remainingDays', { days, clock })
    : t('subscription.remainingClock', { clock });
}

// ─── What a status unlocks ────────────────────────────────────────────
/**
 * The limits in force.
 *
 * The trial sits on the free tier deliberately: the ticket's limits section
 * groups "free trial / not subscribed" together, so the trial buys time to
 * evaluate the basics rather than a preview of the paid features. One
 * constant changes that if the product decides otherwise.
 */
export interface Entitlements {
  /** Temporal fill — the multi-frame reconstruction. */
  temporalFill: boolean;
  /** The learned (GPU) engine behind temporal fill. */
  deepLearning: boolean;
  /** The longest preview clip that may be requested. */
  maxPreviewSeconds: number;
  /** How many files a batch may hold. No batch UI exists yet; the cap is here
   *  so it comes from one place when one does. */
  batchLimit: number;
}

export const FREE_TIER: Entitlements = {
  temporalFill: false,
  deepLearning: false,
  maxPreviewSeconds: 1,
  batchLimit: 5,
};

export const PAID_TIER: Entitlements = {
  temporalFill: true,
  deepLearning: true,
  maxPreviewSeconds: Infinity,
  batchLimit: Infinity,
};

export function entitlementsFor(status: SubscriptionStatus): Entitlements {
  return status.subscribed ? PAID_TIER : FREE_TIER;
}

// ─── Naming ───────────────────────────────────────────────────────────
const PLAN_KEY: Record<PaidPlanId, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  halfyear: 'Halfyear',
  yearly: 'Yearly',
};

/** Translation key for a plan's name. */
export function planNameKey(id: PaidPlanId): string {
  return `subscription.plan${PLAN_KEY[id]}`;
}

/** Translation key for its tagline — the line under the price. */
export function planTaglineKey(id: PaidPlanId): string {
  return `${planNameKey(id)}Tagline`;
}

/** Translation key for what it saves, worded per plan so each locale can
 *  use its own convention (`15% off` against `85折`). */
export function planDiscountKey(id: PaidPlanId): string {
  return `subscription.discount${PLAN_KEY[id]}`;
}

/** Translation key for the price, which carries the plan's own unit. */
export function planPriceKey(id: PaidPlanId): string {
  return `subscription.price${PLAN_KEY[id]}`;
}

/**
 * What to call the plan in force — a paid plan by name, otherwise the state.
 */
export function statusNameKey(status: SubscriptionStatus): string {
  if (isPaidPlan(status.plan)) return planNameKey(status.plan);
  if (status.trialing) return 'subscription.statusTrial';
  return status.expired ? 'subscription.statusExpired' : 'subscription.statusNone';
}
