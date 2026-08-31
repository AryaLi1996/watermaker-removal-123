'use strict';

/**
 * Platform differences, in one place.
 *
 * Everything the app needs from the host OS goes through here so the rest of
 * main.js can stay platform-agnostic, and so the per-platform quirks are
 * written down once.
 */

const { app, shell, Notification } = require('electron');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

/** Where per-user settings and caches belong on this platform. */
function appDataDir() {
  return app.getPath('userData');
}

/** The OS temp directory, which the backend also writes previews into. */
function tempDir() {
  return app.isReady() ? app.getPath('temp') : os.tmpdir();
}

/**
 * Show a file in the platform's file manager.
 *
 * Returns false rather than throwing when there is nowhere to show it — a
 * headless Linux box has no file manager, and the helper it would spawn can
 * outlive the call and keep the app from quitting.
 */
function revealInFileManager(filePath) {
  if (!filePath) return false;
  if (process.env.NODE_ENV === 'test') {
    console.log('[system] reveal suppressed under test:', filePath);
    return false;
  }
  shell.showItemInFolder(filePath);
  return true;
}

/**
 * A desktop notification, for when a long export finishes while the user is
 * in another window.
 *
 * Notifications are a courtesy: an unsupported or refused notification must
 * never interrupt the job that triggered it.
 */
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return false;
    new Notification({ title: String(title ?? ''), body: String(body ?? '') }).show();
    return true;
  } catch (err) {
    console.warn('[system] notification failed:', err.message);
    return false;
  }
}

/**
 * What the renderer may need to know about the host.
 *
 * The core count and memory are here for the renderer's sake: temporal
 * inpainting saturates every core for minutes, and a machine that cannot
 * carry it is better told so than left to discover it halfway through an
 * export.
 */
function platformInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    // Packaged builds resolve resources differently from a dev run.
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
    cpuCount: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/**
 * How long nvidia-smi gets to answer before we treat the machine as having no
 * usable GPU. It is milliseconds on a healthy driver and a hang on a wedged
 * one, and this runs while the window is coming up.
 */
const GPU_PROBE_TIMEOUT_MS = 5000;

/** Remembered for the life of the process — the hardware will not change. */
let gpuPromise = null;

/**
 * What the machine offers a CUDA workload, as the renderer needs it.
 *
 * Asked of the NVIDIA driver rather than of PyTorch: this runs in the Electron
 * main process, which has no Python, and the answer is needed before the
 * backend has ever been started — the sidebar has to know whether to offer
 * the learned engine while the user is still choosing a file. The backend
 * asks again, more authoritatively, before it actually runs anything.
 *
 * Never rejects. No GPU is the common case, not an error.
 */
function gpuInfo() {
  if (gpuPromise) return gpuPromise;

  gpuPromise = new Promise((resolve) => {
    const none = { available: false, name: '', memoryTotalMB: 0 };
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: GPU_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(none);
        // One line per device; the first is the one CUDA picks by default.
        const [name, memory] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
        const mb = Number.parseInt(memory, 10);
        if (!name || !Number.isFinite(mb)) return resolve(none);
        resolve({ available: true, name, memoryTotalMB: mb });
      },
    );
  });
  return gpuPromise;
}

/**
 * Executable name for a bundled tool on this platform.
 * Windows needs the .exe; the others do not.
 */
function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** Directory holding the binaries shipped beside a packaged app. */
function bundledBinaryDir() {
  return path.join(process.resourcesPath, 'backend');
}

module.exports = {
  appDataDir,
  gpuInfo,
  tempDir,
  revealInFileManager,
  notify,
  platformInfo,
  executableName,
  bundledBinaryDir,
};
