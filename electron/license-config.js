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
 * What the build baked in, if anything.
 *
 * The main process is not bundled — `files: ['electron/**']` copies it into
 * the asar as-is — so `process.env.LICENSE_SIGNING_SECRET` here is read on the
 * *end user's* machine at launch, where nothing sets it. Until this file
 * existed there was no path at all from a release job to a packaged build, so
 * every shipped build verified licences with the public default below,
 * whatever the job was handed.
 *
 * `scripts/write-build-config.js` writes this immediately before
 * electron-builder runs, and writes nothing when the build names nothing — so
 * an unconfigured build behaves exactly as it always has, and `npm run dev`
 * is unaffected either way.
 *
 * Missing, unreadable or malformed all read as "the build baked nothing in".
 * A packaged app that cannot parse its own generated file has a broken
 * install, and refusing to start over it would turn a licence question into a
 * launch failure.
 */
function readBuildConfig() {
  try {
    // eslint-disable-next-line global-require
    return require('./build-config.json') || {};
  } catch {
    return {};
  }
}

const BUILD_CONFIG = readBuildConfig();

/**
 * A build-time value, or the environment's if it has one.
 *
 * The environment wins so a developer can point a packaged build at a test
 * deployment without rebuilding it, and so `npm run dev` keeps working the
 * way it documents. In a shipped build nothing sets these, which is what
 * makes the baked value the answer.
 */
function configured(name) {
  const fromEnv = String(process.env[name] || '').trim();
  if (fromEnv) return fromEnv;
  return String(BUILD_CONFIG[name] || '').trim();
}

/**
 * Shipped in source as a template default, exactly as in the service's own
 * handler.py and the reference client — so it is not a secret. A build that
 * still has this value when the service is signing real tokens can have those
 * tokens forged offline, which is why `usingDefaultSigningSecret` is exported
 * and warned about at startup.
 */
const DEFAULT_SIGNING_SECRET = 'ruanjian-dev-signing-secret-v1-change-in-production';

/**
 * The secret this build *also* accepts a token from, and never signs with.
 *
 * Rotating an HMAC secret is not like rotating a password: both ends hold the
 * same string, and the moment the service starts signing with a new one every
 * token already in a customer's hands stops verifying. To this app that reads
 * as a licence that was revoked — grace period, then locked — for people whose
 * subscription is perfectly current, and the only way out is an update they
 * have not installed yet.
 *
 * So a rotation runs in two steps. First ship a build that accepts both, and
 * wait for it to reach people. Then let the service switch which one it signs
 * with: an old token still verifies here, and the next background refresh
 * exchanges it for one signed with the new secret. Once the old secret's
 * tokens have all expired or been refreshed, a later build drops this.
 *
 * Empty means "one secret", which is the normal state — this is set only
 * while a rotation is in flight.
 */
const PREVIOUS_SIGNING_SECRET = configured('PREVIOUS_LICENSE_SIGNING_SECRET')
  || String(process.env.VITE_PREVIOUS_LICENSE_SIGNING_SECRET || '').trim();

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
 * `shuyin`, this app's own id — not `smoothvoice`, which is SootheVoice's.
 *
 * It used to be `smoothvoice`, on the reasoning that this app's rows already
 * existed in the service's tables without an appId, so the migration would
 * stamp them with that value and renaming would strand every licence bought
 * before the change. That reasoning does not hold, and the dates say why: the
 * licence stack arrived here on 2026-08-31 (`Move subscriptions onto the
 * shared license service`), after the 1.1.0 release on 2026-08-30, and every
 * released build predates it. No shipped build of this app has ever called
 * the service, so it has no rows there to strand — the rows that do exist
 * belong to SootheVoice, which is why `smoothvoice` stays the service's
 * DEFAULT_APP_ID and the app a legacy row is adopted for.
 *
 * Sharing the id was not free while it lasted. The service keys DemosTable by
 * "<appId>#<deviceId>" and TrialsV2Table by (deviceId, appId), so with both
 * apps sending `smoothvoice` the two collide on one machine: a demo or trial
 * spent in SootheVoice arrives here already used, which is the exact leak the
 * appId dimension exists to close.
 */
const DEFAULT_APP_ID = 'shuyin';

/**
 * `LICENSE_APP_ID` is the main process's name for it; `VITE_APP_ID` is
 * accepted too so a build that sets the renderer's copy does not end up with
 * the two halves disagreeing about which app they are.
 */
const APP_ID = configured('LICENSE_APP_ID')
  || String(process.env.VITE_APP_ID || '').trim()
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

/**
 * The demo licence: the paid features for a month, issued by the service.
 *
 * It exists for the case a trial does not cover — a demonstration, an
 * evaluation, a support conversation that needs the licensed experience on
 * someone else's machine — and it is not a purchase, which is what the plan
 * id below says. `demo` is not in `PLAN_TIERS`, so anything reading a licence
 * can tell the two apart.
 *
 * It used to be minted here, signed with the same HMAC secret this build
 * verifies with, and unlocked by one of a couple of codes that shipped in
 * this file. Neither half held: the codes went out with every installer, and
 * the "once per device" limit was a file in this app's own data directory —
 * something the device owns and can delete. Both are now the service's:
 * `demo/activate` is the only thing that signs one, and it holds the record.
 *
 * What is left here is the plan id the client recognises and a duration used
 * only for display before the service has been asked. See demo-license.js.
 */
const DEMO_PLAN_ID = 'demo';

/**
 * How long a demo runs, as far as this build knows.
 *
 * The service decides, and reports its own `demoDurationDays` on every
 * `demo/activate` and `demo/status`; that answer is cached and preferred.
 * This constant is the fallback for a first launch that is also offline —
 * the same split, and the same reason, as `trial.durationDays` below.
 */
const DEMO_DURATION_DAYS = 30;

/**
 * Whether this build offers a demo licence at all.
 *
 * On unless a build says otherwise with `VITE_DISABLE_DEMO_LICENSE=true` —
 * the renderer's name for it, read here too so the two halves cannot
 * disagree about whether the entry exists. `DISABLE_DEMO_LICENSE` is
 * accepted as well, since the `VITE_` one is a build-time value that does
 * not reach a packaged main process at runtime.
 *
 * Leaving it on now means what it says: a device that asks the service for
 * its one demo gets a month of the paid features, and asking a second time
 * gets the same month back rather than a new one. That limit is the
 * service's record, not a file this app can be talked out of — which is why
 * this flag is a choice about whether to offer the entry at all, and no
 * longer the only thing standing between a build and unlimited demos.
 */
const demoLicenseEnabled = process.env.VITE_DISABLE_DEMO_LICENSE !== 'true'
  && process.env.DISABLE_DEMO_LICENSE !== 'true';

const LICENSE_CONFIG = {
  /** Which app the service should scope this client's trial, orders and
   *  license to. Sent on every route. */
  appId: APP_ID,

  /** Function URL or API Gateway stage — both work, see the note above. */
  verificationUrl: configured('LICENSE_URL') || DEFAULT_LICENSE_URL,
  /** The one this build signs with, and the first one it tries. */
  signingSecret: configured('LICENSE_SIGNING_SECRET') || DEFAULT_SIGNING_SECRET,
  /** Also accepted, never signed with — see PREVIOUS_SIGNING_SECRET. */
  previousSigningSecret: PREVIOUS_SIGNING_SECRET,

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

/**
 * Whether a rotation is in flight, for the startup log.
 *
 * Worth saying out loud in both directions: while this is on, a token signed
 * with the old secret is still honoured, which is the point — and also means
 * a leaked old secret can still forge one. It is a window to get through, not
 * a state to sit in.
 */
const rotatingSigningSecret = LICENSE_CONFIG.previousSigningSecret !== '';

module.exports = {
  manualActivationEnabled,
  demoLicenseEnabled,
  DEMO_PLAN_ID,
  DEMO_DURATION_DAYS,
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
  rotatingSigningSecret,
};
