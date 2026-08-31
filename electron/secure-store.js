'use strict';

/**
 * Machine-bound AES-256-GCM for the small files the license system keeps.
 *
 * key = SHA-256(random seed | machine fingerprint | app salt)
 *
 * The seed is on disk; the fingerprint is re-derived at runtime. Copying both
 * the seed and the ciphertext to another machine therefore yields a different
 * key, and GCM's authentication tag turns that into a clean failure rather
 * than garbage plaintext.
 *
 * This is not protection against the machine's owner — they hold everything
 * needed. It raises the cost of the specific thing worth deterring: editing
 * `trial.enc` in a text editor to hand yourself another three days.
 *
 * Layout: nonce(12) | authTag(16) | ciphertext
 */

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join('keys', 'license.key');
const APP_SALT = 'smoothvoice-watermark-remover-v1-license-2026';
const NONCE_LEN = 12;
const TAG_LEN = 16;

function machineFingerprint(os) {
  const cpu = (os.cpus() || [])[0];
  return `${os.hostname()}|${os.platform()}-${os.arch()}|${cpu ? cpu.model : 'unknown-cpu'}`;
}

function deriveKey(seed, os) {
  return createHash('sha256')
    .update(seed)
    .update(Buffer.from(machineFingerprint(os)))
    .update(Buffer.from(APP_SALT))
    .digest();
}

let cachedKey = null;

function getKey(userDataDir, os = require('os')) {
  if (cachedKey) return cachedKey;

  const keyPath = path.join(userDataDir, KEY_FILE);
  try {
    cachedKey = deriveKey(fs.readFileSync(keyPath), os);
    return cachedKey;
  } catch {
    const seed = randomBytes(16);
    try {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, seed, { mode: 0o600 });
    } catch {
      // A seed that could not be saved still encrypts this session; the next
      // launch simply cannot read what this one wrote, which reads as "no
      // license stored" rather than as corruption.
    }
    cachedKey = deriveKey(seed, os);
    return cachedKey;
  }
}

function encrypt(userDataDir, plaintext, os = require('os')) {
  const key = getKey(userDataDir, os);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

/** The plaintext, or null for anything that does not decrypt — a truncated
 *  file, one written on another machine, or one somebody edited. */
function decrypt(userDataDir, buffer, os = require('os')) {
  try {
    if (!buffer || buffer.length < NONCE_LEN + TAG_LEN) return null;
    const key = getKey(userDataDir, os);
    const nonce = buffer.subarray(0, NONCE_LEN);
    const tag = buffer.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const body = buffer.subarray(NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Test seam: forget the memoised key. */
function resetCache() {
  cachedKey = null;
}

module.exports = { KEY_FILE, APP_SALT, machineFingerprint, getKey, encrypt, decrypt, resetCache };
