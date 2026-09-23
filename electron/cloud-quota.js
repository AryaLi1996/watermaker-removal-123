'use strict';

/**
 * How many cloud fills this user has left, and what an extra one costs.
 *
 * Every number here comes from the service. The monthly allowance, the price
 * beyond it, what counts as one — none of it is compiled into the app, and
 * none of it is guessed at when the service cannot be reached. Changing the
 * allowance from a hundred to two hundred, or the price, or the billing unit,
 * is then a change on the service and not a release everybody has to install.
 * That seam is the whole reason this file is not three constants.
 *
 * **Not reachable means not allowed.** A local count of something that costs
 * money is a count that can be reset with a text editor — `temporal-usage.js`
 * says as much about its own — and an export that spends against a guess is
 * the one outcome that cannot be taken back. So a service that is down, slow
 * or refusing means this export is filled on the user's own machine, which
 * still finishes it.
 *
 * The routes live beside the licence ones on the same shared service, and are
 * dispatched the same way (see license-config.js): a path suffix on one base
 * URL, so a Function URL and an API Gateway stage both work.
 */

const { LICENSE_CONFIG } = require('./license-config');

/** Asked before an export, to find out whether it may use the service. */
const QUOTA_ROUTE = 'fill/quota';

/** Told after one, so the count is kept where it cannot be edited. */
const CONSUME_ROUTE = 'fill/consume';

/**
 * What the app believes when it has not been told otherwise.
 *
 * Deliberately a refusal rather than a default allowance: see above. The
 * `reason` is a key the renderer has a sentence for, so an unreachable service
 * and a plan that does not include the feature do not read the same.
 */
const UNKNOWN = Object.freeze({
  allowed: false,
  limit: null,
  used: null,
  remaining: null,
  periodEnds: null,
  overagePrice: null,
  endpoint: null,
  token: null,
  reason: 'unreachable',
});

/**
 * One reply from the service, in the shape the renderer expects.
 *
 * Read field by field rather than passed through, so that a service which
 * grows a field, renames one, or answers with something unexpected cannot
 * decide what this app does. Anything missing reads as "not allowed", which is
 * the safe direction for every field here.
 */
function readQuota(reply) {
  if (!reply || typeof reply !== 'object') return UNKNOWN;
  const endpoint = reply.endpoint && typeof reply.endpoint === 'object'
    ? { url: String(reply.endpoint.url || ''), token: reply.endpoint.token || null }
    : null;
  const allowed = reply.allowed === true && Boolean(endpoint && endpoint.url);
  return {
    allowed,
    limit: Number.isFinite(reply.limit) ? reply.limit : null,
    used: Number.isFinite(reply.used) ? reply.used : null,
    remaining: Number.isFinite(reply.remaining) ? reply.remaining : null,
    periodEnds: typeof reply.periodEnds === 'string' ? reply.periodEnds : null,
    // Already formatted by the service: the app does not know this user's
    // currency and should not be inventing one.
    overagePrice: typeof reply.overagePrice === 'string' ? reply.overagePrice : null,
    endpoint: allowed ? endpoint : null,
    token: allowed ? endpoint.token : null,
    reason: allowed ? null : (typeof reply.reason === 'string' ? reply.reason : 'notAllowed'),
  };
}

/**
 * The quota client.
 *
 * `request` is the same one the licence monitor uses — see license-request.js
 * for why it has to be the kind of timeout that hangs up rather than merely
 * stops waiting.
 */
function createCloudQuota({ request, appId, deviceId }) {
  // `context.userId` is the same stable anonymous id the payment routes use,
  // so an allowance belongs to whoever paid rather than to a machine. Who is
  // entitled to what is the service's judgement either way: this only says who
  // is asking.
  async function status(context = {}) {
    if (!LICENSE_CONFIG.verificationUrl) return UNKNOWN;
    try {
      return readQuota(await request('POST', QUOTA_ROUTE, {
        appId,
        deviceId: await deviceId(),
        userId: context.userId || null,
      }));
    } catch {
      // Down, slow, refusing, not deployed yet: all the same answer.
      return UNKNOWN;
    }
  }

  /**
   * Count an export that used the service.
   *
   * Told after the fact rather than reserved before it, because what the user
   * is charged for should be what they got. An export that fell back to the
   * local filler for every frame is not one of their hundred.
   *
   * A failure here is swallowed: the work is already done and the file is
   * already written, and failing the export over a count the service will
   * reconcile anyway would take something real away from the user over
   * something that is not.
   */
  async function consume(context = {}, units = 1) {
    if (!LICENSE_CONFIG.verificationUrl || units <= 0) return UNKNOWN;
    try {
      return readQuota(await request('POST', CONSUME_ROUTE, {
        appId,
        deviceId: await deviceId(),
        userId: context.userId || null,
        units,
      }));
    } catch {
      return UNKNOWN;
    }
  }

  return { status, consume };
}

module.exports = {
  QUOTA_ROUTE,
  CONSUME_ROUTE,
  UNKNOWN,
  readQuota,
  createCloudQuota,
};
