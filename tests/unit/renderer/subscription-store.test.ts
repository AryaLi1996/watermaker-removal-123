/**
 * Unit tests for the main process's side of the subscription: the JSON file
 * that has to survive a restart, and the rules for writing to it.
 */
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const store = require('../../../electron/subscription.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'subscription-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('first launch', () => {
  it('grants a three-day trial and writes it straight away', () => {
    const granted = store.getStatus(dir, NOW);
    expect(granted.plan).toBe('trial');
    expect(Date.parse(granted.endDate) - NOW).toBe(3 * DAY);

    const onDisk = JSON.parse(readFileSync(store.storePath(dir), 'utf8'));
    expect(onDisk).toEqual(granted);
  });

  it('does not grant it twice — a second launch reads the same dates', () => {
    const first = store.getStatus(dir, NOW);
    const second = store.getStatus(dir, NOW + DAY);
    expect(second).toEqual(first);
  });
});

describe('reading a damaged file', () => {
  it('starts a fresh trial rather than refusing to load', () => {
    writeFileSync(store.storePath(dir), '{ not json');
    expect(store.read(dir)).toBeNull();
    expect(store.getStatus(dir, NOW).plan).toBe('trial');
  });

  it('ignores a file that is valid JSON but not a record', () => {
    writeFileSync(store.storePath(dir), JSON.stringify({ hello: 'world' }));
    expect(store.read(dir)).toBeNull();
  });
});

describe('subscribing', () => {
  it('writes the plan, its end date and auto-renewal', () => {
    const bought = store.subscribe(dir, 'yearly', 'alipay', NOW);
    expect(bought.plan).toBe('yearly');
    expect(bought.autoRenew).toBe(true);
    expect(bought.endDate).toBe(new Date('2027-03-01T12:00:00.000Z').toISOString());
    expect(store.read(dir)).toEqual(bought);
  });

  it('survives a restart', () => {
    store.subscribe(dir, 'halfyear', 'wechat', NOW);
    // A fresh read is what the next launch does.
    expect(store.getStatus(dir, NOW + DAY).plan).toBe('halfyear');
  });

  it('carries the time left on a paid plan into the renewal', () => {
    store.subscribe(dir, 'monthly', 'wechat', NOW);
    const renewed = store.subscribe(dir, 'monthly', 'wechat', NOW + 14 * DAY);
    expect(renewed.endDate).toBe(new Date('2026-05-01T12:00:00.000Z').toISOString());
  });

  it('replaces a trial instead of extending it', () => {
    store.getStatus(dir, NOW);
    const bought = store.subscribe(dir, 'monthly', 'alipay', NOW);
    expect(bought.endDate).toBe(new Date('2026-04-01T12:00:00.000Z').toISOString());
  });

  it('refuses a plan or a payment method it does not know', () => {
    expect(() => store.subscribe(dir, 'lifetime', 'wechat', NOW)).toThrow(/plan/i);
    expect(() => store.subscribe(dir, 'monthly', 'cash', NOW)).toThrow(/payment/i);
  });
});

describe('cancelling auto-renewal', () => {
  it('turns renewal off and leaves the plan and its end date alone', () => {
    const bought = store.subscribe(dir, 'quarterly', 'wechat', NOW);
    const cancelled = store.setAutoRenew(dir, false, NOW + DAY);
    expect(cancelled.autoRenew).toBe(false);
    expect(cancelled.plan).toBe('quarterly');
    expect(cancelled.endDate).toBe(bought.endDate);
    expect(store.read(dir).autoRenew).toBe(false);
  });
});
