/**
 * The trial's allowance of temporal-fill exports.
 *
 * Worth testing directly rather than through the app because the interesting
 * cases are the ones a running app makes hard to reach: a count that survives
 * a restart, a file somebody edited, and the moment a licence arrives and
 * clears the tally.
 */
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const usage = require('../../../electron/temporal-usage.js');
const secureStore = require('../../../electron/secure-store.js');

const TRIAL = { licensed: false, trialActive: true };
const SUBSCRIBED = { licensed: true, trialActive: false };
const TRIAL_OVER = { licensed: false, trialActive: false };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'temporal-'));
  secureStore.resetCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the allowance', () => {
  it('starts at three, none of them spent', () => {
    const state = usage.usageState(dir, TRIAL);
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(usage.TEMPORAL_TRIAL_EXPORTS);
    expect(state.allowed).toBe(true);
  });

  it('spends one run per export, and stops at the third', () => {
    for (let i = 1; i <= usage.TEMPORAL_TRIAL_EXPORTS; i += 1) {
      const state = usage.recordUse(dir, TRIAL);
      expect(state.used, `run ${i}`).toBe(i);
      expect(state.remaining, `run ${i}`).toBe(usage.TEMPORAL_TRIAL_EXPORTS - i);
    }
    const spent = usage.usageState(dir, TRIAL);
    expect(spent.remaining).toBe(0);
    expect(spent.exhausted).toBe(true);
    expect(spent.allowed).toBe(false);
  });

  it('never goes negative, however many runs got through', () => {
    for (let i = 0; i < 10; i += 1) usage.recordUse(dir, TRIAL);
    expect(usage.usageState(dir, TRIAL).remaining).toBe(0);
  });

  it('survives a restart, which is the whole point of writing it down', () => {
    usage.recordUse(dir, TRIAL);
    usage.recordUse(dir, TRIAL);
    secureStore.resetCache();
    expect(usage.usageState(dir, TRIAL).used).toBe(2);
  });
});

describe('who the allowance applies to', () => {
  it('does not meter a subscriber at all', () => {
    const state = usage.usageState(dir, SUBSCRIBED);
    expect(state.limited).toBe(false);
    expect(state.remaining).toBe(Infinity);
    expect(state.allowed).toBe(true);
  });

  it('does not count a subscriber\'s exports', () => {
    // Otherwise letting a subscription lapse would reveal a tally built up
    // while it was in force, and the method would be locked immediately.
    for (let i = 0; i < 5; i += 1) usage.recordUse(dir, SUBSCRIBED);
    expect(usage.readUses(dir)).toBe(0);
  });

  it('gives an ended trial nothing, rather than three held in reserve', () => {
    // Before this allowance existed the trial got no temporal fill at all.
    // An expired one goes back to exactly that.
    const state = usage.usageState(dir, TRIAL_OVER);
    expect(state.allowed).toBe(false);
    expect(state.remaining).toBe(usage.TEMPORAL_TRIAL_EXPORTS);
  });

  it('clears the count when a licence arrives', () => {
    usage.recordUse(dir, TRIAL);
    usage.recordUse(dir, TRIAL);
    usage.resetUses(dir);
    expect(usage.readUses(dir)).toBe(0);
    // And a lapse back to the trial starts from a clean three.
    expect(usage.usageState(dir, TRIAL).allowed).toBe(true);
  });

  it('resets without a file to delete, rather than throwing', () => {
    expect(() => usage.resetUses(dir)).not.toThrow();
  });
});

describe('a count that cannot be trusted', () => {
  it('is encrypted, so it cannot be reset in a text editor', () => {
    usage.recordUse(dir, TRIAL);
    const text = readFileSync(path.join(dir, usage.USAGE_FILE)).toString('utf8');
    // The record as it would read if it were written in the clear, and then
    // the weaker property that the file is not readable structured text at
    // all. Looking for a single character like '1' does not work here: the
    // file is 39 bytes of ciphertext, so any one byte value turns up in it by
    // chance — measured at 15.5% of runs, which is where this test's history
    // of failing for no reason came from.
    expect(text).not.toContain('count');
    expect(text).not.toContain(JSON.stringify({ count: 1 }));
    expect(() => JSON.parse(text)).toThrow();
  });

  it('reads a file somebody edited as no uses at all', () => {
    // Generous on purpose: handing back a few runs is the cheaper mistake
    // than locking an evaluating user out of the feature on a decryption
    // error. A count that must be tamper-proof belongs on the service.
    usage.recordUse(dir, TRIAL);
    const file = path.join(dir, usage.USAGE_FILE);
    const edited = Buffer.from(readFileSync(file));
    edited[edited.length - 1] ^= 0xff;
    writeFileSync(file, edited);
    secureStore.resetCache();
    expect(usage.readUses(dir)).toBe(0);
  });

  it('reads nonsense in the record as no uses', () => {
    for (const bad of ['{}', '{"count":"lots"}', '{"count":-4}', 'not json']) {
      writeFileSync(path.join(dir, usage.USAGE_FILE), secureStore.encrypt(dir, bad));
      expect(usage.readUses(dir), bad).toBe(0);
    }
  });

  it('reads a missing file as no uses', () => {
    expect(usage.readUses(dir)).toBe(0);
  });
});
