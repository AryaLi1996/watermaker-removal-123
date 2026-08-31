'use strict';

/**
 * How many temporal-fill exports an unsubscribed user has left.
 *
 * Temporal fill is the expensive method and the reason to subscribe: it reads
 * several frames per frame and computes optical flow against each.
 *
 * Note what this changes. The trial used to sit on the free tier and get
 * *none* of it — `FREE_TIER.temporalFill` is false, and the trial has always
 * resolved to the free tier. An allowance of three is therefore a loosening:
 * someone on the trial can now do something with the paid method that they
 * could not do before, capped so that a whole project still cannot be pushed
 * through without paying.
 *
 * **Exports count; previews do not.** A preview is capped at three seconds
 * (`TEMPORAL_PREVIEW_MAX_SECONDS`) and runs at the lowest quality whatever the
 * dial says, so it costs a fraction of an export — and it is the only way to
 * find out whether the box is in the right place. Charging a run for it would
 * make the honest workflow, checking before committing, the expensive one:
 * someone would burn all three allowances on framing and never see a finished
 * video. Which is the whole thing they are deciding whether to pay for.
 *
 * The count is written through `secure-store`, the same machine-bound
 * AES-256-GCM the trial dates use, for the same reason: not because the
 * number is secret, but so it cannot be reset in a text editor. Deleting the
 * file resets it, as deleting the trial file would — this is a nudge toward
 * paying, not a DRM scheme, and the honest limit of a local counter is worth
 * stating rather than pretending otherwise. The service is where a
 * tamper-proof count would have to live.
 */

const fs = require('fs');
const path = require('path');

const secureStore = require('./secure-store');

/** The file the count lives in, beside `trial.enc` in the app's userData. */
const USAGE_FILE = 'temporal.enc';

/**
 * Temporal-fill exports allowed without a subscription.
 *
 * Three: enough to finish a short piece of work and see the method is worth
 * paying for, few enough that a whole project cannot be pushed through on the
 * trial alone.
 */
const TEMPORAL_TRIAL_EXPORTS = 3;

function usagePath(userDataDir) {
  return path.join(userDataDir, USAGE_FILE);
}

/**
 * Exports used so far.
 *
 * Every failure reads as zero — no file yet, a file from another machine, one
 * somebody edited. Being wrong in that direction hands back a few runs; being
 * wrong the other way locks a paying-curious user out of the feature they were
 * evaluating, on nothing better than a decryption error.
 */
function readUses(userDataDir) {
  try {
    const plain = secureStore.decrypt(userDataDir, fs.readFileSync(usagePath(userDataDir)));
    const record = plain ? JSON.parse(plain) : null;
    const count = record && Number(record.count);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  } catch {
    return 0;
  }
}

function writeUses(userDataDir, count) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      usagePath(userDataDir),
      secureStore.encrypt(userDataDir, JSON.stringify({ count })),
      { mode: 0o600 },
    );
  } catch (err) {
    // The count still applies for this session; losing it costs a few runs,
    // and failing the export over it would cost the user their work.
    console.warn('[temporal] could not save the use count:', err.message);
  }
}

/**
 * What the renderer needs to render the limit, and what the main process
 * needs to enforce it.
 *
 * `allowed` is the question both actually ask, so it is answered once here
 * rather than re-derived at each call site out of `licensed`, the trial and
 * the count — three inputs that would otherwise have to be combined the same
 * way in the sidebar, the method picker and the job handler.
 */
function usageState(userDataDir, { licensed = false, trialActive = false } = {}) {
  const used = readUses(userDataDir);
  if (licensed) {
    return {
      used, limit: TEMPORAL_TRIAL_EXPORTS, remaining: Infinity,
      limited: false, exhausted: false, allowed: true,
    };
  }
  const remaining = Math.max(0, TEMPORAL_TRIAL_EXPORTS - used);
  return {
    used,
    limit: TEMPORAL_TRIAL_EXPORTS,
    remaining,
    limited: true,
    exhausted: remaining === 0,
    // The allowance belongs to the trial, not to being unlicensed. Once the
    // trial is over the method goes back to needing a subscription, which is
    // where it was before this allowance existed — an expired trial does not
    // get to keep three runs in reserve.
    allowed: trialActive && remaining > 0,
  };
}

/** Count one export against the allowance. A subscriber's runs are not counted
 *  at all, so cancelling a subscription cannot reveal a tally built up while
 *  it was in force. */
function recordUse(userDataDir, context = {}) {
  if (context.licensed) return usageState(userDataDir, context);
  writeUses(userDataDir, readUses(userDataDir) + 1);
  return usageState(userDataDir, context);
}

/** Clear the count. Called when a licence is adopted: what someone tried
 *  before paying should not follow them after. */
function resetUses(userDataDir) {
  try {
    fs.unlinkSync(usagePath(userDataDir));
  } catch {
    // Never written, or already gone.
  }
}

module.exports = {
  USAGE_FILE,
  TEMPORAL_TRIAL_EXPORTS,
  readUses,
  writeUses,
  usageState,
  recordUse,
  resetUses,
};
