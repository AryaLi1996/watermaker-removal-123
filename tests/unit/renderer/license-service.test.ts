/**
 * The main process's half of licensing: the token, the fallback prices, the
 * device id and the encrypted store.
 *
 * These are the pieces that decide whether someone is licensed while the
 * network is unreachable, so they are worth testing directly rather than
 * through the app.
 */
import { createRequire } from 'module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

describe('what the build bakes in', () => {
  /**
   * The main process is not bundled — `files: ['electron/**']` copies it into
   * the asar as-is — so `process.env.LICENSE_SIGNING_SECRET` inside
   * license-config.js is read on the end user's machine at launch, where it
   * is never set. Until scripts/write-build-config.js existed there was no
   * path from a release job to a packaged build at all, and every shipped
   * build verified licences with the public default from this repository.
   */
  const CONFIG_PATH = require.resolve('../../../electron/license-config.js');
  const BUILD_CONFIG = path.join(__dirname, '../../../electron/build-config.json');

  /** Load license-config.js afresh, with `contents` as the baked-in file (or
   *  none at all when null), and put the tree back afterwards. */
  function withBuildConfig<T>(contents: Record<string, string> | null, body: (c: any) => T): T {
    const had = existsSync(BUILD_CONFIG);
    const previous = had ? readFileSync(BUILD_CONFIG, 'utf8') : null;
    try {
      if (contents === null) { if (had) rmSync(BUILD_CONFIG); }
      else writeFileSync(BUILD_CONFIG, JSON.stringify(contents));
      delete require.cache[CONFIG_PATH];
      // build-config.json is require()d by license-config.js, so its own
      // cache entry has to go too or the previous test's file wins.
      try { delete require.cache[require.resolve('../../../electron/build-config.json')]; } catch { /* absent */ }
      return body(require(CONFIG_PATH));
    } finally {
      if (previous === null) { try { rmSync(BUILD_CONFIG); } catch { /* never existed */ } }
      else writeFileSync(BUILD_CONFIG, previous);
      delete require.cache[CONFIG_PATH];
    }
  }

  it('falls back to the public defaults when the build baked nothing', () => {
    withBuildConfig(null, (c) => {
      // Exactly today's behaviour for an unconfigured build, which is what
      // keeps `npm run dev` and a developer's own `npm run dist` working.
      expect(c.usingDefaultSigningSecret).toBe(true);
      expect(c.rotatingSigningSecret).toBe(false);
      expect(c.APP_ID).toBe('shuyin');
    });
  });

  it('reads the secrets the build baked in', () => {
    withBuildConfig(
      { LICENSE_SIGNING_SECRET: 'a-real-one', PREVIOUS_LICENSE_SIGNING_SECRET: 'the-outgoing-one' },
      (c) => {
        expect(c.LICENSE_CONFIG.signingSecret).toBe('a-real-one');
        expect(c.LICENSE_CONFIG.previousSigningSecret).toBe('the-outgoing-one');
        // The two flags the startup warnings read must follow, or a packaged
        // build would keep claiming it is on the public default.
        expect(c.usingDefaultSigningSecret).toBe(false);
        expect(c.rotatingSigningSecret).toBe(true);
      },
    );
  });

  it('lets the environment override a baked value', () => {
    // So a packaged build can be pointed at a test deployment without being
    // rebuilt, and so `npm run dev` keeps behaving as documented.
    const previous = process.env.LICENSE_URL;
    process.env.LICENSE_URL = 'https://example.invalid/test/';
    try {
      withBuildConfig({ LICENSE_URL: 'https://baked.invalid/' }, (c) => {
        expect(c.LICENSE_CONFIG.verificationUrl).toBe('https://example.invalid/test/');
      });
    } finally {
      if (previous === undefined) delete process.env.LICENSE_URL;
      else process.env.LICENSE_URL = previous;
    }
  });

  it('survives a malformed baked file rather than refusing to start', () => {
    const had = existsSync(BUILD_CONFIG);
    const previous = had ? readFileSync(BUILD_CONFIG, 'utf8') : null;
    try {
      writeFileSync(BUILD_CONFIG, '{ not json');
      delete require.cache[CONFIG_PATH];
      // A broken install is a licence question, not a reason to fail launch.
      const c = require(CONFIG_PATH);
      expect(c.usingDefaultSigningSecret).toBe(true);
    } finally {
      if (previous === null) { try { rmSync(BUILD_CONFIG); } catch { /* none */ } }
      else writeFileSync(BUILD_CONFIG, previous);
      delete require.cache[CONFIG_PATH];
    }
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
  /**
   * The whole job is surviving a reinstall: a machine that has already spent
   * its trial must derive the same id afterwards, or the service quite
   * correctly hands it another one.
   *
   * `deps` stubs the OS machine-id probes, so these exercise the derivation
   * rather than whatever the machine running the suite happens to report.
   */
  const NO_MACHINE_ID = {
    readFileSync: () => { throw new Error('ENOENT'); },
    execFileSync: () => { throw new Error('ENOENT'); },
  };

  /** A burned-in address: bit 1 of the first octet clear. */
  const BURNED_IN = '3c:22:fb:11:22:33';

  const withMacs = (macs: string[], names: string[] = []) => ({
    networkInterfaces: () => Object.fromEntries(
      macs.map((mac, i) => [names[i] ?? `eth${i}`, [{ mac, internal: false }]]),
    ),
    platform: () => 'linux',
    arch: () => 'x64',
  });

  const idFrom = (os: unknown, deps: unknown = NO_MACHINE_ID) => {
    deviceId.resetCache();
    rmSync(path.join(dir, '.device_id'), { force: true });
    return deviceId.getDeviceId(dir, os, deps);
  };

  it('derives the same id from the same hardware, so a reinstall is not a new trial', () => {
    const first = idFrom(withMacs([BURNED_IN]));
    expect(idFrom(withMacs([BURNED_IN]))).toBe(first);
  });

  it('prefers the operating system\'s machine id over any adapter', () => {
    // The signal that actually survives: written when the OS was installed
    // and untouched by installing or removing this app.
    const machine = { ...NO_MACHINE_ID, readFileSync: () => 'e3b0c44298fc1c149afbf4c8\n' };
    const withNic = idFrom(withMacs([BURNED_IN]), machine);
    // Same machine id, completely different adapters — still the same device.
    const noNic = idFrom({ networkInterfaces: () => ({}), platform: () => 'linux', arch: () => 'x64' }, machine);
    expect(noNic).toBe(withNic);
    // And it is not the MAC-derived id, so the two signals cannot collide.
    expect(withNic).not.toBe(idFrom(withMacs([BURNED_IN])));
  });

  it('ignores adapters that come and go, which is what broke the reinstall', () => {
    // Before this, the id was every non-loopback MAC present at that moment.
    // Starting Docker, joining a VPN or docking a laptop changed the set, and
    // the reinstall that followed looked like a brand-new machine.
    const bare = idFrom(withMacs([BURNED_IN]));
    const cluttered = idFrom(withMacs(
      [BURNED_IN, '02:42:ac:11:00:02', '00:50:56:c0:00:08', '3a:9f:1b:44:55:66'],
      ['eth0', 'docker0', 'vmnet1', 'utun3'],
    ));
    expect(cluttered).toBe(bare);
  });

  it('ignores a randomised Wi-Fi address', () => {
    // macOS and Windows hand out a different private MAC per network by
    // default. Its locally-administered bit is set, which is how it is told
    // apart from a real NIC without having to know the interface name.
    expect(deviceId.isLocallyAdministered('aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(deviceId.isLocallyAdministered(BURNED_IN)).toBe(false);

    const wifiA = withMacs([BURNED_IN, 'aa:bb:cc:dd:ee:ff'], ['eth0', 'en0']);
    const wifiB = withMacs([BURNED_IN, '9e:11:22:33:44:55'], ['eth0', 'en0']);
    expect(idFrom(wifiB)).toBe(idFrom(wifiA));
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

  it('still produces a usable id when nothing stable is available', () => {
    const os = { networkInterfaces: () => ({}), platform: () => 'linux', arch: () => 'x64' };
    // A random id will not survive a reinstall, which the service's own docs
    // accept — refusing to start a trial would be worse.
    expect(idFrom(os)).toMatch(/^[A-Za-z0-9-]{16,128}$/);
  });

  it('keeps whatever was stored, so an id never changes under the user', () => {
    // What makes the new derivation safe to ship: every install that already
    // has a .device_id keeps it, so nobody's trial resets and nobody is
    // handed a second one.
    deviceId.resetCache();
    writeFileSync(path.join(dir, '.device_id'), 'previously-stored-id-0123456789');
    expect(deviceId.getDeviceId(dir, withMacs([BURNED_IN]), NO_MACHINE_ID))
      .toBe('previously-stored-id-0123456789');
  });

  it('reads the machine id each platform actually keeps', () => {
    const calls: string[][] = [];
    const deps = {
      readFileSync: (f: string) => { calls.push(['read', f]); throw new Error('ENOENT'); },
      execFileSync: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd.endsWith('ioreg')) return '  "IOPlatformUUID" = "F1E2D3C4-B5A6"\n';
        return 'MachineGuid    REG_SZ    9a8b7c6d-5e4f\r\n';
      },
    };
    expect(deviceId.readMachineId('darwin', deps)).toBe('F1E2D3C4-B5A6');
    expect(deviceId.readMachineId('win32', deps)).toBe('9a8b7c6d-5e4f');
    deviceId.readMachineId('linux', deps);
    expect(calls.some((c) => c[1] === '/etc/machine-id')).toBe(true);
    // A 32-bit build must not be redirected to the WOW6432 view, where
    // MachineGuid is a different value.
    expect(calls.some((c) => c.includes('/reg:64'))).toBe(true);
  });

  it('treats an unreadable probe as "no machine id" rather than failing', () => {
    expect(deviceId.readMachineId('linux', NO_MACHINE_ID)).toBeNull();
    expect(deviceId.readMachineId('darwin', NO_MACHINE_ID)).toBeNull();
    expect(deviceId.readMachineId('sunos', NO_MACHINE_ID)).toBeNull();
  });

  it('produces a shape the service accepts', () => {
    // _DEVICE_ID_RE on the service side: ^[A-Za-z0-9_-]{16,128}$
    expect(idFrom(withMacs([BURNED_IN]))).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
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
