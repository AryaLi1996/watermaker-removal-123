'use strict';

/**
 * An anonymous, hardware-derived id for this machine.
 *
 * Its only job is to stop one computer claiming the free trial repeatedly, so
 * it is derived from signals that survive a reinstall — the MAC addresses,
 * the platform and the architecture — rather than generated fresh. It is not
 * a secret and not a login: the anonymous *payment* id is a separate value
 * (`.anon_id`), because that one only has to correlate a person's own orders
 * and has no reason to be tied to hardware.
 *
 * The format has to satisfy the service's `_DEVICE_ID_RE`
 * (`^[A-Za-z0-9_-]{16,128}$`), which a SHA-256 hex digest and a UUID both do.
 */

const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVICE_ID_FILE = '.device_id';

/**
 * Something stable about this machine, or null on a host that reports no
 * usable adapter — a VM with a stripped interface list, for instance.
 */
function hardwareSignal(os) {
  const macs = Object.values(os.networkInterfaces() || {})
    .flat()
    .filter(Boolean)
    // Loopback tells us nothing, and some platforms report all-zeroes where
    // there is no real adapter.
    .filter((iface) => !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00')
    .map((iface) => iface.mac.toLowerCase());

  if (macs.length === 0) return null;
  return `${Array.from(new Set(macs)).sort().join(',')}|${os.platform()}|${os.arch()}`;
}

let cached = null;

/**
 * This machine's id, creating and persisting one on first call.
 *
 * A previously stored id always wins, so an id that was once a random UUID —
 * granted on a host with no MAC to hash — stays that UUID rather than
 * silently becoming a different device the next time an adapter appears.
 */
function getDeviceId(userDataDir, os = require('os')) {
  if (cached) return cached;

  const idPath = path.join(userDataDir, DEVICE_ID_FILE);
  try {
    const stored = fs.readFileSync(idPath, 'utf8').trim();
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // Nothing stored yet.
  }

  const signal = hardwareSignal(os);
  // A random id is the accepted fallback: it just will not survive a
  // reinstall, which is a smaller problem than refusing to start a trial.
  const id = signal ? createHash('sha256').update(signal).digest('hex') : randomUUID();

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(idPath, id, { mode: 0o600 });
  } catch {
    // Best effort: the id is still usable for this session.
  }

  cached = id;
  return id;
}

/** Test seam: forget the memoised id. */
function resetCache() {
  cached = null;
}

module.exports = { DEVICE_ID_FILE, hardwareSignal, getDeviceId, resetCache };
