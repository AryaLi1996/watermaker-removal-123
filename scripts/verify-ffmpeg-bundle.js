#!/usr/bin/env node
/**
 * Prove this machine can bundle an ffmpeg that runs — without building anything.
 *
 * `npm run dist` already refuses to package a copy that cannot start, but a
 * release only happens on a tag. That left the one step whose failure ships a
 * dead installer unexercised on every pull request, and it is not a
 * hypothetical: a chocolatey shim reached users twice, each time exiting
 * 4294967295 without a word, and each time the build machine noticed nothing
 * because it had a working ffmpeg of its own and never ran the copy.
 *
 * So this does exactly what the packaging step does — resolve ffmpeg and
 * ffprobe on PATH, copy them (with their libraries, on Windows), then run each
 * copy and require it to identify itself — into a temporary directory that is
 * thrown away afterwards. Seconds, no venv, no PyInstaller, no electron-builder.
 *
 * Stricter than the build in one way, deliberately: the build tolerates an
 * ffmpeg that is simply absent, because the installed app can fall back to the
 * user's own. Here an absent tool is a failure, since the runner is supposed to
 * have installed one and a silently missing tool is how the last two
 * regressions hid.
 *
 * Usage: node scripts/verify-ffmpeg-bundle.js  (or: npm run verify:ffmpeg)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { bundleFfmpeg } = require('./ffmpeg-bundle');

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-bundle-check-'));

let result;
try {
  result = bundleFfmpeg({ dist });
} finally {
  fs.rmSync(dist, { recursive: true, force: true });
}

const { bundled, missing, unusable } = result;

for (const { tool, source } of bundled) {
  console.log(`✅ ${tool} copied from ${source} and ran`);
}

if (!missing.length && !unusable.length) {
  console.log('\n✅ The ffmpeg on PATH bundles into something that runs.');
  process.exit(0);
}

if (unusable.length) {
  console.error('\n❌ The ffmpeg copied into the bundle does not run:');
  for (const line of unusable) console.error(`   ${line}`);
  console.error(
    '\n   PATH is pointing at a launcher rather than the program — chocolatey installs\n'
    + '   one — or at a shared build whose libraries are elsewhere. Shipping this copy\n'
    + '   would make every video fail to load, with nothing on this machine to show for\n'
    + '   it. Install a static ffmpeg and put it on PATH ahead of that one.',
  );
}

if (missing.length) {
  console.error(`\n❌ ${missing.join(' and ')} not found on PATH.`);
  console.error('   The step that installs ffmpeg did not take effect on this runner.');
}

process.exit(1);
