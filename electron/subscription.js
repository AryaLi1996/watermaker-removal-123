'use strict';

/**
 * Subscription state, kept on disk.
 *
 * One small JSON file in the app's own data directory — the same place
 * electron-store would have put it, without the dependency for a record this
 * shape. The renderer never touches the file; it asks over IPC, so the trial
 * is created exactly once no matter how many windows are open.
 *
 * Nothing here is a security boundary: the file is the user's, and editing it
 * grants the paid features. Real entitlement checking belongs on a server,
 * and this ticket's payment step is a simulation.
 */

const fs = require('fs');
const path = require('path');

const TRIAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Months of access each plan buys. Mirrors PLANS in renderer/src/subscription.ts. */
const PLAN_MONTHS = {
  monthly: 1,
  quarterly: 3,
  halfyear: 6,
  yearly: 12,
};

const PAYMENT_METHODS = ['wechat', 'alipay'];

/** Where the record lives. Injected in tests; the app passes app.getPath('userData'). */
function storePath(userDataDir) {
  return path.join(userDataDir, 'subscription.json');
}

function isRecord(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.plan === 'string' &&
    typeof value.startDate === 'string' &&
    typeof value.endDate === 'string'
  );
}

/**
 * Read the record, or null when there is none.
 *
 * A file that is missing, unreadable or corrupt reads as "no record", which
 * starts a fresh trial. Losing a paid plan to a truncated file would be worse
 * than the alternative, but so would refusing to start the app over one.
 */
function read(userDataDir) {
  try {
    const raw = fs.readFileSync(storePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return { ...parsed, autoRenew: !!parsed.autoRenew };
  } catch {
    return null;
  }
}

/** Persist the record. A write that fails still applies for this session. */
function write(userDataDir, record) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(storePath(userDataDir), JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    console.warn('[subscription] could not save:', err.message);
  }
  return record;
}

function startTrial(now = Date.now()) {
  return {
    plan: 'trial',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
    autoRenew: false,
  };
}

/**
 * The current record, creating the trial on the first ever call.
 *
 * The trial is written the moment it is granted, so a second launch reads the
 * same end date rather than granting three more days.
 */
function getStatus(userDataDir, now = Date.now()) {
  const stored = read(userDataDir);
  if (stored) return stored;
  return write(userDataDir, startTrial(now));
}

/**
 * Record a successful payment.
 *
 * Time left on a paid plan carries over, matching `applyPurchase` in the
 * renderer: renewing early must not cost the user days.
 */
function subscribe(userDataDir, plan, paymentMethod, now = Date.now()) {
  const months = PLAN_MONTHS[plan];
  if (!months) throw new Error(`Unknown plan: ${plan}`);
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new Error(`Unknown payment method: ${paymentMethod}`);
  }

  const current = read(userDataDir);
  const carried = current && PLAN_MONTHS[current.plan] ? Date.parse(current.endDate) : NaN;
  const from = Number.isFinite(carried) && carried > now ? carried : now;
  const end = new Date(from);
  end.setMonth(end.getMonth() + months);

  return write(userDataDir, {
    plan,
    startDate: new Date(now).toISOString(),
    endDate: end.toISOString(),
    autoRenew: true,
  });
}

/**
 * Turn auto-renewal off (or back on).
 *
 * The plan itself is untouched: cancelling renewal keeps what was paid for
 * until its end date, which is what the user bought.
 */
function setAutoRenew(userDataDir, autoRenew, now = Date.now()) {
  const current = getStatus(userDataDir, now);
  return write(userDataDir, { ...current, autoRenew: !!autoRenew });
}

module.exports = {
  TRIAL_DAYS,
  PLAN_MONTHS,
  PAYMENT_METHODS,
  storePath,
  read,
  write,
  startTrial,
  getStatus,
  subscribe,
  setAutoRenew,
};
