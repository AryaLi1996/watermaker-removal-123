'use strict';

/**
 * An anonymous, stable id for this machine.
 *
 * Its only job is to stop one computer claiming the free trial repeatedly, so
 * everything here is about surviving a reinstall. It is not a secret and not
 * a login: the anonymous *payment* id is a separate value (`.anon_id`),
 * because that one only has to correlate a person's own orders and has no
 * reason to be tied to hardware.
 *
 * Three signals, in falling order of how well they survive:
 *
 *  1. **The operating system's own machine id** — `/etc/machine-id`,
 *     `IOPlatformUUID`, `MachineGuid`. Written once when the OS is installed
 *     and untouched by anything this app does, which is exactly the property
 *     wanted.
 *  2. **A filtered MAC signal**, for a host that reports no machine id.
 *  3. **A random UUID**, which will not survive a reinstall — accepted,
 *     because refusing to start a trial would be worse.
 *
 * This used to be (2) alone, unfiltered, and that is why reinstalling on a
 * physical machine handed out a fresh trial. The signal was every non-
 * loopback adapter present *at that moment*: Docker's bridge, a VPN's tun
 * device, a dock's ethernet, a Bluetooth PAN — and, decisively, Wi-Fi MAC
 * randomisation, which macOS and Windows apply per-network by default. Join a
 * different network between the uninstall and the reinstall and the sorted
 * MAC list differs, the digest differs, and the service quite correctly sees
 * a device it has never met.
 *
 * The format has to satisfy the service's `_DEVICE_ID_RE`
 * (`^[A-Za-z0-9_-]{16,128}$`), which a SHA-256 hex digest and a UUID both do.
 */

const { createHash, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEVICE_ID_FILE = '.device_id';

/** A hung `ioreg` or `reg` must not hold up launch. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Whether a MAC is one the machine made up rather than one burned into an
 * adapter.
 *
 * Bit 1 of the first octet is the "locally administered" flag, and it is set
 * by everything unstable worth excluding: randomised Wi-Fi addresses, Docker
 * and container bridges, most hypervisor adapters, VPN interfaces. A real
 * NIC's burned-in address has it clear. This one test removes the whole class
 * of drift that the name matching below can only guess at.
 */
function isLocallyAdministered(mac) {
  const firstOctet = parseInt(String(mac).slice(0, 2), 16);
  return Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0;
}

/**
 * Interfaces whose presence depends on what is running, not on what the
 * machine is. Matched on name because some of these do hand out globally
 * administered addresses.
 */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|utun|wg|ppp|awdl|llw|zt|ham|Hyper-V|VMware|VirtualBox|Bluetooth|Loopback|Teredo|isatap)/i;

/**
 * Something stable about this machine's hardware, or null when nothing
 * survives the filtering — which is a better answer than a signal that
 * changes when Docker starts.
 */
function hardwareSignal(os) {
  const interfaces = os.networkInterfaces() || {};
  const macs = Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_IFACE.test(name))
    .flatMap(([, addrs]) => (addrs || []).filter(Boolean).map((iface) => ({ ...iface })))
    .filter((iface) => !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00')
    .filter((iface) => !isLocallyAdministered(iface.mac))
    .map((iface) => iface.mac.toLowerCase());

  if (macs.length === 0) return null;
  return `${Array.from(new Set(macs)).sort().join(',')}|${os.platform()}|${os.arch()}`;
}

/** Read a machine id the OS keeps, or null. Every failure is a null: this is
 *  one of three signals, and the next one is right there. */
function readMachineId(platform, deps) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const run = deps.execFileSync || execFileSync;
  const exec = (cmd, args) =>
    String(run(cmd, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }));

  try {
    if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = String(readFileSync(file, 'utf8')).trim();
          if (id) return id;
        } catch { /* try the next one */ }
      }
      return null;
    }

    if (platform === 'darwin') {
      const out = exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match ? match[1] : null;
    }

    if (platform === 'win32') {
      // /reg:64 so a 32-bit build is not silently redirected to the WOW6432
      // view, where MachineGuid is a different value.
      const out = exec('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64',
      ]);
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      return match ? match[1] : null;
    }
  } catch {
    // Not installed, not permitted, timed out, or an OS that has none.
  }
  return null;
}

let cached = null;

/**
 * This machine's id, creating and persisting one on first call.
 *
 * A previously stored id always wins. That is what makes this change safe to
 * ship: every install that already has a `.device_id` keeps it, so nobody's
 * trial resets and nobody is handed a second one. The new derivation applies
 * only where there is nothing stored yet — a genuinely new install, or the
 * reinstall this exists to get right.
 */
function getDeviceId(userDataDir, os = require('os'), deps = {}) {
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

  // Prefixed before hashing so a machine id and a MAC signal can never
  // collide, and so the raw OS identifier never leaves this process.
  const machineId = readMachineId(os.platform(), deps);
  const signal = machineId
    ? `machine:${machineId}|${os.platform()}|${os.arch()}`
    : hardwareSignal(os);

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

module.exports = {
  DEVICE_ID_FILE, hardwareSignal, isLocallyAdministered, readMachineId, getDeviceId, resetCache,
};
