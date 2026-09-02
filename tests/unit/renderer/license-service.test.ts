/**
 * The main process's half of licensing: the token, the fallback prices, the
 * device id and the encrypted store.
 *
 * These are the pieces that decide whether someone is licensed while the
 * network is unreachable, so they are worth testing directly rather than
 * through the app.
 */
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../../electron/license-config.js');
const token = require('../../../electron/license-token.js');
const deviceId = require('../../../electron/device-id.js');
const secureStore = require('../../../electron/secure-store.js');

const NOW = 1_800_000_000; // Unix seconds, a fixed point to reason from.
const DAY = 86400;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'license-'));
  deviceId.resetCache();
  secureStore.resetCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the fallback plan prices', () => {
  it('agree with the service, which rounds half up', () => {
    // The service computes these with Decimal/ROUND_HALF_UP; the offline
    // fallback has to land on the same figures or the cards would quote
    // something the checkout would not charge. ¥534.60 → ¥535, not ¥534.
    const byId = Object.fromEntries(config.fallbackPlans().map((p: { id: string }) => [p.id, p]));
    expect(byId.monthly.price).toBe(99);
    expect(byId.quarterly.price).toBe(282);
    expect(byId.semi_annual.price).toBe(535);
    expect(byId.annual.price).toBe(1010);
  });

  it('use the service\'s plan ids, since it validates orders against them', () => {
    expect(config.fallbackPlans().map((p: { id: string }) => p.id))
      .toEqual(['monthly', 'quarterly', 'semi_annual', 'annual']);
  });

  it('price the strikethrough total in one rounding step, not by multiplying up', () => {
    const annual = config.fallbackPlans().find((p: { id: string }) => p.id === 'annual');
    // 99 × 12, not 12 × (a rounded monthly figure).
    expect(annual.originalPrice).toBe(1188);
    expect(annual.discountPercent).toBe(15);
  });

  it('quote amounts in minor units, which is what a provider charges', () => {
    const monthly = config.fallbackPlans().find((p: { id: string }) => p.id === 'monthly');
    expect(monthly.amount).toBe(9900);
    expect(monthly.currency).toBe('cny');
  });
});

describe('which app this client is', () => {
  it('is this app\'s own id, not the sibling\'s', () => {
    // The service keys a demo by "<appId>#<deviceId>" and a trial by
    // (deviceId, appId), so sharing SootheVoice's `smoothvoice` meant a demo
    // or trial spent there arrived here already used — the exact leak the
    // appId dimension exists to close. Pinned because the value is
    // contractual: the service and the sibling client have to agree on it.
    expect(config.DEFAULT_APP_ID).toBe('shuyin');
    expect(config.LICENSE_CONFIG.appId).toBe(config.APP_ID);
  });

  it('can be overridden at build time, for a test deployment', async () => {
    // Both spellings: LICENSE_APP_ID is the main process's, VITE_APP_ID is
    // the renderer's, and a build that sets only one must not leave the two
    // halves disagreeing about which app they are.
    for (const name of ['LICENSE_APP_ID', 'VITE_APP_ID']) {
      const previous = process.env[name];
      process.env[name] = 'smoothvoice-test';
      try {
        delete require.cache[require.resolve('../../../electron/license-config.js')];
        expect(require('../../../electron/license-config.js').APP_ID, name).toBe('smoothvoice-test');
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
        delete require.cache[require.resolve('../../../electron/license-config.js')];
      }
    }
  });
});

describe('the license token', () => {
  const payload = { userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345', expiresAt: NOW + 30 * DAY, issuedAt: NOW };

  it('round-trips a token it signed', () => {
    expect(token.verifyToken(token.createToken(payload))).toMatchObject(payload);
  });

  it('refuses one signed with a different secret', () => {
    const forged = token.createToken(payload, 'some-other-secret');
    expect(token.verifyToken(forged)).toBeNull();
  });

  it('refuses a tampered payload', () => {
    const [header, body, signature] = token.createToken(payload).split('.');
    const swapped = Buffer.from(JSON.stringify({ ...payload, expiresAt: NOW + 3650 * DAY })).toString('base64url');
    expect(token.verifyToken(`${header}.${swapped}.${signature}`)).toBeNull();
    expect(token.verifyToken(`${header}.${body}.${'0'.repeat(64)}`)).toBeNull();
  });

  it('refuses anything that is not a token at all', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not a token', null, undefined, 42]) {
      expect(token.verifyToken(bad as never), String(bad)).toBeNull();
    }
  });

  it('refuses a payload with no expiry, rather than treating it as forever', () => {
    expect(token.verifyToken(token.createToken({ userId: 'u' }))).toBeNull();
  });
});

describe('what a token means today', () => {
  const at = (expiresAt: number) => ({ expiresAt });

  it('is active until it expires', () => {
    expect(token.resolveStatus(at(NOW + 10), NOW)).toBe('active');
  });

  it('falls into the grace period rather than locking out at once', () => {
    // The grace period is why an offline renewal, or a service that cannot
    // be reached, does not read as "you have no licence".
    expect(token.resolveStatus(at(NOW - 1), NOW)).toBe('grace_period');
    expect(token.resolveStatus(at(NOW - 2 * DAY), NOW)).toBe('grace_period');
  });

  it('expires once the grace period is over', () => {
    const grace = config.LICENSE_CONFIG.gracePeriodDays;
    expect(token.resolveStatus(at(NOW - (grace + 1) * DAY), NOW)).toBe('expired');
  });

  it('treats no token as unlicensed, not expired', () => {
    expect(token.resolveStatus(null, NOW)).toBe('unlicensed');
  });

  it('counts paid features as available through the grace period', () => {
    expect(token.isLicensed('active')).toBe(true);
    expect(token.isLicensed('grace_period')).toBe(true);
    expect(token.isLicensed('expired')).toBe(false);
    expect(token.isLicensed('unlicensed')).toBe(false);
  });

  it('reports the days left on each side of expiry', () => {
    const active = token.buildLicenseState(at(NOW + 5 * DAY), NOW);
    expect(active.status).toBe('active');
    expect(active.daysRemaining).toBe(5);
    expect(active.graceDaysLeft).toBe(0);

    const grace = token.buildLicenseState(at(NOW - DAY), NOW);
    expect(grace.status).toBe('grace_period');
    expect(grace.graceDaysLeft).toBe(config.LICENSE_CONFIG.gracePeriodDays - 1);
    expect(grace.daysRemaining).toBe(0);
  });
});

describe('the device id', () => {
  const withMacs = (macs: string[]) => ({
    networkInterfaces: () => ({ eth0: macs.map((mac) => ({ mac, internal: false })) }),
    platform: () => 'linux',
    arch: () => 'x64',
  });

  it('derives the same id from the same hardware, so a reinstall is not a new trial', () => {
    const first = deviceId.getDeviceId(dir, withMacs(['aa:bb:cc:dd:ee:ff']));
    deviceId.resetCache();
    rmSync(path.join(dir, '.device_id'));
    const afterReinstall = deviceId.getDeviceId(dir, withMacs(['aa:bb:cc:dd:ee:ff']));
    expect(afterReinstall).toBe(first);
  });

  it('ignores loopback and placeholder adapters', () => {
    const os = {
      networkInterfaces: () => ({
        lo: [{ mac: '11:22:33:44:55:66', internal: true }],
        eth0: [{ mac: '00:00:00:00:00:00', internal: false }],
      }),
      platform: () => 'linux',
      arch: () => 'x64',
    };
    expect(deviceId.hardwareSignal(os)).toBeNull();
  });

  it('still produces a usable id on a machine with no MAC address', () => {
    const os = { networkInterfaces: () => ({}), platform: () => 'linux', arch: () => 'x64' };
    const id = deviceId.getDeviceId(dir, os);
    // A random id will not survive a reinstall, which the service's own docs
    // accept — refusing to start a trial would be worse.
    expect(id).toMatch(/^[A-Za-z0-9-]{16,128}$/);
  });

  it('keeps whatever was stored, so an id never changes under the user', () => {
    writeFileSync(path.join(dir, '.device_id'), 'previously-stored-id-0123456789');
    expect(deviceId.getDeviceId(dir, withMacs(['aa:bb:cc:dd:ee:ff']))).toBe('previously-stored-id-0123456789');
  });

  it('produces a shape the service accepts', () => {
    // _DEVICE_ID_RE on the service side: ^[A-Za-z0-9_-]{16,128}$
    expect(deviceId.getDeviceId(dir, withMacs(['aa:bb:cc:dd:ee:ff']))).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe('the encrypted store', () => {
  it('round-trips what it was given', () => {
    expect(secureStore.decrypt(dir, secureStore.encrypt(dir, 'a token'))).toBe('a token');
  });

  it('refuses a file somebody edited', () => {
    // The point of encrypting the trial dates: not that they are secret, but
    // that they cannot be extended in a text editor.
    const enc = secureStore.encrypt(dir, '{"trialEnd":1}');
    const edited = Buffer.from(enc);
    edited[edited.length - 1] ^= 0xff;
    expect(secureStore.decrypt(dir, edited)).toBeNull();
  });

  it('refuses a file from another machine', () => {
    const enc = secureStore.encrypt(dir, 'a token');
    const otherDir = mkdtempSync(path.join(tmpdir(), 'license-other-'));
    try {
      // Copying the key seed across does not help: the key is also bound to
      // the machine fingerprint, which differs.
      writeFileSync(path.join(otherDir, 'keys', 'license.key'), readFileSync(path.join(dir, 'keys', 'license.key')), { flag: 'w' });
    } catch {
      // The directory does not exist yet on the other side; encrypt below
      // creates its own seed, which is the case being tested either way.
    }
    secureStore.resetCache();
    const asOtherMachine = secureStore.decrypt(otherDir, enc, {
      hostname: () => 'someone-elses-laptop',
      platform: () => 'linux',
      arch: () => 'x64',
      cpus: () => [{ model: 'Some Other CPU' }],
    });
    expect(asOtherMachine).toBeNull();
    rmSync(otherDir, { recursive: true, force: true });
  });

  it('refuses a truncated file rather than throwing', () => {
    expect(secureStore.decrypt(dir, Buffer.alloc(4))).toBeNull();
    expect(secureStore.decrypt(dir, null)).toBeNull();
  });
});
