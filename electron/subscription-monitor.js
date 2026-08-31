'use strict';

/**
 * The subscription, as this app sees it: a signed license token, a device
 * trial, and the state machine over both.
 *
 * Everything durable lives with the shared license service described in
 * docs/LICENSE_SERVICE.md — one Lambda, three DynamoDB tables, reached over a
 * single base URL. This process keeps only what it needs to answer "is this
 * user licensed" without the network: the token, the trial dates, and a
 * high-water timestamp that catches a clock wound backwards.
 *
 * States: loading → unlicensed | active | grace_period | expired
 *
 * The class takes its filesystem root, its clock and its transport as
 * constructor arguments. That is what makes the whole state machine testable
 * without Electron, which matters because the parts worth testing — expiry,
 * the grace period, trial precedence, order polling — are exactly the parts
 * that are painful to reach through a running app.
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const { LICENSE_CONFIG, APP_ID, fallbackPlans, PAYMENT_METHODS } = require('./license-config');
const { verifyToken, buildLicenseState, isLicensed } = require('./license-token');
const secureStore = require('./secure-store');
const { getDeviceId } = require('./device-id');

const TOKEN_FILE = 'license.enc';
const TRIAL_FILE = 'trial.enc';
const TS_FILE = '.license_ts';
const ANON_ID_FILE = '.anon_id';

/**
 * The one error the caller has to be able to tell apart.
 *
 * Every other failure here is a network or a wrong key, and reads the same to
 * the user: try again. A license or an order belonging to another app is
 * different — retrying will never fix it, and the honest instruction is to
 * activate again on this app.
 */
const APP_MISMATCH = 'app_mismatch';

/**
 * Whether a service reply is about this app at all.
 *
 * Two shapes count. A reply that names an `appId` other than ours is one the
 * service scoped elsewhere; an error mentioning `appId` is one it refused for
 * the same reason. Anything else is somebody else's problem to report.
 */
function isAppMismatch(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.appId === 'string' && data.appId && data.appId !== APP_ID) return true;
  return typeof data.error === 'string' && /appid/i.test(data.error);
}

/**
 * Whether a verified token was issued for this app.
 *
 * A token minted before the appId dimension existed carries none, and is this
 * app's by definition — its rows are the ones the migration stamps with our
 * appId. Reading an absent appId as a mismatch would sign out every existing
 * subscriber the moment this build ships.
 */
function tokenIsOurs(payload) {
  const appId = payload && payload.appId;
  return typeof appId !== 'string' || appId === '' || appId === APP_ID;
}

/** A query string with `appId` always on it, escaped once and in one place. */
function query(params) {
  const search = new URLSearchParams({ ...params, appId: APP_ID });
  return search.toString();
}

/** No trial known yet — the shape the renderer can always read. */
const NO_TRIAL = {
  used: false,
  active: false,
  start: null,
  end: null,
  msRemaining: 0,
  durationDays: LICENSE_CONFIG.trial.durationDays,
  source: 'none',
};

class SubscriptionMonitor extends EventEmitter {
  constructor({ userDataDir, request, now = () => Date.now() }) {
    super();
    this.userDataDir = userDataDir;
    this.now = now;
    this._request = request;
    this._state = {
      status: 'loading',
      payload: null,
      expiresAt: null,
      daysRemaining: 0,
      graceDaysLeft: 0,
      trial: NO_TRIAL,
    };
    this._refreshTimer = null;
    this._trialTimer = null;
  }

  // ── Paths ───────────────────────────────────────────────────────────────
  _path(name) {
    return path.join(this.userDataDir, name);
  }

  _nowSeconds() {
    return Math.floor(this.now() / 1000);
  }

  // ── Anonymous payment id ────────────────────────────────────────────────
  /**
   * There is no account system: an order is tied to a random id generated on
   * first use. It identifies nobody — it exists so a person's own orders and
   * license can be found again.
   */
  getUserId() {
    const idPath = this._path(ANON_ID_FILE);
    try {
      const stored = fs.readFileSync(idPath, 'utf8').trim();
      if (stored) return stored;
    } catch {
      // Not created yet.
    }
    const id = randomUUID();
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(idPath, id, { mode: 0o600 });
    } catch {
      // Usable for this session even if it could not be saved.
    }
    return id;
  }

  getDeviceId() {
    return getDeviceId(this.userDataDir);
  }

  // ── Anti-clock-tamper ───────────────────────────────────────────────────
  /**
   * The furthest forward this app has ever seen the clock.
   *
   * Expiry is a comparison against the local clock, so winding the clock back
   * would otherwise revive an expired license indefinitely. Every successful
   * check records the high-water mark; a launch that finds "now" behind it is
   * treated as expired rather than trusted.
   */
  _maxSeenTs() {
    try {
      return Number(fs.readFileSync(this._path(TS_FILE)).readBigUInt64BE(0));
    } catch {
      return 0;
    }
  }

  _saveMaxSeenTs(nowSeconds) {
    try {
      const buf = Buffer.allocUnsafe(8);
      buf.writeBigUInt64BE(BigInt(Math.max(nowSeconds, this._maxSeenTs())));
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this._path(TS_FILE), buf);
    } catch {
      // Best effort; losing the mark only loses the tamper check.
    }
  }

  /** 60 seconds of tolerance, because NTP corrections are not tampering. */
  _clockTampered(nowSeconds) {
    return nowSeconds < this._maxSeenTs() - 60;
  }

  // ── Token persistence ───────────────────────────────────────────────────
  _loadToken() {
    try {
      const raw = fs.readFileSync(this._path(TOKEN_FILE));
      return secureStore.decrypt(this.userDataDir, raw);
    } catch {
      return null;
    }
  }

  _saveToken(token) {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this._path(TOKEN_FILE), secureStore.encrypt(this.userDataDir, token), { mode: 0o600 });
    } catch (err) {
      console.warn('[license] could not save the token:', err.message);
    }
  }

  _deleteToken() {
    try {
      fs.unlinkSync(this._path(TOKEN_FILE));
    } catch {
      // Already gone.
    }
  }

  // ── Trial persistence ───────────────────────────────────────────────────
  _loadLocalTrial() {
    try {
      const plain = secureStore.decrypt(this.userDataDir, fs.readFileSync(this._path(TRIAL_FILE)));
      const rec = plain ? JSON.parse(plain) : null;
      return rec && typeof rec.trialStart === 'number' && typeof rec.trialEnd === 'number' ? rec : null;
    } catch {
      return null;
    }
  }

  _saveLocalTrial(rec) {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this._path(TRIAL_FILE), secureStore.encrypt(this.userDataDir, JSON.stringify(rec)), { mode: 0o600 });
    } catch {
      // The record still applies for this session.
    }
  }

  // ── State ───────────────────────────────────────────────────────────────
  getState() {
    return this._state;
  }

  _setState(next) {
    this._state = next;
    this.emit('state-change', next);
  }

  _applyLicense(payload, nowSeconds) {
    this._setState({ ...buildLicenseState(payload, nowSeconds), trial: this._state.trial });
  }

  _trialState(rec, source, nowSeconds) {
    if (!rec) return { ...NO_TRIAL, source };
    return {
      used: true,
      active: nowSeconds < rec.trialEnd,
      start: new Date(rec.trialStart * 1000).toISOString(),
      end: new Date(rec.trialEnd * 1000).toISOString(),
      msRemaining: Math.max(0, (rec.trialEnd - nowSeconds) * 1000),
      durationDays: rec.durationDays || LICENSE_CONFIG.trial.durationDays,
      source,
    };
  }

  /**
   * The stored token's payload, if it is this app's to honour.
   *
   * A token for another app verifies here — same account, same signing secret
   * — so nothing but the appId stops it unlocking this one.
   */
  _storedPayload() {
    const token = this._loadToken();
    const payload = token ? verifyToken(token) : null;
    if (payload && !tokenIsOurs(payload)) {
      console.warn(`[license] ignoring a stored token issued for ${payload.appId}, not ${APP_ID}`);
      return null;
    }
    return payload;
  }

  // ── Startup ─────────────────────────────────────────────────────────────
  async initialize() {
    // Runs whether or not this device has ever been licensed: the trial is
    // what an unlicensed user has, and the service is the authority on
    // whether this machine has already used it.
    await this._syncTrial();
    this._startTrialTimer();

    const nowSeconds = this._nowSeconds();
    const payload = this._storedPayload();

    if (payload && this._clockTampered(nowSeconds)) {
      // Not deleted: the license may well be real, and the clock may be
      // fixed. Withholding access is enough.
      this._applyLicense({ ...payload, expiresAt: 0 }, nowSeconds);
      return;
    }

    this._applyLicense(payload, nowSeconds);
    if (payload) {
      this._saveMaxSeenTs(nowSeconds);
      this._startRefreshTimer();
    }
  }

  stop() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    if (this._trialTimer) clearInterval(this._trialTimer);
    this._refreshTimer = null;
    this._trialTimer = null;
  }

  _startRefreshTimer() {
    if (this._refreshTimer) return;
    this._refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {
        // A refresh that cannot reach the service is not a failure worth
        // showing: the stored token and the grace period cover it.
      });
    }, LICENSE_CONFIG.refreshIntervalHours * 3600_000);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  _startTrialTimer() {
    if (this._trialTimer) return;
    this._trialTimer = setInterval(() => {
      void this._syncTrial().catch(() => {});
    }, LICENSE_CONFIG.trial.syncIntervalHours * 3600_000);
    if (this._trialTimer.unref) this._trialTimer.unref();
  }

  // ── Trial ───────────────────────────────────────────────────────────────
  _recordFromServer(trialStart, trialEnd, durationDays) {
    return {
      trialStart,
      trialEnd,
      durationDays: typeof durationDays === 'number' ? durationDays : LICENSE_CONFIG.trial.durationDays,
    };
  }

  /**
   * Work out this device's trial, preferring the service.
   *
   * Order matters: the service knows whether this machine has had a trial
   * before, which is the whole point of having one there. Local state is the
   * fallback for an offline launch, and a first launch that is also offline
   * starts a local trial rather than refusing one — the service will adopt it
   * on the next sync (its activate is idempotent and returns the record it
   * already has).
   */
  async _resolveTrial() {
    const local = this._loadLocalTrial();
    const localDuration = local && local.durationDays;
    const deviceId = this.getDeviceId();

    try {
      const status = await this._request(
        'GET', `trial/status?${query({ deviceId })}`, undefined, LICENSE_CONFIG.startupTimeoutMs,
      );
      if (status.error) throw new Error(status.error);

      if (status.trialUsed && status.trialStart != null && status.trialEnd != null) {
        const rec = this._recordFromServer(status.trialStart, status.trialEnd, status.trialDurationDays);
        this._saveLocalTrial(rec);
        return { rec, source: 'server' };
      }

      const activated = await this._request(
        'POST', 'trial/activate', { deviceId, appId: APP_ID }, LICENSE_CONFIG.startupTimeoutMs,
      );
      if (activated.error) throw new Error(activated.error);
      const rec = this._recordFromServer(activated.trialStart, activated.trialEnd, activated.trialDurationDays);
      this._saveLocalTrial(rec);
      return { rec, source: 'server' };
    } catch {
      if (local) return { rec: local, source: 'local' };
      const nowSeconds = this._nowSeconds();
      // The service's last reported duration beats this build's constant:
      // two independently hardcoded trial lengths is how they end up
      // disagreeing.
      const durationDays = localDuration || LICENSE_CONFIG.trial.durationDays;
      const rec = { trialStart: nowSeconds, trialEnd: nowSeconds + durationDays * 86400, durationDays };
      this._saveLocalTrial(rec);
      return { rec, source: 'local' };
    }
  }

  async _syncTrial() {
    const { rec, source } = await this._resolveTrial();
    this._setState({ ...this._state, trial: this._trialState(rec, source, this._nowSeconds()) });
  }

  // ── License ─────────────────────────────────────────────────────────────
  /** The legacy path: a license key the user was emailed, exchanged for a
   *  token by the service's default route. */
  async activate(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) return { success: false, error: 'licenseKey required' };

    try {
      const data = await this._request('POST', '', { licenseKey: key, appId: APP_ID });
      if (!data.valid || !data.token) {
        return {
          success: false,
          code: isAppMismatch(data) ? APP_MISMATCH : undefined,
          error: data.error || 'License key not accepted',
        };
      }
      return this._adoptToken(data.token);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** Verify a token the service issued, store it, and move to its state. */
  _adoptToken(token) {
    const payload = verifyToken(token);
    if (!payload) {
      // Either the service is signing with a different secret than this build
      // carries, or something rewrote the response.
      return { success: false, error: 'The license token did not verify' };
    }
    if (!tokenIsOurs(payload)) {
      // A token the service scoped to another app. It verifies — same account,
      // same signing secret — so only the appId tells them apart, and adopting
      // it would licence this app off someone else's purchase.
      return {
        success: false,
        code: APP_MISMATCH,
        error: `This license belongs to ${payload.appId}, not ${APP_ID}`,
      };
    }
    const nowSeconds = this._nowSeconds();
    this._saveToken(token);
    this._saveMaxSeenTs(nowSeconds);
    this._applyLicense(payload, nowSeconds);
    this._startRefreshTimer();
    return { success: true, state: this._state };
  }

  async deactivate() {
    this._deleteToken();
    this._applyLicense(null, this._nowSeconds());
    return { success: true };
  }

  /**
   * Re-check what this app is entitled to.
   *
   * The trial is re-synced unconditionally — this doubles as its retry path
   * for a device that first launched offline. A stored license is then
   * re-verified by exchanging the key inside it for a fresh token, which is
   * what picks up a renewal bought elsewhere and pushes the expiry out.
   *
   * A failure is deliberately silent: the stored token stays valid until it
   * expires, and the grace period is there precisely so an unreachable
   * service does not read as an expiry.
   */
  async refresh() {
    await this._syncTrial().catch(() => {});

    const token = this._loadToken();
    const payload = token ? verifyToken(token) : null;
    if (payload && !tokenIsOurs(payload)) {
      return {
        success: false,
        code: APP_MISMATCH,
        error: `This license belongs to ${payload.appId}, not ${APP_ID}`,
      };
    }
    if (!payload || !payload.licenseKey) return { success: false, error: 'no license to refresh' };

    try {
      const data = await this._request('POST', '', { licenseKey: payload.licenseKey, appId: APP_ID });
      if (!data.valid || !data.token) {
        return {
          success: false,
          code: isAppMismatch(data) ? APP_MISMATCH : undefined,
          error: data.error || 'not accepted',
        };
      }
      return this._adoptToken(data.token);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Plans and payment ───────────────────────────────────────────────────
  /**
   * The plans, from the service.
   *
   * The service computes prices from its own configuration and is the only
   * place they are decided; `fallbackPlans()` exists so the page can still
   * render offline, and says so to the caller.
   */
  async getPlans() {
    try {
      const data = await this._request('GET', `plans?${query({})}`);
      if (Array.isArray(data.plans) && data.plans.length) {
        return { plans: data.plans, source: 'server' };
      }
      throw new Error(data.error || 'no plans');
    } catch {
      return { plans: fallbackPlans(), source: 'fallback' };
    }
  }

  /**
   * The payment methods that are actually usable right now.
   *
   * Which ones exist depends on what the service has credentials for, so it
   * decides — the client offering a method that fails at checkout is worse
   * than offering fewer.
   */
  async getPaymentMethods(lang = 'zh-CN') {
    try {
      const data = await this._request('GET', `payment-methods?${query({ lang })}`);
      if (Array.isArray(data.methods)) return { methods: data.methods, source: 'server' };
      throw new Error(data.error || 'no methods');
    } catch {
      return { methods: [], source: 'fallback' };
    }
  }

  async createOrder(planId, method) {
    if (!PAYMENT_METHODS.includes(method)) {
      return { error: `unknown payment method: ${method}` };
    }
    const userId = this.getUserId();
    try {
      // The service stores the appId on the order, which is how the payment
      // webhook knows which app's license to issue when it settles — long
      // after this process has stopped watching.
      const data = await this._request('POST', 'create-order', { planId, method, userId, appId: APP_ID });
      return isAppMismatch(data) ? { ...data, code: APP_MISMATCH } : data;
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Where an order has got to, adopting the license as soon as it is paid.
   *
   * The renderer polls this. Settling happens in the service's webhook, so
   * the token appears here without the app having to be told twice.
   */
  async orderStatus(orderId) {
    const userId = this.getUserId();
    try {
      const data = await this._request('GET', `order-status?${query({ orderId, userId })}`);
      if (data.status === 'paid' && data.token) {
        const adopted = this._adoptToken(data.token);
        // A token that was not adopted carries the reason with it: the renderer
        // has to word "paid, but for another app" differently from "paid".
        const refusal = adopted.success ? null : { code: adopted.code, error: adopted.error };
        return { ...data, licensed: adopted.success, ...refusal, state: this._state };
      }
      return isAppMismatch(data) ? { ...data, code: APP_MISMATCH } : data;
    } catch (err) {
      return { error: err.message };
    }
  }

  async paymentHistory() {
    const userId = this.getUserId();
    try {
      const data = await this._request('GET', `payment-history?${query({ userId })}`);
      return Array.isArray(data.orders) ? data.orders : [];
    } catch {
      return [];
    }
  }

  /** Whether a paid license is in force. The trial is deliberately not part
   *  of this: what a trial unlocks is the renderer's decision, and having two
   *  places answer it is how they come to disagree. */
  isLicensedNow() {
    return isLicensed(this._state.status);
  }
}

module.exports = {
  SubscriptionMonitor, NO_TRIAL, APP_MISMATCH, isAppMismatch, tokenIsOurs,
  TOKEN_FILE, TRIAL_FILE, TS_FILE, ANON_ID_FILE,
};
