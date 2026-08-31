'use strict';

/**
 * Where the license service lives, and what this client believes when it
 * cannot reach it.
 *
 * The service is the one described in
 * https://github.com/AryaLi1996/ruanjian123/blob/main/docs/LICENSE_INFRASTRUCTURE.md
 * — a single Lambda backed by three DynamoDB tables, which this app shares
 * rather than standing up its own. Every route lives on the same base URL and
 * is dispatched by path suffix (`path.endswith(...)` in that handler), so the
 * URL below can be either the Lambda Function URL or an API Gateway stage
 * that fronts the same function: a stage prefix like `/prod` still ends with
 * the route, and the handler reads `requestContext.http.path` and `path` as
 * well as `rawPath`.
 */

/**
 * Shipped in source as a template default, exactly as in the service's own
 * handler.py and the reference client — so it is not a secret. A build that
 * still has this value when the service is signing real tokens can have those
 * tokens forged offline, which is why `usingDefaultSigningSecret` is exported
 * and warned about at startup.
 */
const DEFAULT_SIGNING_SECRET = 'ruanjian-dev-signing-secret-v1-change-in-production';

/**
 * Which application this client is, as far as the license service is
 * concerned.
 *
 * The service holds one set of tables for every app on the account, so a
 * subscription and a device trial are only this app's if every request says
 * whose they are. Without the dimension a plan bought in SootheVoice
 * satisfies this app and a trial spent there arrives here already used —
 * which is what docs/LICENSE_SERVICE.md listed as the cost of sharing.
 *
 * `smoothvoice` and not `shuyin`: this app's rows already exist in the
 * service's tables without an appId, and the migration stamps exactly that
 * value onto them. It is also the value the service falls back to for a
 * request that carries none, so an upgraded client and an old one still
 * resolve to the same subscription. Renaming the id here would strand every
 * license bought before this change.
 */
const DEFAULT_APP_ID = 'smoothvoice';

/**
 * `LICENSE_APP_ID` is the main process's name for it; `VITE_APP_ID` is
 * accepted too so a build that sets the renderer's copy does not end up with
 * the two halves disagreeing about which app they are.
 */
const APP_ID = String(process.env.LICENSE_APP_ID || process.env.VITE_APP_ID || DEFAULT_APP_ID).trim()
  || DEFAULT_APP_ID;

/** The deployed Function URL from the infrastructure doc. */
const DEFAULT_LICENSE_URL = 'https://5pmjnezmzrbjw2tjmnzpt232xy0duvyr.lambda-url.us-east-1.on.aws/';

/**
 * The plan tiers, matching `_PLAN_TIERS` in the service's handler.py.
 *
 * The ids are the service's, not this app's former ones: reusing its
 * `/create-order` and `LicensesTable` means using the ids it validates
 * against. `semi_annual` and `annual` were `halfyear` and `yearly` here.
 */
const PLAN_TIERS = [
  { id: 'monthly', period: 'month', durationDays: 30, months: 1, discountPercent: 0 },
  { id: 'quarterly', period: 'quarter', durationDays: 90, months: 3, discountPercent: 5 },
  { id: 'semi_annual', period: 'half_year', durationDays: 180, months: 6, discountPercent: 10 },
  { id: 'annual', period: 'year', durationDays: 365, months: 12, discountPercent: 15 },
];

const FALLBACK_BASE_MONTHLY_PRICE = 99;
const FALLBACK_CURRENCY = 'cny';
const FALLBACK_USD_EXCHANGE_RATE = 7.0;

/**
 * The price of `months` at `discountPercent` off, rounded the way the service
 * rounds it.
 *
 * Half-up to the whole yuan, mirroring `_plan_price` in handler.py — which
 * uses Decimal with ROUND_HALF_UP for the reason its comment gives: for money,
 * landing on the wrong side of a rounding boundary is a real discrepancy.
 * This app used to round *down* here; the service is the source of truth for
 * price now, so the fallback has to agree with it or the offline cards would
 * quote something the checkout would not charge.
 */
function planPrice(months, discountPercent) {
  const raw = FALLBACK_BASE_MONTHLY_PRICE * months * (1 - discountPercent / 100);
  return FALLBACK_CURRENCY === 'cny'
    ? Math.round(raw + Number.EPSILON)
    : Math.round((raw + Number.EPSILON) * 100) / 100;
}

function planPriceUSD(priceMajorUnits) {
  return Math.round(priceMajorUnits / FALLBACK_USD_EXCHANGE_RATE);
}

/**
 * The plan cards to show when `GET /plans` cannot be reached.
 *
 * A fallback only: the service computes these from its own environment
 * (`BASE_MONTHLY_PRICE`, `PLAN_CURRENCY`), so a price changed there and not
 * here is right on the server and stale in this table. Keep them in sync.
 */
function fallbackPlans() {
  return PLAN_TIERS.map(({ id, period, durationDays, months, discountPercent }) => {
    const price = planPrice(months, discountPercent);
    // Computed in one rounding step from the undiscounted total rather than
    // by multiplying the monthly plan's already-rounded price, which would
    // compound two roundings and drift off the discount badge.
    const originalPrice = planPrice(months, 0);
    return {
      id,
      period,
      durationDays,
      discountPercent,
      price,
      priceUSD: planPriceUSD(price),
      originalPrice,
      originalPriceUSD: planPriceUSD(originalPrice),
      amount: Math.round(price * 100),
      currency: FALLBACK_CURRENCY,
    };
  });
}

/** The methods the service can offer. Which are actually live comes from
 *  `GET /payment-methods`; this is only for rendering an old order whose
 *  method has since been switched off. */
const PAYMENT_METHODS = ['wechat_pay', 'alipay', 'douyin_pay', 'card'];

/**
 * Whether the app offers a box to type a licence into.
 *
 * Off by default, and meant for internal testing and the occasional offline
 * or redeemed activation — not because the path is less trustworthy than
 * paying (it runs the same verification, and forging anything it accepts
 * still needs the signing secret) but because a field asking for a code the
 * shop never issues is a support question waiting to happen.
 */
const manualActivationEnabled = process.env.ENABLE_MANUAL_ACTIVATION === 'true';

const LICENSE_CONFIG = {
  /** Which app the service should scope this client's trial, orders and
   *  license to. Sent on every route. */
  appId: APP_ID,

  /** Function URL or API Gateway stage — both work, see the note above. */
  verificationUrl: process.env.LICENSE_URL || DEFAULT_LICENSE_URL,
  signingSecret: process.env.LICENSE_SIGNING_SECRET || DEFAULT_SIGNING_SECRET,

  /** Days after expiry that the app keeps working, so a failed network call
   *  or a flight does not lock someone out of what they paid for. */
  gracePeriodDays: 3,
  /** How often a valid license is re-fetched in the background. */
  refreshIntervalHours: 12,

  /** How the client watches a pending payment, matching the service's flow. */
  orderPollIntervalMs: 3_000,
  orderPollTimeoutMs: 10 * 60_000,

  trial: {
    /** Only used for a first launch that is also offline: the service reports
     *  its own `trialDurationDays`, and that answer is cached and preferred. */
    durationDays: 3,
    syncIntervalHours: 6,
  },

  /** Interactive calls can afford a cold Lambda start. */
  requestTimeoutMs: 15_000,
  /** The startup path cannot: an unreachable service must not hold up launch. */
  startupTimeoutMs: 5_000,
};

const usingDefaultSigningSecret = LICENSE_CONFIG.signingSecret === DEFAULT_SIGNING_SECRET;

module.exports = {
  manualActivationEnabled,
  DEFAULT_SIGNING_SECRET,
  DEFAULT_LICENSE_URL,
  DEFAULT_APP_ID,
  APP_ID,
  PLAN_TIERS,
  PAYMENT_METHODS,
  FALLBACK_BASE_MONTHLY_PRICE,
  FALLBACK_CURRENCY,
  FALLBACK_USD_EXCHANGE_RATE,
  planPrice,
  planPriceUSD,
  fallbackPlans,
  LICENSE_CONFIG,
  usingDefaultSigningSecret,
};
