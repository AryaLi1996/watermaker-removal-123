/**
 * The subscription as the interface sees it.
 *
 * The durable state — the license token, the device trial, the orders — lives
 * with the shared license service (docs/LICENSE_SERVICE.md) and is owned by
 * the main process. This module holds only what the renderer needs to render
 * it: the shapes that cross IPC, what each state unlocks, and how to name and
 * format it.
 *
 * Notably absent: prices. The service computes them and `GET /plans` returns
 * them, because a client that hardcodes an amount is a client that can quote
 * one thing and charge another.
 */

/** Plan ids are the service's, and must match: `/create-order` validates
 *  against them and the licenses table is keyed by what it issued. */
export type PlanId = 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

/**
 * The demo licence's plan id.
 *
 * Deliberately not a `PlanId`: nothing can be bought under it, and typing it
 * as one would let `/create-order` be called with a plan the service has
 * never heard of. It only ever appears on a licence that is already in force,
 * which is why it joins `PlanId` in `LicensePlanId` below and nowhere else.
 */
export const DEMO_PLAN_ID = 'demo';

/** What a licence in force can say it is: a plan that was bought, or the
 *  demo this build issued itself. */
export type LicensePlanId = PlanId | typeof DEMO_PLAN_ID;

export type PlanPeriod = 'month' | 'quarter' | 'half_year' | 'year';

export type PaymentMethodId = 'wechat_pay' | 'alipay' | 'douyin_pay' | 'card';

/** How a payment is presented: in the app, or in the system browser. */
export type PresentAs = 'embedded' | 'external';

export const PLAN_ORDER: PlanId[] = ['monthly', 'quarterly', 'semi_annual', 'annual'];

/** A plan card, exactly as `GET /plans` returns it. */
export interface Plan {
  id: PlanId;
  period: PlanPeriod;
  durationDays: number;
  discountPercent: number;
  /** Major units — yuan, for the default configuration. */
  price: number;
  /** Display only, for the English UI. Never what is charged. */
  priceUSD: number;
  originalPrice: number;
  originalPriceUSD: number;
  currency: string;
}

/** A payment method, as `GET /payment-methods` returns it: only the ones the
 *  service can actually take money with, already localised. */
export interface PaymentMethod {
  id: PaymentMethodId;
  enabled: boolean;
  name: string;
  icon: string;
  /** Absent for the card method, which takes the app's accent instead. */
  color?: string | null;
}

export type LicenseStatus = 'loading' | 'unlicensed' | 'active' | 'grace_period' | 'expired';

/**
 * A licensing failure the interface has to word differently.
 *
 * `app_mismatch` is a license or an order the service scoped to another app on
 * the same account. Everything else — a timeout, a refused key — reads as
 * "try again"; this one never resolves by retrying, so it gets its own
 * message telling the user to activate here instead.
 */
export type LicenseErrorCode = 'app_mismatch' | 'expired';

export const APP_MISMATCH: LicenseErrorCode = 'app_mismatch';

/** A licence that verifies, but whose period is already over. Typing it in
 *  again will not help, so it is worded as its own outcome. */
export const EXPIRED: LicenseErrorCode = 'expired';

/**
 * How taking a demo licence can fail, as the main process codes it.
 *
 * All three are final — a second demo, a code that is not one of this
 * build's, a build that does not offer demos — so each gets its own wording
 * rather than the "try again" every uncoded failure reads as.
 */
export const DEMO_ALREADY_USED = 'demo_already_used';
export const DEMO_CODE_INVALID = 'demo_code_invalid';
export const DEMO_DISABLED = 'demo_disabled';

export type DemoErrorCode =
  | typeof DEMO_ALREADY_USED
  | typeof DEMO_CODE_INVALID
  | typeof DEMO_DISABLED;

/** The message for a demo failure, or null when the raw reason is all there
 *  is to say. */
export function demoErrorKey(code?: string | null): string | null {
  if (code === DEMO_ALREADY_USED) return 'subscription.demoAlreadyUsed';
  if (code === DEMO_CODE_INVALID) return 'subscription.demoCodeInvalid';
  if (code === DEMO_DISABLED) return 'subscription.demoDisabled';
  return null;
}

/**
 * How watching an order ended.
 *
 * `mismatch` is its own outcome rather than a failure to pay: the payment
 * went through, but the license it bought was scoped to another app, so the
 * page must say something other than either "unlocked" or "payment failed".
 */
export type OrderOutcome = 'paid' | 'timeout' | 'cancelled' | 'mismatch';

/** The message for a coded failure, or null when the raw reason is all there
 *  is to say. */
export function licenseErrorKey(code?: string | null): string | null {
  if (code === APP_MISMATCH) return 'subscription.appMismatch';
  if (code === EXPIRED) return 'subscription.activateExpired';
  return null;
}

export interface LicensePayload {
  userId: string;
  /** Which app the service issued this for. Absent on tokens minted before
   *  the service grew the dimension — those are this app's. */
  appId?: string;
  /** `demo` for the licence this build issues itself; otherwise a plan the
   *  service sold. */
  planId: LicensePlanId;
  licenseKey: string;
  /** Unix seconds. The single source of truth for when access ends. */
  expiresAt: number;
  issuedAt: number;
  features?: string[];
}

/** Where the trial dates came from — the service, or this machine alone. */
export type TrialSource = 'none' | 'server' | 'local';

export interface TrialState {
  used: boolean;
  active: boolean;
  /** ISO, or null when this device has no trial record. */
  start: string | null;
  end: string | null;
  msRemaining: number;
  durationDays: number;
  source: TrialSource;
}

export interface LicenseState {
  status: LicenseStatus;
  payload: LicensePayload | null;
  expiresAt: string | null;
  daysRemaining: number;
  graceDaysLeft: number;
  trial: TrialState;
}

export const LOADING_STATE: LicenseState = {
  status: 'loading',
  payload: null,
  expiresAt: null,
  daysRemaining: 0,
  graceDaysLeft: 0,
  trial: { used: false, active: false, start: null, end: null, msRemaining: 0, durationDays: 3, source: 'none' },
};

/** A pending order, as `POST /create-order` returns it. */
export interface Order {
  orderId: string;
  planId: PlanId;
  method: PaymentMethodId;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  amount: number;
  currency: string;
  createdAt: number;
  presentAs: PresentAs;
  redirectUrl: string;
}

// ─── What a state unlocks ──────────────────────────────────────────────
/**
 * A paid license is in force — including the grace period, which exists so a
 * network that cannot be reached does not read as an expiry.
 */
export function isLicensed(status: LicenseStatus): boolean {
  return status === 'active' || status === 'grace_period';
}

export interface Entitlements {
  /** Temporal fill — the multi-frame reconstruction. */
  temporalFill: boolean;
  /** The learned (GPU) engine behind temporal fill. */
  deepLearning: boolean;
  /** The longest preview clip that may be requested. */
  maxPreviewSeconds: number;
  /** How many files a batch may hold. No batch UI exists yet; the cap is
   *  here so it comes from one place when one does. */
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

/**
 * How much of the trial's temporal allowance is left, as the main process
 * reports it. Null until it has answered.
 */
export interface TemporalAllowance {
  /** Whether temporal fill may run at all right now. */
  allowed: boolean;
  remaining: number;
  limit: number;
  limited: boolean;
}

/**
 * The limits in force.
 *
 * The trial used to sit on the free tier outright: it bought time to evaluate
 * the basics, and none of the paid features. It now gets a metered allowance
 * of temporal fill on top — enough to finish something small with the method
 * that is the reason to subscribe, not enough to finish a project with it.
 * The count and the cap are the main process's (electron/temporal-usage.js);
 * this only spends what it is handed.
 *
 * `allowance` omitted means no allowance is known — an older main process, or
 * the first frames before it has answered — and the trial falls back to the
 * free tier exactly as it did before.
 */
export function entitlementsFor(
  state: LicenseState,
  allowance?: TemporalAllowance | null,
): Entitlements {
  if (isLicensed(state.status)) return PAID_TIER;
  if (!allowance?.allowed) return FREE_TIER;
  // Temporal fill and the learned engine move together: the second is the
  // first's other implementation, not a feature of its own, so metering one
  // and withholding the other would offer a method that cannot run its
  // faster path for no reason the user could see.
  return { ...FREE_TIER, temporalFill: true, deepLearning: true };
}

// ─── Naming and formatting ─────────────────────────────────────────────
const PLAN_KEY: Record<LicensePlanId, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semi_annual: 'Halfyear',
  annual: 'Yearly',
  demo: 'Demo',
};

export function planNameKey(id: LicensePlanId): string {
  return `subscription.plan${PLAN_KEY[id] ?? 'Monthly'}`;
}

export function planTaglineKey(id: PlanId): string {
  return `${planNameKey(id)}Tagline`;
}

/** The badge over a plan card, if it has one. */
export function planBadgeKey(id: PlanId): string | null {
  if (id === 'quarterly') return 'subscription.badgePopular';
  if (id === 'semi_annual') return 'subscription.badgeValue';
  if (id === 'annual') return 'subscription.badgeBest';
  return null;
}

/** Whether what is in force is a demo licence rather than a purchase. Read
 *  off the plan id, which is the only thing that separates the two. */
export function isDemoLicense(state: LicenseState): boolean {
  return state.payload?.planId === DEMO_PLAN_ID;
}

/** What to call the state in force. */
export function statusNameKey(state: LicenseState): string {
  if (state.status === 'active') return planNameKey(state.payload?.planId ?? 'monthly');
  if (state.status === 'grace_period') return 'subscription.statusGrace';
  if (state.status === 'loading') return 'subscription.statusLoading';
  if (state.trial.active) return 'subscription.statusTrial';
  if (state.status === 'expired') return 'subscription.statusExpired';
  return state.trial.used ? 'subscription.statusTrialEnded' : 'subscription.statusNone';
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** "2 days 14:23", in whichever language, via the caller's `t`. */
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

/**
 * A price for display.
 *
 * The service returns major units and an ISO currency; CNY is the configured
 * one and gets its own symbol, and anything else is rendered by the platform
 * so a re-configured service does not need a client release.
 */
export function formatPrice(plan: Pick<Plan, 'price' | 'currency'>, locale: string): string {
  if (plan.currency === 'cny') return `¥${plan.price}`;
  try {
    return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency: plan.currency.toUpperCase(),
      maximumFractionDigits: plan.price % 1 === 0 ? 0 : 2,
    }).format(plan.price);
  } catch {
    return `${plan.price} ${plan.currency.toUpperCase()}`;
  }
}

/** The language tag the service localises payment methods by. */
export function serviceLang(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}
