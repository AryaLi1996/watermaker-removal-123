'use strict';

/**
 * Platform differences, in one place.
 *
 * Everything the app needs from the host OS goes through here so the rest of
 * main.js can stay platform-agnostic, and so the per-platform quirks are
 * written down once.
 */

const { app, shell, Notification } = require('electron');
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
  tempDir,
  revealInFileManager,
  notify,
  platformInfo,
  executableName,
  bundledBinaryDir,
};
