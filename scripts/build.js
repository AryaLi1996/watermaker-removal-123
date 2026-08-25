#!/usr/bin/env node
/**
 * Preflight for a production build.
 *
 * Checks the things whose absence produces a broken installer rather than a
 * failed build: the Python venv, its dependencies, and the frozen backend the
 * packaged app actually runs.
 *
 * Usage: node scripts/build.js  (or: npm run dist)
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV = path.join(ROOT, 'backend', '.venv');
const PYTHON = IS_WIN
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

function fail(message, hint) {
  console.error(`\n❌ ${message}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
}

/**
 * Run one of this package's npm scripts.
 *
 * Prefers the npm that invoked us (npm_execpath), so the build uses the same
 * npm as the caller; falls back to whatever is on PATH when run bare.
 */
function npmRun(script) {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath)) {
    run(process.execPath, [execpath, 'run', script]);
    return;
  }
  run(IS_WIN ? 'npm.cmd' : 'npm', ['run', script], { shell: IS_WIN });
}

if (!fs.existsSync(PYTHON)) {
  fail(
    `Python virtual environment not found at ${VENV}`,
    'Create it with:  python3 -m venv backend/.venv  (or run ./dev.sh)',
  );
}

console.log('📦 Installing Python dependencies...');
run(PYTHON, ['-m', 'pip', 'install', '-q', '-r', path.join('backend', 'requirements.txt')]);

console.log('🐍 Freezing the Python backend...');
run(PYTHON, [path.join('scripts', 'build_backend.py')]);

const DIST = path.join(ROOT, 'backend', 'dist');
const frozen = path.join(DIST, IS_WIN ? 'watermark-backend.exe' : 'watermark-backend');
if (!fs.existsSync(frozen)) {
  fail(`Frozen backend missing at ${frozen}`, 'The packaged app cannot run without it.');
}

// Ship ffmpeg alongside the backend when this machine has it, so the installed
// app does not require the user to have ffmpeg on their PATH. Without it the
// build still succeeds — the app just falls back to the user's own ffmpeg.
console.log('🎬 Bundling ffmpeg...');
const missing = [];
for (const tool of ['ffmpeg', 'ffprobe']) {
  const binary = tool + (IS_WIN ? '.exe' : '');
  let source;
  try {
    const which = IS_WIN ? 'where' : 'which';
    source = execFileSync(which, [tool], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    source = '';
  }
  if (!source || !fs.existsSync(source)) {
    missing.push(tool);
    continue;
  }
  fs.copyFileSync(source, path.join(DIST, binary));
  fs.chmodSync(path.join(DIST, binary), 0o755);
  console.log(`   bundled ${tool} from ${source}`);
}
if (missing.length) {
  console.warn(`   ⚠️  ${missing.join(' and ')} not found on PATH — not bundled.`);
  console.warn('      The installed app will need ffmpeg available on the user\'s machine.');
}

console.log('🔨 Building the renderer...');
npmRun('build:renderer');

console.log('\n✅ Preflight complete — ready for electron-builder.');
