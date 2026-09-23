/**
 * What the app believes about a user's cloud-fill allowance.
 *
 * The interesting cases are all failures, because the safe answer to every one
 * of them is the same and it is not the obvious one: an allowance that cannot
 * be checked is an allowance that is not spent. The service is the only thing
 * that knows what the plan includes and what an extra one costs, and none of
 * it is compiled into the app — a change to the commercial terms should not
 * need a release, which is what these tests are really pinning down.
 */
import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const quota = require('../../../electron/cloud-quota.js');

const ALLOWED = {
  allowed: true,
  limit: 100,
  used: 12,
  remaining: 88,
  periodEnds: '2026-10-01T00:00:00Z',
  overagePrice: '¥0.30',
  endpoint: { url: 'https://fill.example.com/inpaint', token: 'abc' },
};

function client(request: unknown) {
  return quota.createCloudQuota({
    request,
    appId: 'test-app',
    deviceId: async () => 'device-1',
  });
}

describe('readQuota', () => {
  it('takes the allowance and the price from the service, not from here', () => {
    const state = quota.readQuota(ALLOWED);
    expect(state.limit).toBe(100);
    expect(state.remaining).toBe(88);
    expect(state.overagePrice).toBe('¥0.30');
  });

  it('refuses an answer that allows it but says where to send nothing', () => {
    const state = quota.readQuota({ ...ALLOWED, endpoint: null });
    expect(state.allowed).toBe(false);
    expect(state.endpoint).toBeNull();
  });

  it('keeps the endpoint to itself unless the answer allowed it', () => {
    const state = quota.readQuota({ ...ALLOWED, allowed: false });
    expect(state.allowed).toBe(false);
    expect(state.endpoint).toBeNull();
    expect(state.token).toBeNull();
  });

  it('reads nonsense as not allowed rather than guessing', () => {
    for (const reply of [null, undefined, 'yes', 42, {}]) {
      expect(quota.readQuota(reply).allowed).toBe(false);
    }
  });

  it('does not invent numbers the service did not send', () => {
    const state = quota.readQuota({ allowed: true, endpoint: { url: 'https://x/y' } });
    expect(state.limit).toBeNull();
    expect(state.remaining).toBeNull();
    expect(state.overagePrice).toBeNull();
  });

  it('says why, so "we could not ask" and "your plan says no" differ', () => {
    expect(quota.UNKNOWN.reason).toBe('unreachable');
    expect(quota.readQuota({ allowed: false, reason: 'planExcluded' }).reason)
      .toBe('planExcluded');
  });
});

describe('asking the service', () => {
  it('asks the quota route and reports what came back', async () => {
    const request = vi.fn().mockResolvedValue(ALLOWED);
    const state = await client(request).status({ userId: 'u1' });

    expect(request).toHaveBeenCalledWith('POST', quota.QUOTA_ROUTE, {
      appId: 'test-app', deviceId: 'device-1', userId: 'u1',
    });
    expect(state.allowed).toBe(true);
  });

  it('treats a service it cannot reach as one that said no', async () => {
    const request = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const state = await client(request).status({ userId: 'u1' });
    expect(state.allowed).toBe(false);
    expect(state.reason).toBe('unreachable');
  });

  it('counts an export after it ran, not before', async () => {
    const request = vi.fn().mockResolvedValue({ ...ALLOWED, used: 13, remaining: 87 });
    const state = await client(request).consume({ userId: 'u1' }, 1);

    expect(request).toHaveBeenCalledWith('POST', quota.CONSUME_ROUTE, {
      appId: 'test-app', deviceId: 'device-1', userId: 'u1', units: 1,
    });
    expect(state.remaining).toBe(87);
  });

  it('does not tell the service about an export that used nothing', async () => {
    const request = vi.fn();
    await client(request).consume({ userId: 'u1' }, 0);
    expect(request).not.toHaveBeenCalled();
  });

  it('swallows a failed count rather than taking the export away', async () => {
    const request = vi.fn().mockRejectedValue(new Error('gateway timeout'));
    await expect(client(request).consume({ userId: 'u1' }, 1)).resolves.toBeTruthy();
  });
});
