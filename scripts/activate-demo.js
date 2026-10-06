#!/usr/bin/env node
'use strict';

/**
 * Open the cloud filler on this machine, for a tester.
 *
 * The cloud filler is the part a watermark is actually invisible after, and
 * whether an export may use it is not this app's decision — the licence
 * service answers `fill/quota`, and it answers no unless the machine holds a
 * live licence or a live demo (`_fill_entitlement` in that service's
 * handler.py). Which left a tester with nothing to test: the automated suites
 * stub the service, `generate-test-license.js` writes a token this build
 * verifies *locally* and the service has never heard of, and the demo card
 * that used to ask for one is gone from the interface — see the header of
 * renderer/src/components/LicenseInput.tsx. So reaching the cloud path by hand
 * meant making a purchase.
 *
 * This asks for the demo the interface no longer offers. It is the same
 * `demo/activate` route the app used to call, so the limit is the same one —
 * the service holds one demo per app and device, and asking twice returns the
 * first one's window rather than a new one. Nothing here can mint, extend or
 * forge anything: the record and the signed token are both the service's.
 *
 * Then it asks `fill/quota` and prints the answer, because that is the thing
 * the tester actually needs to see. A demo that activated but still reads
 * `allowed: false` means the deployment is older than the change that made a
 * demo count, and that is worth one line rather than a confusing export.
 *
 * The cloud card itself has no licence gate (App.tsx renders it for the
 * recover method), so once this says yes the full path is: pick recover, turn
 * the cloud switch on, agree to the consent, export. `--install` is *not*
 * offered here on purpose: adopting a token into `license.enc` is
 * subscription-monitor.js's job and it does more than write a file, and the
 * cloud path does not need the app to look licensed at all. If you want it to
 * look licensed as well, that is `npm run license:test-code -- --install`.
 *
 * Usage:
 *   node scripts/activate-demo.js [options]
 *
 *   --status           ask what this machine already has; activate nothing
 *   --url <base>       the licence service (default: this build's)
 *   --app-id <id>      which app to ask about (default: this build's)
 *   --device-id <id>   ask for a different machine's demo, e.g. to reproduce
 *                      what a tester is seeing. Must satisfy the service's
 *                      own `^[A-Za-z0-9_-]{16,128}$`.
 *   --user-data <dir>  where this machine's device id is kept (default: this
 *                      platform's userData directory for an unpackaged run)
 *   --json             print the two replies instead of a summary
 *
 * Examples:
 *   node scripts/activate-demo.js
 *   node scripts/activate-demo.js --status
 *   node scripts/activate-demo.js --json
 */

const https = require('https');
const { URL } = require('url');

const { LICENSE_CONFIG, APP_ID } = require('../electron/license-config');
const { getDeviceId } = require('../electron/device-id');
const { defaultUserDataDir } = require('./generate-test-license');

/** How long to wait on the service. Long enough for a cold Lambda. */
const TIMEOUT_MS = 30_000;

/** The service's own `_DEVICE_ID_RE`; a device id becomes a partition key. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

const USAGE = `Open the cloud filler on this machine, for a tester.

Usage: node scripts/activate-demo.js [options]

  --status           ask what this machine already has; activate nothing
  --url <base>       the licence service (default: this build's)
  --app-id <id>      which app to ask about (default: this build's)
  --device-id <id>   ask about a different machine's demo
  --user-data <dir>  where this machine's device id is kept
  --json             print the replies instead of a summary

Asks the licence service for the demo the interface no longer offers, then
reports whether an export may now use the cloud filler.`;

/**
 * One route on the licence service.
 *
 * Separated, and passed in by `run`, so the decisions below have a test that
 * does not need a deployment — and so there is exactly one place that knows
 * how the service is addressed. Routes are a path suffix on one base URL, the
 * same dispatch electron/license-config.js documents.
 */
function post(base, route, body, timeout = TIMEOUT_MS) {
  const url = new URL(route, base.endsWith('/') ? base : `${base}/`);
  if (url.protocol !== 'https:') {
    // The reply carries a signed token. Over plain http it carries it to
    // whoever is listening, and this is a tester's own machine, not a lab.
    return Promise.reject(new Error(`the licence service must be https, not ${url.protocol}`));
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          // A gateway's own error page, most likely. Say what arrived rather
          // than "unexpected token <", which sends people to the wrong file.
          reject(new Error(`${route} answered ${response.statusCode} with ${text.slice(0, 200)}`));
          return;
        }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${route} did not answer in ${timeout}ms`)));
    request.on('error', reject);
    request.end(payload);
  });
}

function parseArgs(argv) {
  const opts = {
    status: false, json: false, url: '', appId: '', deviceId: '', userData: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--status') opts.status = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--url') opts.url = value();
    else if (arg === '--app-id') opts.appId = value();
    else if (arg === '--device-id') opts.deviceId = value();
    else if (arg === '--user-data') opts.userData = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

/**
 * What the quota reply means for a tester, as one line.
 *
 * Each `reason` the service can answer with gets its own sentence, because
 * they want different things done about them and "not allowed" wants nothing
 * done at all. The keys are the service's — `_fill_reply` in its handler.py —
 * and an unknown one is reported rather than smoothed over, since this script
 * being older than the service is exactly when a guess would mislead.
 */
function verdict(quota) {
  if (quota.allowed) {
    return `the cloud filler is open: ${quota.remaining} of ${quota.limit} exports left `
      + `this period (resets ${quota.periodEnds}).`;
  }
  switch (quota.reason) {
    case 'noLicense':
      return 'the service still says this machine has no licence or demo. If the demo above '
        + 'activated, this deployment predates the change that made a demo count — deploy the '
        + 'licence service and run this again.';
    case 'overLimit':
      return `this demo has spent its allowance (${quota.used} of ${quota.limit}). It resets `
        + `${quota.periodEnds}; raising FillDemoUnits on the service is the other way.`;
    case 'unavailable':
      return 'the deployment has the feature switched off — no inpaint endpoint or no signing '
        + 'secret. Exports will be filled locally until that is configured.';
    default:
      return `the service refused, and gave a reason this script does not know: `
        + `${JSON.stringify(quota.reason)}.`;
  }
}

/**
 * The whole thing, with the two things it needs from the outside passed in.
 *
 * `transport` is `post` and `log` is the console; both are arguments so that
 * what this decides is testable without a deployment or a captured stdout.
 */
async function run(argv, { transport = post, log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    err(error.message);
    err(USAGE);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  const base = opts.url || LICENSE_CONFIG.verificationUrl;
  if (!base) {
    err('no licence service configured: pass --url, or set LICENSE_URL.');
    return 2;
  }
  const appId = opts.appId || APP_ID;
  const deviceId = opts.deviceId
    || getDeviceId(opts.userData || defaultUserDataDir());
  if (!DEVICE_ID_RE.test(deviceId)) {
    // The service would refuse this with a 400 and no explanation of which
    // field it meant.
    err(`${deviceId} is not a device id the service will accept (${DEVICE_ID_RE}).`);
    return 2;
  }

  let demo;
  let quota;
  try {
    demo = await transport(base, opts.status ? 'demo/status' : 'demo/activate',
                           { appId, deviceId });
    quota = await transport(base, 'fill/quota', { appId, deviceId, userId: null });
  } catch (error) {
    err(`could not reach ${base}: ${error.message}`);
    return 1;
  }

  if (opts.json) {
    log(JSON.stringify({ appId, deviceId, demo: demo.body, quota: quota.body }, null, 2));
  } else {
    log(`service   ${base}`);
    log(`app       ${appId}`);
    log(`device    ${deviceId}`);
    log('');
    log(opts.status ? demoStatusLine(demo) : demoActivationLine(demo));
    log(verdict(quota.body));
  }

  // A demo that could not be issued and a quota that still refuses are both
  // failures for the thing this was run to do, and a tester reading only the
  // exit code should see that.
  return quota.body.allowed ? 0 : 1;
}

function demoActivationLine(demo) {
  const body = demo.body || {};
  const until = body.expiresAt
    ? new Date(body.expiresAt * 1000).toISOString()
    : 'an expiry it did not report';
  if (body.success) {
    // Including the second run inside the window, which returns the first
    // run's expiry and a freshly signed token rather than more time.
    return `demo      live, ${body.planId || 'demo'} until ${until}`;
  }
  if (body.code === 'demo_already_used') {
    // Final, and the quota line below will refuse for the same reason. Said
    // plainly because it is the one state here nothing can undo.
    return `demo      spent — this machine's demo ran out ${until}`;
  }
  return `demo      not issued: the service answered ${demo.status}`
    + `${body.error ? `, ${body.error}` : ''}`;
}

function demoStatusLine(demo) {
  const body = demo.body || {};
  if (body.expiresAt) {
    return `demo      ${body.expired ? 'expired' : 'live'} until `
      + `${new Date(body.expiresAt * 1000).toISOString()}`;
  }
  return 'demo      none on this machine';
}

module.exports = {
  run, parseArgs, verdict, demoActivationLine, demoStatusLine, post, DEVICE_ID_RE,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
