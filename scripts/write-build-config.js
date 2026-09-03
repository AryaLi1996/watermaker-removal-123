#!/usr/bin/env node
'use strict';

/**
 * Bakes build-time licence configuration into the packaged app.
 *
 * The main process is not bundled — `files: ['electron/**']` copies it into
 * the asar as-is — so `process.env.LICENSE_SIGNING_SECRET` inside
 * license-config.js is read on the *end user's* machine at launch, where it
 * is never set. Nothing in the build could reach it. Every packaged build has
 * therefore been verifying licences with `DEFAULT_SIGNING_SECRET`, the public
 * string from this repository, no matter what the release job was given.
 *
 * This writes what the build was told into a file that ships alongside the
 * source, which license-config.js reads when an environment variable does not
 * already answer. It runs before electron-builder on every packaging script.
 *
 * The file is generated, gitignored, and deliberately absent when the build
 * names nothing: a developer's `npm run dist` then behaves exactly as it did,
 * falling back to the public default and warning about it at startup. A stale
 * file from an earlier build is removed rather than left to leak one build's
 * secret into the next.
 *
 * The secret does end up in plaintext inside the app bundle. That is inherent
 * to HMAC with a client that verifies — docs/LICENSE_SERVICE.md says so and
 * names RSA as the fix. Shipping a private string is not worse than shipping
 * the public one; it is the whole difference between a licence that can only
 * be forged by someone who extracted it from a binary and one anybody can
 * forge from a public repository.
 */

const fs = require('fs');
const path = require('path');

/** Written next to the code that reads it, so `electron/**` ships it. */
const OUT = path.join(__dirname, '..', 'electron', 'build-config.json');

/**
 * What a build may set. Names match the environment variables
 * license-config.js already documents, so a value works the same whether it
 * is exported for `npm run dev` or given to the release job.
 */
const KEYS = [
  'LICENSE_SIGNING_SECRET',
  'PREVIOUS_LICENSE_SIGNING_SECRET',
  'LICENSE_URL',
  'LICENSE_APP_ID',
];

function main() {
  const config = {};
  for (const key of KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) config[key] = value;
  }

  if (Object.keys(config).length === 0) {
    // Nothing to bake. Remove any file an earlier build left behind — that
    // one carries a secret this build was not given, and shipping it would
    // be worse than shipping none.
    try {
      fs.unlinkSync(OUT);
      console.log('[build-config] no licence configuration in the environment; removed a stale electron/build-config.json');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.log('[build-config] no licence configuration in the environment; this build will use the public defaults');
    }
    return;
  }

  fs.writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Names only. Printing a secret into a CI log is how it stops being one.
  console.log(`[build-config] baked into electron/build-config.json: ${Object.keys(config).join(', ')}`);
}

main();
