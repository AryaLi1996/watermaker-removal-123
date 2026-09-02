'use strict';

/**
 * The demo licence, as this process remembers it.
 *
 * Every licence in this app comes from the shared service
 * (docs/LICENSE_SERVICE.md), and since `demo/activate` this includes the
 * demo: the service signs the token and holds the "one per app, per device"
 * record. What is left in this file is the local copy of that record — the
 * dates, not the entitlement — so the page can say "this device has already
 * had its demo, until the 3rd" without a round trip, and can still say it
 * with no network at all.
 *
 * This used to be the other half of the feature. The token was minted here
 * and signed with the HMAC secret this build verifies with, unlocked by one
 * of a couple of codes that shipped in license-config.js, and limited to one
 * per device by this very file. Both halves were unenforceable, and it is
 * worth stating why rather than burying it:
 *
 *  * the codes went out with every installer, so "knowing the code" was
 *    never a credential — and there is now nothing to leak or rotate,
 *    because there is no code. A demo is granted on "this device has not
 *    taken one for this app", which is a fact the service holds;
 *  * the limit was a file in the app's own data directory, so it stopped an
 *    honest user clicking twice and stopped nobody who deleted it. The limit
 *    is now a conditional put in the service's DemosTable, and deleting this
 *    file gets the *same* demo window back, not a new one.
 *
 * The record is still encrypted with the machine-bound store the trial dates
 * use. That is no longer a limit — the service is — but a cache that can be
 * hand-edited is a cache that lies to the page about how long is left.
 */

const fs = require('fs');
const path = require('path');

const { APP_ID, DEMO_DURATION_DAYS } = require('./license-config');
const secureStore = require('./secure-store');

/** Sits beside `license.enc` and `trial.enc` in the app's userData. */
const DEMO_FILE = 'demo.enc';

/**
 * The failures the interface words differently.
 *
 * `DEMO_ALREADY_USED` and `DEMO_DISABLED` are final in their own ways — a
 * demo this device has spent, a build that does not offer them — so neither
 * reads as "try again". `DEMO_UNAVAILABLE` is the opposite and has to be
 * told apart from them: the service could not be reached, nothing was spent,
 * and trying again later is exactly the right advice. Before `demo/activate`
 * that state could not arise, because nothing was asked.
 */
const DEMO_ALREADY_USED = 'demo_already_used';
const DEMO_DISABLED = 'demo_disabled';
const DEMO_UNAVAILABLE = 'demo_unavailable';

/** The service's code for a demo that is spent, as it appears in a reply. */
const SERVICE_ALREADY_USED = 'demo_already_used';

function demoPath(userDataDir) {
  return path.join(userDataDir, DEMO_FILE);
}

/**
 * This device's cached demo record, or null if it has never taken one *that
 * this process has seen*.
 *
 * Anything unreadable — no file, a store that cannot decrypt it, a rewritten
 * file — reads as "no record", and that is now a cheap failure rather than a
 * generous one: the worst it does is offer a button the service then refuses,
 * where before it handed out a second demo.
 */
function readDemoRecord(userDataDir) {
  try {
    const plain = secureStore.decrypt(userDataDir, fs.readFileSync(demoPath(userDataDir)));
    const rec = plain ? JSON.parse(plain) : null;
    return rec && typeof rec.issuedAt === 'number' && typeof rec.expiresAt === 'number' ? rec : null;
  } catch {
    return null;
  }
}

function writeDemoRecord(userDataDir, rec) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      demoPath(userDataDir),
      secureStore.encrypt(userDataDir, JSON.stringify(rec)),
      { mode: 0o600 },
    );
  } catch {
    // Only the cache is lost. The licence was still issued, and the service
    // still knows this device has had its demo.
  }
}

/**
 * Whether this device has already taken its demo *for this app*, as far as
 * the cache knows.
 *
 * Scoped by appId for the reason the whole appId dimension exists, and
 * matching how the service keys the record: a demo spent in the sibling app
 * on the same machine is not this app's demo. A record from before this
 * field existed carries no appId and is read as this app's.
 */
function demoUsed(userDataDir, appId = APP_ID) {
  const rec = readDemoRecord(userDataDir);
  return !!rec && (rec.appId == null || rec.appId === appId);
}

/**
 * The record to cache from a `demo/activate` or `demo/status` reply.
 *
 * The dates are the service's, not this clock's: a demo is a window the
 * service decided and the token was signed for, so a machine whose clock is
 * off should still be told the truth about when it ends. `durationDays` is
 * cached for the same reason `trialDurationDays` is — so the two halves do
 * not each carry their own idea of how long a demo runs.
 */
function recordFromService(reply, { appId = APP_ID, deviceId } = {}) {
  if (!reply || typeof reply.issuedAt !== 'number' || typeof reply.expiresAt !== 'number') return null;
  return {
    appId: typeof reply.appId === 'string' && reply.appId ? reply.appId : appId,
    deviceId,
    issuedAt: reply.issuedAt,
    expiresAt: reply.expiresAt,
    durationDays: typeof reply.demoDurationDays === 'number' && reply.demoDurationDays > 0
      ? reply.demoDurationDays
      : DEMO_DURATION_DAYS,
  };
}

/** Whether a reply is the service refusing a demo this device already spent
 *  — the one refusal that will never come good, however many times it is
 *  retried. Matched on the code, with the message as a fallback for a reply
 *  that carries only prose. */
function isAlreadyUsed(reply) {
  if (!reply) return false;
  if (reply.code === SERVICE_ALREADY_USED) return true;
  return typeof reply.error === 'string' && reply.error.includes('already used');
}

module.exports = {
  DEMO_FILE,
  DEMO_ALREADY_USED,
  DEMO_DISABLED,
  DEMO_UNAVAILABLE,
  readDemoRecord,
  writeDemoRecord,
  demoUsed,
  recordFromService,
  isAlreadyUsed,
};
