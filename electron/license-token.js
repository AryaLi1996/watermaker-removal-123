'use strict';

/**
 * The license token: how it is verified, and what its expiry means today.
 *
 * The format is the service's (see LICENSE_INFRASTRUCTURE.md §4) — a JWT
 * shape with a custom type:
 *
 *   base64url(header) . base64url(payload) . hex(HMAC-SHA256)
 *
 * The token, not the payment provider's records, is the single source of
 * truth for when access ends. That is what lets the app answer "am I still
 * licensed" while completely offline.
 *
 * Both ends holding the same HMAC secret is the known cost of this scheme:
 * anyone with the app can forge a token. The service's own docs call this out
 * and point at RSA — server signs with a private key, the app verifies with
 * an embedded public one — as the fix. Verification is centralised here so
 * that change lands in one place.
 *
 * The same centralisation is what makes rotating the HMAC secret survivable.
 * Signing uses exactly one secret; verification accepts the previous one too
 * while a rotation is in flight, so the service can switch which one it signs
 * with without every token already issued reading as revoked. See
 * `PREVIOUS_SIGNING_SECRET` in license-config.js for the sequence.
 */

const { createHmac, timingSafeEqual } = require('crypto');
const { LICENSE_CONFIG } = require('./license-config');

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'LICENSE' })).toString('base64url');

function sign(data, secret = LICENSE_CONFIG.signingSecret) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Only used by tests and by the offline demo path; the service signs the
 *  tokens that matter. */
function createToken(payload, secret = LICENSE_CONFIG.signingSecret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${HEADER}.${body}.${sign(`${HEADER}.${body}`, secret)}`;
}

/**
 * Every secret a token may have been signed with, most recent first.
 *
 * Order matters only for speed: the current secret verifies all but the
 * tokens issued before a rotation, so trying it first means the fallback
 * costs one extra HMAC on exactly those.
 */
function acceptedSecrets(secret) {
  if (Array.isArray(secret)) return secret.filter(Boolean);
  if (typeof secret === 'string') return [secret];
  return [LICENSE_CONFIG.signingSecret, LICENSE_CONFIG.previousSigningSecret].filter(Boolean);
}

/** Whether `signature` is what `secret` would produce over `data`. */
function signatureMatches(data, signature, secret) {
  const expected = sign(data, secret);
  try {
    // Constant time: a signature check that returns faster for a closer guess
    // is a signature check that can be walked to a valid one.
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // Non-hex, or a length mismatch that timingSafeEqual refuses to compare.
    return false;
  }
}

/**
 * The payload of a token this app can prove it issued, or null.
 *
 * Null covers every failure the same way — wrong shape, bad signature,
 * unparseable payload — because none of them is a license and telling them
 * apart only helps someone trying to forge one.
 *
 * `secret` is for tests and for `verifiedWithPreviousSecret` below; left off,
 * this accepts the current secret and, during a rotation, the previous one.
 */
function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const secrets = acceptedSecrets(secret);
  if (!secrets.some((s) => signatureMatches(`${header}.${body}`, signature, s))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.expiresAt !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Whether this token only verifies under the *previous* secret.
 *
 * A licence that is genuine but signed with the outgoing secret: still
 * honoured, and worth re-fetching, because the window in which the old secret
 * is accepted is meant to close. `refresh()` uses it to swap the token for one
 * signed with the current secret at the first opportunity rather than waiting
 * for the licence to lapse.
 *
 * False when no rotation is in flight, and false for a forgery — a token that
 * verifies under neither secret is not a licence at all.
 */
function verifiedWithPreviousSecret(token) {
  const previous = LICENSE_CONFIG.previousSigningSecret;
  if (!previous) return false;
  return verifyToken(token, LICENSE_CONFIG.signingSecret) === null
    && verifyToken(token, previous) !== null;
}

/**
 * What a token means right now.
 *
 * `grace_period` is the interesting one: for `gracePeriodDays` after expiry
 * the app keeps working. Someone who is offline, or whose renewal is midway
 * through, should not be locked out of what they paid for by a network they
 * cannot reach.
 */
function resolveStatus(payload, nowSeconds) {
  if (!payload) return 'unlicensed';
  const graceEnds = payload.expiresAt + LICENSE_CONFIG.gracePeriodDays * 86400;
  if (nowSeconds < payload.expiresAt) return 'active';
  if (nowSeconds < graceEnds) return 'grace_period';
  return 'expired';
}

/** Whether this status is one where paid features are available. */
function isLicensed(status) {
  return status === 'active' || status === 'grace_period';
}

/** The license half of the state the renderer renders. */
function buildLicenseState(payload, nowSeconds) {
  const status = resolveStatus(payload, nowSeconds);
  if (!payload) {
    return { status, payload: null, expiresAt: null, daysRemaining: 0, graceDaysLeft: 0 };
  }
  const graceEnds = payload.expiresAt + LICENSE_CONFIG.gracePeriodDays * 86400;
  return {
    status,
    payload,
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
    daysRemaining: status === 'active' ? Math.max(0, Math.ceil((payload.expiresAt - nowSeconds) / 86400)) : 0,
    graceDaysLeft: status === 'grace_period' ? Math.max(0, Math.ceil((graceEnds - nowSeconds) / 86400)) : 0,
  };
}

module.exports = {
  HEADER, sign, createToken, verifyToken, verifiedWithPreviousSecret, acceptedSecrets,
  resolveStatus, isLicensed, buildLicenseState,
};
