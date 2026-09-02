'use strict';

/**
 * The demo licence: seven days of everything, issued by this build itself.
 *
 * Every other licence in this app comes from the shared service
 * (docs/LICENSE_SERVICE.md) — a payment settles, its webhook mints a token,
 * and this process adopts it. A demo has no payment to settle, and the
 * service has no route that issues one, so the token is minted here and
 * signed with the same HMAC secret this build already verifies with.
 *
 * That is the whole of the honesty problem with this feature, and it is worth
 * stating plainly rather than burying:
 *
 *  * a demo token is indistinguishable from a purchased one to anything that
 *    only checks the signature, which is why it carries `planId: 'demo'` —
 *    the one field that tells them apart, and the one the interface reads;
 *  * the "once per device" limit is a file in the app's own data directory,
 *    so it stops an honest user clicking twice and stops nobody who deletes
 *    it. A real limit would need the service to hold the record, which is
 *    what `demo-activate` in the infrastructure repo would be for;
 *  * therefore the entry is a build-time decision. `demoLicenseEnabled` in
 *    license-config.js gates it, and `renderer/.env.production` turns it off
 *    for a release.
 *
 * The record is encrypted with the same machine-bound store the trial dates
 * use — not because the dates are secret, but so they cannot be edited to
 * take a second demo without also having to find and remove the file.
 */

const fs = require('fs');
const path = require('path');

const { APP_ID, DEMO_CODES, DEMO_DURATION_DAYS, DEMO_PLAN_ID } = require('./license-config');
const { createToken } = require('./license-token');
const secureStore = require('./secure-store');

/** Sits beside `license.enc` and `trial.enc` in the app's userData. */
const DEMO_FILE = 'demo.enc';

/**
 * The failures the interface words differently.
 *
 * Every one of them is final in its own way — a second demo, a code that is
 * not one of ours, a build that does not offer demos at all — so none of them
 * reads as "try again", which is what an uncoded error means everywhere else
 * in this module's neighbours.
 */
const DEMO_ALREADY_USED = 'demo_already_used';
const DEMO_CODE_INVALID = 'demo_code_invalid';
const DEMO_DISABLED = 'demo_disabled';

/** Codes are compared case-insensitively and trimmed: they get typed in by
 *  hand and read off a slide, and a capital letter is not a wrong answer. */
function normalizeCode(input) {
  return String(input == null ? '' : input).trim().toUpperCase();
}

/** Whether what was typed is one of this build's demo codes. Not a secret
 *  check — the codes ship in license-config.js — so no constant time here. */
function isDemoCode(input) {
  const entered = normalizeCode(input);
  return entered !== '' && DEMO_CODES.some((code) => normalizeCode(code) === entered);
}

function demoPath(userDataDir) {
  return path.join(userDataDir, DEMO_FILE);
}

/**
 * This device's demo record, or null if it has never taken one.
 *
 * Anything unreadable — no file, a store that cannot decrypt it, a rewritten
 * file — reads as "no record". The failure mode is granting a demo that was
 * already taken, which is the right way round: refusing one because a file
 * went bad would be a support ticket about a feature that exists to avoid
 * support tickets.
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
    // The licence was still issued and is still in force for this session;
    // only the "one per device" mark is lost.
  }
}

/**
 * Whether this device has already taken its demo *for this app*.
 *
 * Scoped by appId for the reason the whole appId dimension exists: a demo
 * spent in the sibling app on the same machine is not this app's demo. The
 * record is this app's own file, so today the check only matters for a build
 * pointed at a different `LICENSE_APP_ID` — but reading it any other way
 * would make that build inherit a demo it never issued.
 */
function demoUsed(userDataDir, appId = APP_ID) {
  const rec = readDemoRecord(userDataDir);
  return !!rec && (rec.appId == null || rec.appId === appId);
}

/**
 * A signed demo token for this device.
 *
 * The payload is shaped exactly like the service's, so everything downstream
 * — `verifyToken`, `buildLicenseState`, the grace period — treats it as the
 * licence it is. `planId` is what marks it as a demo, and the licence key is
 * derived from the device rather than random so a support conversation about
 * "which demo is this" has an answer.
 */
function mintDemoToken({
  userId,
  deviceId,
  nowSeconds,
  appId = APP_ID,
  durationDays = DEMO_DURATION_DAYS,
}) {
  return createToken({
    userId,
    appId,
    planId: DEMO_PLAN_ID,
    licenseKey: `DEMO-${String(deviceId).slice(0, 16).toUpperCase()}`,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + durationDays * 86400,
  });
}

module.exports = {
  DEMO_FILE,
  DEMO_ALREADY_USED,
  DEMO_CODE_INVALID,
  DEMO_DISABLED,
  normalizeCode,
  isDemoCode,
  readDemoRecord,
  writeDemoRecord,
  demoUsed,
  mintDemoToken,
};
