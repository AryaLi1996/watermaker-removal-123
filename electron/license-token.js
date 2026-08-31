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
 * The payload of a token this app can prove it issued, or null.
 *
 * Null covers every failure the same way — wrong shape, bad signature,
 * unparseable payload — because none of them is a license and telling them
 * apart only helps someone trying to forge one.
 */
function verifyToken(token, secret = LICENSE_CONFIG.signingSecret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const expected = sign(`${header}.${body}`, secret);
  try {
    // Constant time: a signature check that returns faster for a closer guess
    // is a signature check that can be walked to a valid one.
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    // Non-hex, or a length mismatch that timingSafeEqual refuses to compare.
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.expiresAt !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
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

module.exports = { HEADER, sign, createToken, verifyToken, resolveStatus, isLicensed, buildLicenseState };
