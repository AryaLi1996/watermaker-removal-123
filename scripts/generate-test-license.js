#!/usr/bin/env node
'use strict';

/**
 * Mint a test licence for a development build.
 *
 * Two things are called a "code" around the licence system, and this script
 * makes both:
 *
 *   the licence key — what somebody types into the licence box. The service
 *     is the only thing that can turn one into a licence, so a key is only
 *     useful here if the deployment already knows it: mint it with
 *     `serverless/verify-license/generate_test_license.py --write` in
 *     `ruanjian123`, which puts the row in the table this client's key is
 *     looked up in.
 *
 *   the token — the signed thing the key is exchanged *for*, and the single
 *     source of truth for what this app unlocks (see license-token.js). It is
 *     verified with the HMAC secret this build already holds, which is why a
 *     token can be minted here at all, with no service and no network.
 *
 * So: `--install` writes a token into this machine's `license.enc` and the
 * next launch comes up licensed, no service involved. Everything else prints.
 *
 * This is the developer's own machine, an ordinary consequence of a symmetric
 * signing secret — the same forgery license-token.js's header names and points
 * at RSA to close. It is not a way past a licence on anyone *else's* machine:
 * the token has to be signed with the secret that build verifies with, and a
 * release build does not ship the default one.
 *
 * Usage:
 *   node scripts/generate-test-license.js [options]
 *
 *   --plan <id>        monthly | quarterly | semi_annual | annual | demo
 *                      (default: annual)
 *   --days <n>         override the plan's length; negative mints an
 *                      already-expired licence, which is how to reach the
 *                      expired and grace-period states on purpose
 *   --app-id <id>      which app the token names (default: this build's)
 *   --user-id <id>     the identity to issue to (default: a random test one)
 *   --key <key>        the licence key the token names (default: a random
 *                      TEST-… one)
 *   --count <n>        how many to mint (default: 1)
 *   --json             print JSON instead of a summary
 *   --install          write the token into license.enc, so the next launch
 *                      is licensed
 *   --user-data <dir>  where that file goes (default: this platform's
 *                      userData directory for an unpackaged run)
 *
 * Examples:
 *   node scripts/generate-test-license.js --install
 *   node scripts/generate-test-license.js --plan monthly --days -1 --install
 *   node scripts/generate-test-license.js --count 5 --json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');

const {
  LICENSE_CONFIG, APP_ID, PLAN_TIERS, DEMO_PLAN_ID, DEMO_DURATION_DAYS,
  DEFAULT_SIGNING_SECRET,
} = require('../electron/license-config');
const { createToken, verifyToken, buildLicenseState } = require('../electron/license-token');
const secureStore = require('../electron/secure-store');

const DAY = 86400;
const TOKEN_FILE = 'license.enc';
const TS_FILE = '.license_ts';

/** The features the service stamps into every token (`ALLOWED_FEATURES` in
 *  handler.py). They are SootheVoice's, and this app gates on holding a valid
 *  licence rather than on the list — carried anyway so a minted token is the
 *  same shape as an issued one. */
const FEATURES = ['training', 'synthesis', 'separation', 'cover'];

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `TEST-XXXX-XXXX-XXXX` — the service's key shape with a prefix that says
 *  what it is, and inside the `^[A-Za-z0-9_-]{8,64}$` the service enforces. */
function generateLicenseKey(prefix = 'TEST') {
  const group = () => Array.from(randomBytes(4))
    .map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length])
    .join('');
  return [prefix, group(), group(), group()].filter(Boolean).join('-');
}

function planDurationDays(planId) {
  if (planId === DEMO_PLAN_ID) return DEMO_DURATION_DAYS;
  const tier = PLAN_TIERS.find((t) => t.id === planId);
  if (!tier) {
    const known = [...PLAN_TIERS.map((t) => t.id), DEMO_PLAN_ID].join(', ');
    throw new Error(`unknown plan '${planId}' — one of: ${known}`);
  }
  return tier.durationDays;
}

/**
 * One licence: the payload the app will read back, and the token that carries
 * it. The claims are the service's, field for field — `create_token` in
 * handler.py — because a token this app cannot tell from an issued one is the
 * whole point of minting one.
 */
function mint({ planId = 'annual', days, appId = APP_ID, userId, licenseKey, now } = {}) {
  const duration = days === undefined || days === null ? planDurationDays(planId) : Number(days);
  if (!Number.isFinite(duration)) throw new Error(`--days must be a number, got '${days}'`);

  const issuedAt = Math.floor((now === undefined ? Date.now() : now) / 1000);
  const payload = {
    userId: userId || `test_${randomBytes(4).toString('hex')}`,
    planId,
    licenseKey: licenseKey || generateLicenseKey(),
    expiresAt: issuedAt + duration * DAY,
    issuedAt,
    features: FEATURES,
    appId,
  };
  return { payload, token: createToken(payload), durationDays: duration };
}

/**
 * Where an unpackaged run keeps its userData.
 *
 * Electron derives this from the app name, which for a run out of this
 * checkout is package.json's `name`. A *packaged* build uses the productName
 * instead — "SmoothVoice Watermark Remover" — so pass `--user-data` when the
 * licence is meant for one of those.
 */
function defaultUserDataDir(appName = 'smoothvoice-watermark-remover', platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName);
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName);
}

/**
 * Write the token where the app looks for it.
 *
 * `license.enc` is machine-bound (secure-store.js), so this only produces a
 * readable licence on the machine it runs on — which is the machine wanting
 * one. `.license_ts` is cleared alongside it: it is the high-water mark that
 * makes a wound-back clock read as tampering, and a stale one left over from
 * an earlier licence would make this one look exactly like that.
 */
function install(userDataDir, token) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, TOKEN_FILE), secureStore.encrypt(userDataDir, token), { mode: 0o600 });
  try {
    fs.unlinkSync(path.join(userDataDir, TS_FILE));
  } catch {
    // Not there — nothing to clear.
  }
}

const USAGE = `Mint a test licence for a development build.

Usage: node scripts/generate-test-license.js [options]

  --plan <id>        monthly | quarterly | semi_annual | annual | demo (default: annual)
  --days <n>         override the plan's length; negative mints an expired licence
  --app-id <id>      which app the token names (default: this build's)
  --user-id <id>     the identity to issue to (default: a random test one)
  --key <key>        the licence key the token names (default: a random TEST-... one)
  --count <n>        how many to mint (default: 1)
  --json             print JSON instead of a summary
  --install          write the token into license.enc, so the next launch is licensed
  --user-data <dir>  where that file goes (default: this platform's userData directory
                     for an unpackaged run; a packaged build's is named after the
                     productName instead)

A licence key is only good against the service if the service knows it: mint one
with serverless/verify-license/generate_test_license.py --write in ruanjian123.`;

function parseArgs(argv) {
  const opts = { plan: 'annual', count: 1 };
  const flags = { '--json': 'json', '--install': 'install' };
  const values = {
    '--plan': 'plan', '--days': 'days', '--app-id': 'appId', '--user-id': 'userId',
    '--key': 'key', '--count': 'count', '--user-data': 'userData',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (flags[arg]) { opts[flags[arg]] = true; continue; }
    if (values[arg]) {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      opts[values[arg]] = argv[i];
      continue;
    }
    throw new Error(`unknown option '${arg}' — try --help`);
  }
  if (opts.days !== undefined) opts.days = Number(opts.days);
  opts.count = opts.key ? 1 : Number(opts.count);
  if (!Number.isInteger(opts.count) || opts.count < 1) throw new Error('--count must be a positive integer');
  return opts;
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  let minted;
  try {
    minted = Array.from({ length: opts.count }, () => mint({
      planId: opts.plan, days: opts.days, appId: opts.appId,
      userId: opts.userId, licenseKey: opts.key,
    }));
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  const userDataDir = opts.install ? (opts.userData || defaultUserDataDir()) : null;
  if (opts.install) {
    if (minted.length > 1) {
      console.error('error: --install writes one licence — drop --count, or install one of them by hand');
      return 2;
    }
    try {
      install(userDataDir, minted[0].token);
    } catch (err) {
      console.error(`error: could not write the licence: ${err.message}`);
      return 1;
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = minted.map((m) => ({
    ...m.payload,
    durationDays: m.durationDays,
    token: m.token,
    status: buildLicenseState(verifyToken(m.token), nowSeconds).status,
  }));

  if (opts.json) {
    console.log(JSON.stringify({ installedTo: userDataDir, licenses: rows }, null, 2));
  } else {
    for (const row of rows) {
      console.log([
        `  licence key : ${row.licenseKey}`,
        `  app id      : ${row.appId}`,
        `  plan        : ${row.planId} (${row.durationDays}d)`,
        `  user id     : ${row.userId}`,
        `  expires     : ${new Date(row.expiresAt * 1000).toISOString()}`,
        `  reads as    : ${row.status}`,
        `  installed   : ${userDataDir || 'nowhere — printed only'}`,
        `  token       : ${row.token}`,
        '',
      ].join('\n'));
    }
    if (LICENSE_CONFIG.signingSecret === DEFAULT_SIGNING_SECRET) {
      console.error('note: signed with the public default secret, so this licence is good for an '
        + 'unconfigured build only — a build carrying a real secret will not verify it.');
    }
    if (userDataDir) {
      console.error('note: license.enc is bound to this machine — copying it elsewhere will not decrypt.');
    }
    if (opts.install && rows[0].appId !== APP_ID) {
      // Worth saying out loud: the token verifies, so nothing downstream
      // errors — the app just reads as unlicensed, which looks like the mint
      // failing rather than like the appId check doing its job.
      console.error(`warning: this licence names '${rows[0].appId}', not '${APP_ID}', so this build `
        + 'will ignore it at startup and come up unlicensed.');
    }
  }
  return 0;
}

module.exports = {
  mint, generateLicenseKey, planDurationDays, defaultUserDataDir, install,
  parseArgs, FEATURES, TOKEN_FILE, TS_FILE,
};

if (require.main === module) process.exit(main());
