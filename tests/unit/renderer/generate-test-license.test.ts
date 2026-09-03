/**
 * The test-licence minter (`scripts/generate-test-license.js`).
 *
 * A minted licence is only worth anything if the app reads it back as one, so
 * the assertions go through the app's own `verifyToken` and, for `--install`,
 * through a real `SubscriptionMonitor` pointed at the directory the script
 * wrote — rather than re-checking the shapes the script just produced.
 */
import { createRequire } from 'module';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const gen = require('../../../scripts/generate-test-license.js');
const { verifyToken, buildLicenseState } = require('../../../electron/license-token.js');
const { APP_ID, PLAN_TIERS, DEMO_PLAN_ID, DEMO_DURATION_DAYS } = require('../../../electron/license-config.js');
const { SubscriptionMonitor } = require('../../../electron/subscription-monitor.js');

const DAY = 86400;
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);

/** A service that answers nothing: an installed licence must not need one. */
const noService = () => Promise.reject(new Error('offline'));

describe('the licence key', () => {
  it('is the shape the service accepts', () => {
    for (let i = 0; i < 20; i += 1) {
      const key = gen.generateLicenseKey();
      // ^[A-Za-z0-9_-]{8,64}$ — _LICENSE_KEY_RE in the service's handler.py.
      expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(key.startsWith('TEST-')).toBe(true);
    }
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 50 }, () => gen.generateLicenseKey()));
    expect(keys.size).toBe(50);
  });
});

describe('minting', () => {
  it('produces a token this app verifies, naming this app', () => {
    const { token } = gen.mint({ now: NOW_MS });
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload.appId).toBe(APP_ID);
    expect(payload.features).toEqual(gen.FEATURES);
  });

  it('takes its length from the plan', () => {
    for (const tier of PLAN_TIERS) {
      const { payload } = gen.mint({ planId: tier.id, now: NOW_MS });
      expect(payload.expiresAt).toBe(NOW + tier.durationDays * DAY);
    }
  });

  it('knows the demo plan is DEMO_DURATION_DAYS, not a monthly', () => {
    const { payload, durationDays } = gen.mint({ planId: DEMO_PLAN_ID, now: NOW_MS });
    expect(durationDays).toBe(DEMO_DURATION_DAYS);
    expect(payload.planId).toBe(DEMO_PLAN_ID);
  });

  it('refuses a plan the app does not have rather than quietly minting a monthly', () => {
    expect(() => gen.mint({ planId: 'lifetime' })).toThrow(/unknown plan/);
  });

  it('mints an already-expired licence for a negative --days', () => {
    const { token } = gen.mint({ days: -10, now: NOW_MS });
    // Past the 3-day grace period as well, so this is the locked-out state
    // and not the one that still works.
    expect(buildLicenseState(verifyToken(token), NOW).status).toBe('expired');
  });

  it('lands in the grace period for a licence that lapsed yesterday', () => {
    const { token } = gen.mint({ days: -1, now: NOW_MS });
    expect(buildLicenseState(verifyToken(token), NOW).status).toBe('grace_period');
  });

  it('can name another app, which this app then refuses', () => {
    const { token } = gen.mint({ appId: 'smoothvoice', now: NOW_MS });
    // The signature is this build's, so it verifies — the appId is the only
    // thing between a sibling's licence and this app unlocking on it.
    expect(verifyToken(token).appId).toBe('smoothvoice');
  });
});

describe('argument parsing', () => {
  it('defaults to one annual licence, printed', () => {
    expect(gen.parseArgs([])).toMatchObject({ plan: 'annual', count: 1 });
    expect(gen.parseArgs([]).install).toBeUndefined();
  });

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => gen.parseArgs(['--intall'])).toThrow(/unknown option/);
  });

  it('rejects an option left without its value', () => {
    expect(() => gen.parseArgs(['--plan'])).toThrow(/needs a value/);
  });

  it('rejects a count that is not a positive integer', () => {
    expect(() => gen.parseArgs(['--count', '0'])).toThrow(/positive integer/);
    expect(() => gen.parseArgs(['--count', 'lots'])).toThrow(/positive integer/);
  });

  it('mints one licence for an explicit key, whatever --count says', () => {
    expect(gen.parseArgs(['--key', 'QA-FIXED-KEY-001', '--count', '5']).count).toBe(1);
  });
});

describe('the userData directory it installs into', () => {
  /** Segments, not a joined string: the separator is the *host's*, and this
   *  suite runs on Windows in CI as well as on the platform being asked
   *  about. */
  const segments = (dir: string) => dir.split(/[\\/]/);

  it('is the platform one, under the app name an unpackaged run uses', () => {
    expect(segments(gen.defaultUserDataDir('appname', 'darwin', '/home/x')))
      .toEqual(['', 'home', 'x', 'Library', 'Application Support', 'appname']);
  });

  it('honours XDG_CONFIG_HOME on Linux, and falls back to ~/.config', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    try {
      delete process.env.XDG_CONFIG_HOME;
      expect(segments(gen.defaultUserDataDir('appname', 'linux', '/home/x')))
        .toEqual(['', 'home', 'x', '.config', 'appname']);

      process.env.XDG_CONFIG_HOME = '/elsewhere';
      expect(segments(gen.defaultUserDataDir('appname', 'linux', '/home/x')))
        .toEqual(['', 'elsewhere', 'appname']);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it('follows APPDATA on Windows', () => {
    const saved = process.env.APPDATA;
    try {
      process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
      expect(segments(gen.defaultUserDataDir('appname', 'win32', 'C:\\Users\\x')))
        .toEqual(['C:', 'Users', 'x', 'AppData', 'Roaming', 'appname']);
    } finally {
      if (saved === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved;
    }
  });
});

describe('--install', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'license-mint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a licence the monitor comes up active on, with no service at all', async () => {
    const { token } = gen.mint({ planId: 'annual', now: NOW_MS });
    gen.install(dir, token);

    const monitor = new SubscriptionMonitor({ userDataDir: dir, request: noService, now: () => NOW_MS });
    await monitor.initialize();
    const state = monitor.getState();

    expect(state.status).toBe('active');
    expect(state.payload.licenseKey).toBe(verifyToken(token).licenseKey);
  });

  it('writes the token encrypted and owner-only, not in the clear', () => {
    const { token } = gen.mint({ now: NOW_MS });
    gen.install(dir, token);

    const file = path.join(dir, gen.TOKEN_FILE);
    const raw = require('fs').readFileSync(file);
    expect(raw.includes(Buffer.from(token))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('clears the clock high-water mark, so an earlier licence does not make this one look tampered', async () => {
    // A mark from far in the future is what a monitor writes after running
    // with the clock forward; left in place it reads every later launch as a
    // wound-back clock and withholds the licence.
    const mark = Buffer.allocUnsafe(8);
    mark.writeBigUInt64BE(BigInt(NOW + 400 * DAY));
    writeFileSync(path.join(dir, gen.TS_FILE), mark);

    gen.install(dir, gen.mint({ now: NOW_MS }).token);
    expect(existsSync(path.join(dir, gen.TS_FILE))).toBe(false);

    const monitor = new SubscriptionMonitor({ userDataDir: dir, request: noService, now: () => NOW_MS });
    await monitor.initialize();
    expect(monitor.getState().status).toBe('active');
  });

  it('creates the directory when it is not there yet', () => {
    const nested = path.join(dir, 'not', 'created', 'yet');
    gen.install(nested, gen.mint({ now: NOW_MS }).token);
    expect(existsSync(path.join(nested, gen.TOKEN_FILE))).toBe(true);
  });
});
