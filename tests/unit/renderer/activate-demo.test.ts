/**
 * The tester's way into the cloud filler (`scripts/activate-demo.js`).
 *
 * What this script is for is a decision — is the cloud path open on this
 * machine, and if not, what should be done about it — and the decision is
 * what is tested here, with the service stubbed. A test that needed the
 * deployment would be testing the deployment.
 *
 * The reply shapes the stub returns are the service's own, copied from
 * `_handle_demo_activate`, `_handle_demo_status` and `_fill_reply` in
 * `serverless/verify-license/handler.py` in the sibling repository. That is
 * the seam worth being careful about: this script reads fields by name, and a
 * field that quietly changed name there would show up as a confident, wrong
 * summary rather than an error.
 */
import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const demo = require('../../../scripts/activate-demo.js');
const { APP_ID } = require('../../../electron/license-config.js');

const DEVICE = 'd'.repeat(64);
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

/** A quota reply, in the shape `_fill_reply` builds. */
function quotaReply(over: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      allowed: false,
      appId: APP_ID,
      limit: 100,
      used: 0,
      remaining: 100,
      periodEnds: '2026-11-01T00:00:00Z',
      overagePrice: null,
      reason: 'noLicense',
      endpoint: null,
      ...over,
    },
  };
}

/** A service that answers each route from a map, and records what it was asked. */
function service(replies: Record<string, unknown>) {
  const asked: { route: string; body: Record<string, unknown> }[] = [];
  const transport = vi.fn(async (_base: string, route: string, body: Record<string, unknown>) => {
    asked.push({ route, body });
    const reply = replies[route];
    if (!reply) throw new Error(`nothing stubbed for ${route}`);
    return reply;
  });
  return { transport, asked };
}

function captured() {
  const out: string[] = [];
  const errs: string[] = [];
  return {
    out, errs,
    io: { log: (line: string) => out.push(line), err: (line: string) => errs.push(line) },
    text: () => out.join('\n'),
  };
}

const LIVE_DEMO = {
  status: 200,
  body: {
    success: true, token: 'signed.by.the.service', appId: APP_ID, planId: 'demo',
    issuedAt: NOW, expiresAt: NOW + 30 * DAY, demoDurationDays: 30,
  },
};

describe('the options', () => {
  it('reads the ones the usage text promises', () => {
    const opts = demo.parseArgs([
      '--status', '--json', '--url', 'https://example.test/', '--app-id', 'shuyin',
      '--device-id', DEVICE, '--user-data', '/tmp/x',
    ]);
    expect(opts).toMatchObject({
      status: true, json: true, url: 'https://example.test/', appId: 'shuyin',
      deviceId: DEVICE, userData: '/tmp/x',
    });
  });

  it('refuses an unknown one rather than ignoring it', () => {
    expect(() => demo.parseArgs(['--activate-everything'])).toThrow(/unknown option/);
  });

  it('refuses a flag whose value was swallowed by the next flag', () => {
    expect(() => demo.parseArgs(['--url', '--json'])).toThrow(/needs a value/);
  });
});

describe('activating', () => {
  it('asks for the demo and then asks whether the cloud filler is open', async () => {
    const { transport, asked } = service({
      'demo/activate': LIVE_DEMO,
      'fill/quota': quotaReply({ allowed: true, remaining: 100, endpoint: { url: 'https://fill.test/inpaint', token: 't' } }),
    });
    const io = captured();
    const code = await demo.run(['--device-id', DEVICE], { transport, ...io.io });

    expect(asked.map((a) => a.route)).toEqual(['demo/activate', 'fill/quota']);
    // Every route is told which app and which machine; the demo belongs to the
    // pair, not to either one.
    expect(asked[0].body).toEqual({ appId: APP_ID, deviceId: DEVICE });
    expect(asked[1].body).toMatchObject({ appId: APP_ID, deviceId: DEVICE });
    expect(io.text()).toContain('the cloud filler is open');
    expect(code).toBe(0);
  });

  it('activates nothing under --status', async () => {
    const { transport, asked } = service({
      'demo/status': { status: 200, body: { used: true, expiresAt: NOW + DAY, expired: false } },
      'fill/quota': quotaReply({ allowed: true }),
    });
    await demo.run(['--status', '--device-id', DEVICE], { transport, ...captured().io });
    expect(asked.map((a) => a.route)).toEqual(['demo/status', 'fill/quota']);
  });

  it('exits non-zero when the cloud filler is still shut', async () => {
    // The whole point of running it. A tester reading only the exit code —
    // or a script wrapping this one — must not be told the path is open.
    const { transport } = service({ 'demo/activate': LIVE_DEMO, 'fill/quota': quotaReply() });
    const io = captured();
    expect(await demo.run(['--device-id', DEVICE], { transport, ...io.io })).toBe(1);
  });

  it('says a deployment that predates the change is the likely cause', async () => {
    // A live demo and a `noLicense` quota is exactly that: the demo route
    // worked, so the service is reachable and the record exists.
    const { transport } = service({ 'demo/activate': LIVE_DEMO, 'fill/quota': quotaReply() });
    const io = captured();
    await demo.run(['--device-id', DEVICE], { transport, ...io.io });
    expect(io.text()).toContain('predates the change');
  });

  it('prints both replies verbatim under --json', async () => {
    const { transport } = service({ 'demo/activate': LIVE_DEMO, 'fill/quota': quotaReply() });
    const io = captured();
    await demo.run(['--json', '--device-id', DEVICE], { transport, ...io.io });
    const parsed = JSON.parse(io.text());
    expect(parsed.demo).toEqual(LIVE_DEMO.body);
    expect(parsed.quota.reason).toBe('noLicense');
    expect(parsed.deviceId).toBe(DEVICE);
  });
});

describe('what the quota reply means', () => {
  it('counts what is left when the answer is yes', () => {
    const line = demo.verdict({ allowed: true, remaining: 97, limit: 100, periodEnds: '2026-11-01T00:00:00Z' });
    expect(line).toContain('97 of 100');
    expect(line).toContain('2026-11-01');
  });

  it('separates a spent allowance from a missing licence', () => {
    expect(demo.verdict({ allowed: false, reason: 'overLimit', used: 100, limit: 100, periodEnds: 'x' }))
      .toContain('spent its allowance');
    expect(demo.verdict({ allowed: false, reason: 'noLicense' })).toContain('no licence or demo');
  });

  it('names the switched-off deployment as configuration, not refusal', () => {
    expect(demo.verdict({ allowed: false, reason: 'unavailable' })).toContain('switched off');
  });

  it('reports a reason it does not know rather than smoothing it over', () => {
    // This script being older than the service is precisely when a guess
    // would send a tester to the wrong place.
    const line = demo.verdict({ allowed: false, reason: 'someFutureReason' });
    expect(line).toContain('does not know');
    expect(line).toContain('someFutureReason');
  });
});

describe('what the demo reply means', () => {
  it('reads a freshly issued demo', () => {
    expect(demo.demoActivationLine(LIVE_DEMO)).toMatch(/live, demo until 20/);
  });

  it('calls a spent demo spent, since nothing can undo it', () => {
    const spent = {
      status: 409,
      body: {
        success: false, code: 'demo_already_used',
        error: 'this device has already used its demo for this app',
        expiresAt: NOW - DAY,
      },
    };
    expect(demo.demoActivationLine(spent)).toContain('spent');
  });

  it('does not claim anything from a reply it cannot read', () => {
    const line = demo.demoActivationLine({ status: 500, body: { error: 'boom' } });
    expect(line).toContain('not issued');
    expect(line).toContain('500');
  });

  it('reads a machine that has never asked', () => {
    expect(demo.demoStatusLine({ status: 200, body: { used: false, expiresAt: null } }))
      .toContain('none on this machine');
  });

  it('distinguishes a live demo from an expired one', () => {
    expect(demo.demoStatusLine({ status: 200, body: { expiresAt: NOW + DAY, expired: false } })).toContain('live');
    expect(demo.demoStatusLine({ status: 200, body: { expiresAt: NOW - DAY, expired: true } })).toContain('expired');
  });
});

describe('refusing before the service is bothered', () => {
  it('will not put a signed token on the wire in the clear', async () => {
    // The reply carries a licence token. http would carry it to whoever is
    // listening, and the real `post` is what this test reaches.
    await expect(demo.post('http://licence.test/', 'demo/activate', {}))
      .rejects.toThrow(/must be https/);
  });

  it('refuses a device id the service would 400 on, and says which rule', async () => {
    const { transport } = service({});
    const io = captured();
    expect(await demo.run(['--device-id', 'too-short'], { transport, ...io.io })).toBe(2);
    expect(transport).not.toHaveBeenCalled();
    expect(io.errs.join('\n')).toContain('not a device id');
  });

  it('reports an unreachable service as that, and not as a refusal', async () => {
    const transport = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    const io = captured();
    expect(await demo.run(['--device-id', DEVICE], { transport, ...io.io })).toBe(1);
    expect(io.errs.join('\n')).toContain('could not reach');
  });
});
