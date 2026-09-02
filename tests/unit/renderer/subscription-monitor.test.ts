/**
 * The subscription state machine, driven against a stub of the license
 * service.
 *
 * The interesting cases are the ones a running app makes hard to reach: a
 * service that cannot be answered, a trial this device already used, a clock
 * wound backwards, an order that settles while the app watches.
 */
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { SubscriptionMonitor, APP_MISMATCH, EXPIRED, looksLikeToken } = require('../../../electron/subscription-monitor.js');
const { APP_ID, DEMO_CODES, DEMO_DURATION_DAYS, DEMO_PLAN_ID } = require('../../../electron/license-config.js');
const { DEMO_ALREADY_USED, DEMO_CODE_INVALID, DEMO_FILE, isDemoCode } = require('../../../electron/demo-license.js');
const token = require('../../../electron/license-token.js');
const secureStore = require('../../../electron/secure-store.js');
const deviceIdModule = require('../../../electron/device-id.js');

const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const DAY = 86400;

type Route = string;
/** A stub service: routes it answers, and what it was asked. */
function stubService(routes: Record<Route, unknown | ((body?: unknown) => unknown)>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, routePath: string, body?: unknown) => {
    calls.push({ method, path: routePath, body });
    const key = routePath.split('?')[0];
    if (!(key in routes)) throw new Error(`unreachable: ${routePath}`);
    const answer = routes[key];
    return typeof answer === 'function' ? (answer as (b?: unknown) => unknown)(body) : answer;
  });
  return { request, calls };
}

/** A service nothing can reach — every call rejects, as offline does. */
function offlineService() {
  return vi.fn(async () => { throw new Error('ENOTFOUND'); });
}

let dir: string;

function makeMonitor(request: unknown, nowMs = NOW_MS) {
  return new SubscriptionMonitor({ userDataDir: dir, request, now: () => nowMs });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'monitor-'));
  deviceIdModule.resetCache();
  secureStore.resetCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the trial', () => {
  it('takes the service\'s answer for a device that already used one', async () => {
    // The whole reason the trial lives on the server: this machine cannot be
    // given a second one by reinstalling.
    const { request } = stubService({
      'trial/status': { trialUsed: true, trialStart: NOW - 2 * DAY, trialEnd: NOW + DAY, trialDurationDays: 3 },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    const { trial } = monitor.getState();
    expect(trial.used).toBe(true);
    expect(trial.active).toBe(true);
    expect(trial.source).toBe('server');
    expect(trial.msRemaining).toBe(DAY * 1000);
  });

  it('activates one for a device the service has never seen', async () => {
    const { request, calls } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null, trialDurationDays: 3 },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY, trialDurationDays: 3 },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect(calls.map((c) => c.path.split('?')[0])).toContain('trial/activate');
    expect(monitor.getState().trial.active).toBe(true);
    expect(monitor.getState().trial.durationDays).toBe(3);
  });

  it('reports one the service says has run out', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: true, trialStart: NOW - 10 * DAY, trialEnd: NOW - 7 * DAY, trialDurationDays: 3 },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect(monitor.getState().trial.used).toBe(true);
    expect(monitor.getState().trial.active).toBe(false);
    expect(monitor.getState().trial.msRemaining).toBe(0);
  });

  it('starts a local trial when the first launch is also offline', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    const { trial } = monitor.getState();
    expect(trial.active).toBe(true);
    expect(trial.source).toBe('local');
    expect(trial.msRemaining).toBe(3 * DAY * 1000);
  });

  it('reuses the local record on a later offline launch rather than granting another', async () => {
    await makeMonitor(offlineService()).initialize();
    secureStore.resetCache();

    const later = makeMonitor(offlineService(), NOW_MS + 2 * DAY * 1000);
    await later.initialize();
    // One day left of the original three — not a fresh three.
    expect(later.getState().trial.msRemaining).toBe(DAY * 1000);
  });

  it('prefers the service\'s dates over the local copy once it can reach it', async () => {
    await makeMonitor(offlineService()).initialize();
    secureStore.resetCache();

    const { request } = stubService({
      'trial/status': { trialUsed: true, trialStart: NOW - 5 * DAY, trialEnd: NOW - 2 * DAY, trialDurationDays: 3 },
    });
    const online = makeMonitor(request);
    await online.initialize();

    // The service knows this device's trial ended; the local record said
    // otherwise, and loses.
    expect(online.getState().trial.active).toBe(false);
    expect(online.getState().trial.source).toBe('server');
  });

  it('caches the service\'s trial length instead of trusting its own constant', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null, trialDurationDays: 7 },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 7 * DAY, trialDurationDays: 7 },
    });
    await makeMonitor(request).initialize();
    secureStore.resetCache();

    const offline = makeMonitor(offlineService());
    await offline.initialize();
    expect(offline.getState().trial.durationDays).toBe(7);
  });
});

describe('a stored license', () => {
  const licenseToken = (expiresAt: number) => token.createToken({
    userId: 'u1', planId: 'annual', licenseKey: 'KEY12345', expiresAt, issuedAt: NOW,
  });

  function storeToken(value: string) {
    writeFileSync(path.join(dir, 'license.enc'), secureStore.encrypt(dir, value));
  }

  it('is active when it has not expired', async () => {
    storeToken(licenseToken(NOW + 30 * DAY));
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.getState().status).toBe('active');
    expect(monitor.getState().payload.planId).toBe('annual');
    expect(monitor.isLicensedNow()).toBe(true);
  });

  it('keeps working through the grace period with no network at all', async () => {
    storeToken(licenseToken(NOW - DAY));
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.getState().status).toBe('grace_period');
    expect(monitor.isLicensedNow()).toBe(true);
  });

  it('stops once the grace period is over', async () => {
    storeToken(licenseToken(NOW - 30 * DAY));
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.getState().status).toBe('expired');
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('ignores a token signed by someone else', async () => {
    storeToken(token.createToken({ userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: NOW + DAY }, 'forged'));
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.getState().status).toBe('unlicensed');
  });

  it('withholds access when the clock has been wound back', async () => {
    storeToken(licenseToken(NOW + 30 * DAY));
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    expect(monitor.getState().status).toBe('active');

    // Same machine, same token, a year earlier on the clock.
    secureStore.resetCache();
    const rewound = makeMonitor(offlineService(), NOW_MS - 365 * DAY * 1000);
    await rewound.initialize();
    expect(rewound.getState().status).toBe('expired');
  });

  it('tolerates a small backwards step, which is NTP rather than tampering', async () => {
    storeToken(licenseToken(NOW + 30 * DAY));
    await makeMonitor(offlineService()).initialize();

    secureStore.resetCache();
    const nudged = makeMonitor(offlineService(), NOW_MS - 30_000);
    await nudged.initialize();
    expect(nudged.getState().status).toBe('active');
  });
});

describe('buying a plan', () => {
  const paidToken = token.createToken({
    userId: 'u1', planId: 'quarterly', licenseKey: 'KEY12345', expiresAt: NOW + 90 * DAY, issuedAt: NOW,
  });

  it('creates an order against the anonymous user id', async () => {
    const { request, calls } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      'create-order': { orderId: 'o-1', presentAs: 'embedded', redirectUrl: 'https://pay.example/o-1' },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    const order = await monitor.createOrder('quarterly', 'wechat_pay');
    expect(order.orderId).toBe('o-1');

    const created = calls.find((c) => c.path === 'create-order');
    expect(created?.body).toMatchObject({ planId: 'quarterly', method: 'wechat_pay' });
    // The id is generated locally and reused, so a person's orders and
    // licence can be found again without an account.
    expect((created?.body as { userId: string }).userId).toBe(monitor.getUserId());
  });

  it('refuses a payment method the service does not have', async () => {
    const monitor = makeMonitor(offlineService());
    expect((await monitor.createOrder('monthly', 'bitcoin')).error).toMatch(/unknown payment method/);
  });

  it('adopts the licence the moment the order reports paid', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      'order-status': { status: 'paid', token: paidToken },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();
    expect(monitor.isLicensedNow()).toBe(false);

    const result = await monitor.orderStatus('o-1');
    expect(result.licensed).toBe(true);
    expect(monitor.getState().status).toBe('active');
    expect(monitor.getState().payload.planId).toBe('quarterly');
  });

  it('survives a restart, because the token was stored', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      'order-status': { status: 'paid', token: paidToken },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();
    await monitor.orderStatus('o-1');

    secureStore.resetCache();
    const restarted = makeMonitor(offlineService());
    await restarted.initialize();
    expect(restarted.getState().status).toBe('active');
  });

  it('stays unlicensed while the order is still pending', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      'order-status': { status: 'pending' },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect((await monitor.orderStatus('o-1')).status).toBe('pending');
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('refuses a token the service could not have signed', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      'order-status': {
        status: 'paid',
        token: token.createToken({ userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: NOW + DAY }, 'forged'),
      },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect((await monitor.orderStatus('o-1')).licensed).toBe(false);
    expect(monitor.isLicensedNow()).toBe(false);
  });
});

describe('which app the licence is for', () => {
  /**
   * The service holds one set of tables for every app on the account. Without
   * an appId on the request a trial spent in the sibling app arrives here
   * already used, and a plan bought there unlocks this one — which is exactly
   * what the shared-service note in docs/LICENSE_SERVICE.md listed as the
   * cost. These tests pin the dimension onto every call that decides an
   * entitlement.
   */
  const routes = {
    'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
    'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
    'create-order': { orderId: 'o-1', presentAs: 'external', redirectUrl: 'https://pay.example/o-1' },
    'order-status': { status: 'pending' },
    'payment-history': { orders: [] },
    plans: { plans: [{ id: 'monthly', price: 99, currency: 'cny' }] },
    'payment-methods': { methods: [] },
    '': { valid: false },
  };

  const queried = (call: { path: string }) => new URLSearchParams(call.path.split('?')[1] ?? '');

  it('names itself on every read the service scopes', async () => {
    const { request, calls } = stubService(routes);
    const monitor = makeMonitor(request);
    await monitor.initialize();
    await monitor.createOrder('monthly', 'alipay');
    await monitor.orderStatus('o-1');
    await monitor.paymentHistory();
    await monitor.getPlans();
    await monitor.getPaymentMethods('zh-CN');
    await monitor.activate('KEY12345');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const appId = call.method === 'GET'
        ? queried(call).get('appId')
        : (call.body as { appId?: string }).appId;
      expect(appId, `${call.method} ${call.path}`).toBe(APP_ID);
    }
  });

  it('keeps the other query parameters intact while adding it', async () => {
    const { request, calls } = stubService(routes);
    const monitor = makeMonitor(request);
    await monitor.initialize();
    await monitor.orderStatus('o 1');

    const status = queried(calls.find((c) => c.path.startsWith('trial/status'))!);
    expect(status.get('deviceId')).toBe(monitor.getDeviceId());

    // Escaped once, by URLSearchParams — not concatenated twice.
    const order = queried(calls.find((c) => c.path.startsWith('order-status'))!);
    expect(order.get('orderId')).toBe('o 1');
    expect(order.get('userId')).toBe(monitor.getUserId());
  });

  it('refuses a licence the service issued for another app', async () => {
    // It verifies — same account, same signing secret — so nothing but the
    // appId stops it unlocking this app off a sibling app's purchase.
    const { request } = stubService({
      ...routes,
      'order-status': {
        status: 'paid',
        token: token.createToken({
          userId: 'u1', appId: 'soothevoice', planId: 'annual', licenseKey: 'KEY12345',
          expiresAt: NOW + 365 * DAY, issuedAt: NOW,
        }),
      },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    const result = await monitor.orderStatus('o-1');
    expect(result.licensed).toBe(false);
    expect(result.code).toBe(APP_MISMATCH);
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('honours a token from before the service had an appId', async () => {
    // Every licence bought before this change carries none. Reading that as a
    // mismatch would sign out every existing subscriber on upgrade.
    const { request } = stubService({
      ...routes,
      'order-status': {
        status: 'paid',
        token: token.createToken({
          userId: 'u1', planId: 'annual', licenseKey: 'KEY12345', expiresAt: NOW + 365 * DAY, issuedAt: NOW,
        }),
      },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect((await monitor.orderStatus('o-1')).licensed).toBe(true);
    expect(monitor.getState().status).toBe('active');
  });

  it('ignores a stored token belonging to another app, rather than honouring it', async () => {
    writeFileSync(
      path.join(dir, 'license.enc'),
      secureStore.encrypt(dir, token.createToken({
        userId: 'u1', appId: 'soothevoice', planId: 'annual', licenseKey: 'KEY12345',
        expiresAt: NOW + 365 * DAY, issuedAt: NOW,
      })),
    );
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.getState().status).toBe('unlicensed');
    expect((await monitor.refresh()).code).toBe(APP_MISMATCH);
  });

  it('reports the service refusing a request for the wrong app', async () => {
    const { request } = stubService({ ...routes, 'create-order': { error: 'appId mismatch' } });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect((await monitor.createOrder('monthly', 'alipay')).code).toBe(APP_MISMATCH);
  });
});

describe('activating by hand', () => {
  /**
   * The box behind ENABLE_MANUAL_ACTIVATION takes two shapes, and the whole
   * point is that neither is a way past the checks a purchase goes through.
   */
  const routes = {
    'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
    'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
  };

  it('tells a licence key from a pasted token by shape alone', () => {
    // The service's own _LICENSE_KEY_RE admits no dots, so the two can never
    // be confused for one another.
    expect(looksLikeToken('header.body.signature')).toBe(true);
    expect(looksLikeToken('KEY12345')).toBe(false);
    expect(looksLikeToken('ABC-123_xyz')).toBe(false);
    // Not three non-empty parts: not a token.
    expect(looksLikeToken('a..c')).toBe(false);
    expect(looksLikeToken('a.b.c.d')).toBe(false);
  });

  it('exchanges a licence key with the service, as a purchase does', async () => {
    const paid = token.createToken({
      userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345', expiresAt: NOW + 30 * DAY, issuedAt: NOW,
    });
    const { request, calls } = stubService({ ...routes, '': { valid: true, token: paid } });
    const monitor = makeMonitor(request);
    await monitor.initialize();

    expect((await monitor.activate('KEY12345')).success).toBe(true);
    expect(monitor.getState().status).toBe('active');
    // It went to the service — this path is the online one, not a shortcut.
    const exchanged = calls.find((c) => c.path === '');
    expect(exchanged?.body).toMatchObject({ licenseKey: 'KEY12345', appId: APP_ID });
  });

  it('adopts a pasted token without needing the network at all', async () => {
    // The case the online flow cannot cover, and the reason the box exists.
    const pasted = token.createToken({
      userId: 'u1', planId: 'annual', licenseKey: 'KEY12345', expiresAt: NOW + 365 * DAY, issuedAt: NOW,
    });
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect((await monitor.activate(pasted)).success).toBe(true);
    expect(monitor.getState().status).toBe('active');
    expect(monitor.getState().payload.planId).toBe('annual');
  });

  it('refuses a token nobody with the signing secret produced', async () => {
    const forged = token.createToken({
      userId: 'u1', planId: 'annual', licenseKey: 'KEY12345', expiresAt: NOW + 365 * DAY, issuedAt: NOW,
    }, 'not-the-signing-secret');
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect((await monitor.activate(forged)).success).toBe(false);
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('refuses a token issued for another app, exactly as the paid path does', async () => {
    const sibling = token.createToken({
      userId: 'u1', appId: 'soothevoice', planId: 'annual', licenseKey: 'KEY12345',
      expiresAt: NOW + 365 * DAY, issuedAt: NOW,
    });
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    const result = await monitor.activate(sibling);
    expect(result.success).toBe(false);
    expect(result.code).toBe(APP_MISMATCH);
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('says a token is expired rather than that it was not accepted', async () => {
    // It verifies; it is simply over. Reporting "not accepted" would send the
    // user hunting for a typo that is not there.
    const stale = token.createToken({
      userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345',
      expiresAt: NOW - 90 * DAY, issuedAt: NOW - 120 * DAY,
    });
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    const result = await monitor.activate(stale);
    expect(result.success).toBe(false);
    expect(result.code).toBe(EXPIRED);
    expect(monitor.isLicensedNow()).toBe(false);
  });

  it('refuses an empty box without calling anything', async () => {
    const { request } = stubService(routes);
    const monitor = makeMonitor(request);
    await monitor.initialize();
    expect((await monitor.activate('   ')).success).toBe(false);
  });
});

describe('plans and payment methods', () => {
  it('take the service\'s figures when it answers', async () => {
    const { request } = stubService({
      plans: { plans: [{ id: 'monthly', price: 88, currency: 'cny' }] },
      'payment-methods': { methods: [{ id: 'alipay', name: '支付宝', enabled: true }] },
    });
    const monitor = makeMonitor(request);

    const plans = await monitor.getPlans();
    expect(plans.source).toBe('server');
    expect(plans.plans[0].price).toBe(88);

    const methods = await monitor.getPaymentMethods('zh-CN');
    expect(methods.methods[0].id).toBe('alipay');
  });

  it('fall back to the built-in prices offline, and say so', async () => {
    const monitor = makeMonitor(offlineService());
    const { plans, source } = await monitor.getPlans();
    expect(source).toBe('fallback');
    expect(plans).toHaveLength(4);
  });

  it('offer no payment method rather than one that would fail at checkout', async () => {
    const monitor = makeMonitor(offlineService());
    expect((await monitor.getPaymentMethods()).methods).toEqual([]);
  });
});

describe('refreshing', () => {
  it('exchanges the stored key for a token that expires later', async () => {
    const first = token.createToken({ userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345', expiresAt: NOW + DAY, issuedAt: NOW });
    const renewed = token.createToken({ userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345', expiresAt: NOW + 31 * DAY, issuedAt: NOW });
    writeFileSync(path.join(dir, 'license.enc'), secureStore.encrypt(dir, first));

    const { request, calls } = stubService({
      'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
      'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
      '': (body: unknown) => {
        expect(body).toMatchObject({ licenseKey: 'KEY12345' });
        return { valid: true, token: renewed };
      },
    });
    const monitor = makeMonitor(request);
    await monitor.initialize();
    expect(monitor.getState().daysRemaining).toBe(1);

    await monitor.refresh();
    expect(monitor.getState().daysRemaining).toBe(31);
    expect(calls.some((c) => c.path === '')).toBe(true);

    // And the renewed token is what a restart reads.
    secureStore.resetCache();
    const restarted = makeMonitor(offlineService());
    await restarted.initialize();
    expect(restarted.getState().daysRemaining).toBe(31);
  });

  it('leaves the stored licence alone when the service cannot be reached', async () => {
    const stored = token.createToken({ userId: 'u1', planId: 'monthly', licenseKey: 'KEY12345', expiresAt: NOW + 10 * DAY, issuedAt: NOW });
    writeFileSync(path.join(dir, 'license.enc'), secureStore.encrypt(dir, stored));

    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    const before = monitor.getState().status;

    const result = await monitor.refresh();
    expect(result.success).toBe(false);
    // A network failure is not an expiry.
    expect(monitor.getState().status).toBe(before);
    expect(readFileSync(path.join(dir, 'license.enc')).length).toBeGreaterThan(0);
  });

  it('has nothing to refresh without a licence', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    expect((await monitor.refresh()).success).toBe(false);
  });
});

describe('signing out', () => {
  it('removes the token and drops back to unlicensed', async () => {
    const stored = token.createToken({ userId: 'u1', planId: 'monthly', licenseKey: 'K1234567', expiresAt: NOW + DAY, issuedAt: NOW });
    writeFileSync(path.join(dir, 'license.enc'), secureStore.encrypt(dir, stored));

    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    await monitor.deactivate();

    expect(monitor.getState().status).toBe('unlicensed');
    secureStore.resetCache();
    const restarted = makeMonitor(offlineService());
    await restarted.initialize();
    expect(restarted.getState().status).toBe('unlicensed');
  });
});


describe('the demo licence', () => {
  /**
   * Seven days of everything, once per device, with no payment and — this is
   * the part worth pinning — no service call. The token is minted here and
   * signed with the secret this build already verifies with, so what these
   * cover is that it behaves like the licence it claims to be, that the
   * "once" actually holds across a restart, and that it stays visibly a demo
   * rather than passing itself off as a purchase.
   */
  const routes = {
    'trial/status': { trialUsed: false, trialStart: null, trialEnd: null },
    'trial/activate': { success: true, trialStart: NOW, trialEnd: NOW + 3 * DAY },
  };

  it('unlocks everything for seven days, without asking the service', async () => {
    const { request, calls } = stubService(routes);
    const monitor = makeMonitor(request);
    await monitor.initialize();
    const before = calls.length;

    const result = await monitor.activateDemo();

    expect(result.success).toBe(true);
    expect(monitor.getState().status).toBe('active');
    expect(monitor.isLicensedNow()).toBe(true);
    expect(monitor.getState().payload.expiresAt).toBe(NOW + DEMO_DURATION_DAYS * DAY);
    // No route was reached: the service has nothing that issues one of these.
    expect(calls.length).toBe(before);
  });

  it('marks itself a demo rather than passing as a purchase', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    await monitor.activateDemo();

    const { payload } = monitor.getState();
    expect(payload.planId).toBe(DEMO_PLAN_ID);
    // Scoped to this app like everything else the client honours, so a demo
    // taken here cannot licence the sibling app on the same account.
    expect(payload.appId).toBe(APP_ID);
  });

  it('is offered once per device, and remembers that across a restart', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    expect((await monitor.activateDemo()).success).toBe(true);

    const second = await monitor.activateDemo();
    expect(second.success).toBe(false);
    expect(second.code).toBe(DEMO_ALREADY_USED);

    // A restart that has also signed out: the licence is gone, the record is
    // not, so the demo is still spent.
    await monitor.deactivate();
    secureStore.resetCache();
    const restarted = makeMonitor(offlineService());
    await restarted.initialize();
    expect(restarted.getState().status).toBe('unlicensed');
    expect((await restarted.activateDemo()).code).toBe(DEMO_ALREADY_USED);
    expect(restarted.demoState().used).toBe(true);
  });

  it('takes the build\'s activation codes, and nothing else', async () => {
    expect(DEMO_CODES.every((code: string) => isDemoCode(code))).toBe(true);
    // Typed in by hand and read off a slide: case and stray spaces are not
    // wrong answers.
    expect(isDemoCode(` ${DEMO_CODES[0].toLowerCase()} `)).toBe(true);
    expect(isDemoCode('DEMO-1999')).toBe(false);
    expect(isDemoCode('')).toBe(false);

    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    const wrong = await monitor.activateDemo('NOT-A-CODE');
    expect(wrong.success).toBe(false);
    expect(wrong.code).toBe(DEMO_CODE_INVALID);
    // A refused code spends nothing: the button still works afterwards.
    expect(monitor.demoState().used).toBe(false);

    expect((await monitor.activateDemo(DEMO_CODES[0])).success).toBe(true);
    expect(monitor.getState().payload.planId).toBe(DEMO_PLAN_ID);
  });

  it('locks the features again when the seven days are up', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    await monitor.activateDemo();

    // Past the demo and past the grace period that follows every licence.
    const later = makeMonitor(
      offlineService(),
      (NOW + DEMO_DURATION_DAYS * DAY + 4 * DAY) * 1000,
    );
    await later.initialize();
    expect(later.getState().status).toBe('expired');
    expect(later.isLicensedNow()).toBe(false);
    // And it does not come round again — the point of the device record.
    expect((await later.activateDemo()).code).toBe(DEMO_ALREADY_USED);
  });

  it('is never sent to the service to be refreshed', async () => {
    const { request, calls } = stubService(routes);
    const monitor = makeMonitor(request);
    await monitor.initialize();
    await monitor.activateDemo();

    const result = await monitor.refresh();

    // Silent, and above all not an exchange: the service never issued this
    // key, so asking would come back "not accepted" and read as a licence
    // that had been revoked.
    expect(result.success).toBe(false);
    expect(calls.some((c: { path: string }) => c.path === '')).toBe(false);
    expect(monitor.isLicensedNow()).toBe(true);
  });

  it('reports a device that has never taken one as free to', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();

    expect(monitor.demoState()).toMatchObject({
      used: false, durationDays: DEMO_DURATION_DAYS, issuedAt: null, expiresAt: null,
    });

    await monitor.activateDemo();
    const after = monitor.demoState();
    expect(after.used).toBe(true);
    expect(after.expiresAt).toBe(new Date((NOW + DEMO_DURATION_DAYS * DAY) * 1000).toISOString());
  });

  it('keeps the record where an edited file cannot revive it', async () => {
    const monitor = makeMonitor(offlineService());
    await monitor.initialize();
    await monitor.activateDemo();

    // The record is machine-bound and encrypted for the same reason the trial
    // dates are: not because a date is secret, but so a second demo takes
    // more than editing a number.
    const raw = readFileSync(path.join(dir, DEMO_FILE));
    expect(raw.toString('utf8')).not.toContain('issuedAt');
  });
});

describe('state changes', () => {
  it('are pushed, so the window does not have to poll for them', async () => {
    const { request } = stubService({
      'trial/status': { trialUsed: true, trialStart: NOW, trialEnd: NOW + DAY, trialDurationDays: 3 },
    });
    const monitor = makeMonitor(request);
    const seen: string[] = [];
    monitor.on('state-change', (s: { status: string }) => seen.push(s.status));

    await monitor.initialize();
    expect(seen.length).toBeGreaterThan(0);
  });
});
