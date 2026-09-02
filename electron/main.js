'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, net, protocol, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { Readable } = require('stream');
const system = require('./system');
const { SubscriptionMonitor } = require('./subscription-monitor');
const { createRequest } = require('./license-request');
const {
  LICENSE_CONFIG, usingDefaultSigningSecret, manualActivationEnabled, demoLicenseEnabled,
  DEMO_DURATION_DAYS,
} = require('./license-config');
const { DEMO_DISABLED } = require('./demo-license');
const temporalUsage = require('./temporal-usage');

/**
 * Marks a failure this process raised itself, as a translation key rather
 * than English prose. `classifyError` in renderer/src/errors.ts strips it and
 * translates the rest; the two ends have to agree on the string.
 */
const OWN_MESSAGE_PREFIX = 'i18n:';

const isDev = process.env.NODE_ENV === 'development';

/**
 * The product name, as the OS should show it.
 *
 * English here on purpose: this names the application to the system — the
 * window before its page loads, the macOS menu bar, the About dialog — and
 * that happens before any renderer exists to say which language the user
 * reads. Inside the app the name is translated (`app.name` in the i18n
 * resources), and the page title takes over as soon as it loads.
 */
const PRODUCT_NAME = 'SmoothVoice Watermark Remover';

// ─── Preview media protocol ───────────────────────────────────────
/**
 * Preview stills and clips are files the backend writes to a temp directory
 * and the renderer then displays. Handing them over as file:// URLs meant
 * turning webSecurity off in development, because a page served from
 * http://localhost:5173 may not read file:// — and that switch disables the
 * same-origin policy for everything else on the page too.
 *
 * They travel over the app's own scheme instead. It serves exactly the files
 * this process published — the still the canvas is showing and the clips of
 * the job in flight — so the renderer can no longer ask for an arbitrary path
 * the way file:// allowed, in development or in the packaged app.
 *
 * The renderer builds these URLs with `mediaUrl` in renderer/src/utils.ts;
 * this side only ever parses them.
 *
 * Must be registered before the app is ready, hence the placement here.
 */
const MEDIA_SCHEME = 'wm-media';

protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_SCHEME,
  // `stream` is what lets <video> range-request the preview clip.
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

/**
 * Resolve the Python binary path cross-platform.
 * WATERMARK_PYTHON overrides it (used by the E2E suite, and handy for pointing
 * at an interpreter outside the bundled venv).
 */
function getPythonPath() {
  if (process.env.WATERMARK_PYTHON) return process.env.WATERMARK_PYTHON;
  const base = path.join(__dirname, '..', 'backend', '.venv');
  return process.platform === 'win32'
    ? path.join(base, 'Scripts', 'python.exe')
    : path.join(base, 'bin', 'python');
}

/** Path to the backend dispatcher script. */
function backendScript() {
  return process.env.WATERMARK_BACKEND || path.join(__dirname, '..', 'backend', 'main.py');
}

/** Path to the frozen backend shipped beside a packaged app. */
function bundledBackend() {
  return path.join(system.bundledBinaryDir(), system.executableName('watermark-backend'));
}

/**
 * How to launch the backend for this build.
 *
 * A packaged app has neither the venv (excluded from the build) nor a real
 * file for backend/main.py (it lives inside app.asar, which is a virtual
 * filesystem a child process cannot read). So the release ships a frozen
 * single-file backend and runs that; development keeps using the venv.
 */
function backendCommand() {
  // An explicit interpreter always wins — the E2E suite drives its own stub.
  if (process.env.WATERMARK_PYTHON) {
    return { command: process.env.WATERMARK_PYTHON, args: [backendScript()] };
  }
  if (app.isPackaged) {
    return { command: bundledBackend(), args: [] };
  }
  return { command: getPythonPath(), args: [backendScript()] };
}

/**
 * Environment for the backend child.
 *
 * A release can ship ffmpeg/ffprobe beside the frozen backend; point the child
 * at them so an installed app does not depend on the user having ffmpeg on
 * PATH. When they are absent the backend falls back to PATH by itself.
 */
function backendEnv() {
  const env = { ...process.env };
  if (!app.isPackaged) return env;

  const dir = system.bundledBinaryDir();
  const ffmpeg = path.join(dir, system.executableName('ffmpeg'));
  const ffprobe = path.join(dir, system.executableName('ffprobe'));
  if (fs.existsSync(ffmpeg)) env.FFMPEG_PATH = ffmpeg;
  if (fs.existsSync(ffprobe)) env.FFPROBE_PATH = ffprobe;
  return env;
}

/** Explain a missing backend in terms of what the user can actually do. */
function missingBackendMessage(command) {
  return app.isPackaged
    ? `Bundled backend not found at ${command}. This build is incomplete — please reinstall the app.`
    : `Python environment not found at ${command}. Run ./dev.sh to create it.`;
}

/**
 * The job currently running, if any: { child, isExport, cancelled, superseded }.
 *
 * A record rather than a bare child process, because the exit handler has to
 * know why the process ended and whether it is still the current job — a
 * superseded preview must not clear the export that replaced it.
 */
let currentJob = null;

/** Is this payload a full export, as opposed to one of the preview probes? */
function isExportJob(payload) {
  return !payload?.mode || payload.mode === 'full';
}

/**
 * Preview clip MP4s the backend wrote outside its own temp_dir. They are
 * consumed once, so the next job start is free to delete them.
 */
const previewClips = new Set();

/**
 * The preview still the canvas is currently drawing, or null.
 *
 * It is kept apart from the clips because its lifetime is different: the
 * canvas reads it from disk for as long as the video stays loaded, including
 * on a remount after the user closes a preview clip. Purging it with the
 * clips left that remount with a deleted file, and the user with a blank
 * canvas and no way back short of reloading the video.
 */
let previewStill = null;

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }
}

/** Adopt a new still, dropping the one it replaces. */
function retainPreviewStill(filePath) {
  if (previewStill && previewStill !== filePath) removeFile(previewStill);
  previewStill = filePath;
}

/**
 * Is this one of the files we published? Everything else is a 404 — the whole
 * point of the scheme is that it is not a general-purpose file reader.
 */
function isPublishedMedia(filePath) {
  return (previewStill !== null && filePath === previewStill) || previewClips.has(filePath);
}

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Serve a file, honouring a Range request.
 *
 * <video> asks for ranges, and answering every one of them with the whole file
 * leaves the element unable to seek — which a looping preview clip does on
 * every pass.
 */
function fileResponse(filePath, size, type, rangeHeader) {
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  const match = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader ?? '').trim());

  if (match) {
    const [, rawStart, rawEnd] = match;
    let start;
    let end;
    if (rawStart === '') {
      // A suffix range — the last N bytes.
      const n = Number(rawEnd);
      start = n > 0 ? Math.max(0, size - n) : size;
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${size}` },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { ...headers, 'content-length': String(size) },
  });
}

/** Answer one wm-media:// request. */
function handleMediaRequest(request) {
  let filePath;
  try {
    filePath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!filePath || !isPublishedMedia(filePath)) return new Response(null, { status: 404 });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // Published but already gone: a clip purged by the next job start.
    return new Response(null, { status: 404 });
  }
  if (!stat.isFile()) return new Response(null, { status: 404 });

  const type = MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  return fileResponse(filePath, stat.size, type, request.headers.get('range'));
}

/**
 * The live window to deliver job events to. Resolved on every send so the
 * handlers keep working after the window is closed and re-created (macOS
 * 'activate'), instead of holding a destroyed reference.
 */
function targetWindow() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

function send(channel, ...args) {
  const win = targetWindow();
  if (win) win.webContents.send(channel, ...args);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // What the frame is painted before the page has loaded. The renderer's
    // theme preference lives in its own localStorage, which this process
    // cannot read, so the system setting is the best guess available — right
    // for "follow the system", and a brief flash for someone who overrode it.
    // The values are the --bg tokens from renderer/src/index.css.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#fafafa',
    // Replaced by the page's own <title> once it loads, which is how the
    // window ends up named in the language the user reads.
    title: app.getName(),
    // macOS only, and deliberately so. `hiddenInset` drops the system title
    // bar but leaves the close/minimise/zoom buttons floating over the top
    // left of the page, so the renderer has to keep that corner clear —
    // renderer/src/titlebar.ts does. Windows and Linux keep their native
    // frame, where the controls sit outside the web contents and nothing the
    // app draws can land on top of them. The option is a no-op off macOS
    // anyway; naming the platform is what stops it being read as a
    // cross-platform custom title bar that was never built.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only reaches for contextBridge and ipcRenderer, both of
      // which a sandboxed preload keeps. Nothing here needs a full Node.
      sandbox: true,
    },
  });

  // Full screen takes the traffic lights away, so the space the top bar holds
  // open for them has to close again — otherwise the app name sits in a gap
  // with nothing in it. Pushed rather than polled: there is no CSS media
  // query for "this window is full screen".
  const sendFullScreen = () => {
    if (!win.isDestroyed()) win.webContents.send('window:full-screen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  // A window restored into full screen is already in it when the page loads,
  // and fires neither event.
  win.webContents.on('did-finish-load', sendFullScreen);

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }

  return win;
}

/** Delete the preview clips of previous jobs. The still is left in place. */
function purgePreviewClips() {
  for (const f of previewClips) removeFile(f);
  previewClips.clear();
}

/** Everything the backend left behind, for shutdown. */
function purgeTempFiles() {
  purgePreviewClips();
  if (previewStill) {
    removeFile(previewStill);
    previewStill = null;
  }
}

/**
 * Parse one stdout line of the backend protocol and forward it to the renderer.
 * `ctx` accumulates per-job state (the announced output path, whether the
 * backend already reported an error).
 */
function handleBackendLine(line, ctx) {
  // ── Check specific STATE subtypes BEFORE the generic STATE handler ──
  const previewMatch = line.match(/^STATE:preview_ready:(.+)$/);
  if (previewMatch) {
    const previewPath = previewMatch[1].trim();
    // A still stays readable while the canvas shows it; a clip is transient.
    if (ctx.mode === 'preview_frame') retainPreviewStill(previewPath);
    else previewClips.add(previewPath);
    send('job:preview-ready', previewPath);
    return;
  }
  const metaMatch = line.match(/^STATE:meta:(.+)$/);
  if (metaMatch) {
    try {
      send('job:meta', JSON.parse(metaMatch[1].trim()));
    } catch { /* ignore malformed meta */ }
    return;
  }
  const doneMatch = line.match(/^STATE:done:(.+)$/);
  if (doneMatch) {
    // Remember the real output path; job:done fires from the 'close' event below,
    // once the process has actually exited.
    ctx.outputPath = doneMatch[1].trim();
    return;
  }
  // Must precede the generic STATE match below, which would otherwise show
  // the raw line to the user as a status label.
  const fallbackMatch = line.match(/^STATE:temporal_fallback:(\d+)\/(\d+)$/);
  if (fallbackMatch) {
    send('job:temporal-fallback', {
      degraded: Number(fallbackMatch[1]),
      total: Number(fallbackMatch[2]),
    });
    return;
  }
  // Same reason: these carry a free-text detail that must not reach the
  // status line as a label.
  const deepFallbackMatch = line.match(/^STATE:deep_fallback:(.*)$/);
  if (deepFallbackMatch) {
    send('job:deep-notice', { kind: 'fallback', detail: deepFallbackMatch[1].trim() });
    return;
  }
  const deepQualityMatch = line.match(/^STATE:deep_quality:(.*)$/);
  if (deepQualityMatch) {
    send('job:deep-notice', { kind: 'quality', detail: deepQualityMatch[1].trim() });
    return;
  }
  const progressMatch = line.match(/^PROGRESS:([\d.]+)$/);
  if (progressMatch) {
    send('job:progress', parseFloat(progressMatch[1]));
    return;
  }
  const stateMatch = line.match(/^STATE:(.+)$/);
  if (stateMatch) {
    send('job:state', stateMatch[1]);
    return;
  }
  if (line.startsWith('ERROR:')) {
    ctx.errored = true;
    send('job:error', line.slice(6));
    return;
  }
  if (line.startsWith('DEBUG:')) {
    console.log('[python debug]', line.slice(6));
  }
}

// ─── Dialog: open video file ──────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(targetWindow(), {
    title: 'Select a Video File',
    filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

// ─── Dialog: save output file ─────────────────────────────────────
ipcMain.handle('dialog:saveFile', async (_event, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(targetWindow(), {
    title: 'Save Processed Video',
    defaultPath: defaultName || 'output_processed.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  return canceled ? null : filePath;
});

// ─── Open folder in Finder / Explorer ────────────────────────────
ipcMain.handle('shell:openPath', (_event, filePath) => system.revealInFileManager(filePath));

// ─── Host platform facts and notifications ───────────────────────
// The GPU probe shells out to the driver, so this handler is async while
// platformInfo() stays synchronous: the renderer awaits one object either way.
ipcMain.handle('system:info', async () => ({
  ...system.platformInfo(),
  gpu: await system.gpuInfo(),
}));
ipcMain.handle('system:tempDir', () => system.tempDir());
ipcMain.handle('system:notify', (_event, title, body) => system.notify(title, body));

// ─── Subscription: the shared license service ────────────────────
// Licensing lives with the service described in docs/LICENSE_SERVICE.md —
// one Lambda over three DynamoDB tables, shared with the other app on the
// same account. This process holds the state machine (docs, and
// subscription-monitor.js) and the renderer asks it, so the trial is
// resolved once per launch however many windows are open.
let monitor = null;

function getMonitor() {
  if (!monitor) {
    monitor = new SubscriptionMonitor({
      userDataDir: app.getPath('userData'),
      request: createRequest(net),
    });
    // The renderer does not poll for expiry: a trial running out, a payment
    // settling or a background refresh all push the new state.
    monitor.on('state-change', (state) => {
      send('license:state-changed', state);
      // Paying clears whatever was spent before paying: the allowance is a
      // nudge toward subscribing, and it has done its job.
      if (monitor.isLicensedNow()) temporalUsage.resetUses(usageDir());
      sendTemporalUsage();
    });
  }
  return monitor;
}

ipcMain.handle('license:getState', () => getMonitor().getState());
ipcMain.handle('license:activate', (_event, licenseKey) => getMonitor().activate(licenseKey));
ipcMain.handle('license:deactivate', () => getMonitor().deactivate());
ipcMain.handle('license:refresh', () => getMonitor().refresh());

// The demo licence is enforced here rather than in the state machine: a
// renderer that has been told the entry does not exist can still send the
// message, and a build that does not offer demos must refuse it rather than
// trust that nobody asked. On unless the build sets VITE_DISABLE_DEMO_LICENSE
// (or this process's DISABLE_DEMO_LICENSE) — see license-config.js.
// There is no activation code any more: the service grants a demo on "this
// device has not taken one for this app", so there is nothing for the
// renderer to pass and nothing shipped in the build to guess.
ipcMain.handle('license:activateDemo', () => (
  demoLicenseEnabled
    ? getMonitor().activateDemo()
    : { success: false, code: DEMO_DISABLED, error: 'demo licenses are disabled in this build' }
));
// The service's answer, not just the cached one — a device that deleted its
// local record is told again here that its demo is spent.
ipcMain.handle('license:demoState', () => (
  demoLicenseEnabled
    ? getMonitor().demoStatus()
    : { used: false, durationDays: DEMO_DURATION_DAYS, issuedAt: null, expiresAt: null }
));
ipcMain.handle('license:getConfig', () => ({
  // Enough for the renderer to explain itself, and nothing secret: the
  // signing secret stays in this process.
  verificationUrl: LICENSE_CONFIG.verificationUrl,
  // Which app the service scopes this client's trial and subscription to.
  // Worth surfacing: a build with the wrong one looks exactly like a build
  // whose subscription vanished.
  appId: LICENSE_CONFIG.appId,
  gracePeriodDays: LICENSE_CONFIG.gracePeriodDays,
  trialDurationDays: LICENSE_CONFIG.trial.durationDays,
  orderPollIntervalMs: LICENSE_CONFIG.orderPollIntervalMs,
  orderPollTimeoutMs: LICENSE_CONFIG.orderPollTimeoutMs,
  usingDefaultSigningSecret,
  // Whether to show the box for typing a licence in by hand. Off unless
  // ENABLE_MANUAL_ACTIVATION=true — see license-config.js.
  manualActivationEnabled,
  // Whether this build offers a demo licence. On unless the build sets
  // VITE_DISABLE_DEMO_LICENSE=true.
  demoLicenseEnabled,
  demoDurationDays: DEMO_DURATION_DAYS,
}));

// ─── The trial's allowance of temporal exports ───────────────────
// Enforced here rather than in the renderer: a disabled button is a courtesy
// to the user, not a limit, and the renderer is the one process that a
// determined user can talk to directly. See electron/temporal-usage.js for
// what counts and why previews do not.
function usageDir() {
  return app.getPath('userData');
}

function licenseContext() {
  const monitor = getMonitor();
  return {
    licensed: monitor.isLicensedNow(),
    // The allowance belongs to the trial. An ended trial with no subscription
    // gets the method back the way it was before: locked.
    trialActive: !!monitor.getState().trial?.active,
  };
}

function temporalUsageState() {
  return temporalUsage.usageState(usageDir(), licenseContext());
}

/** Push the allowance to the renderer, so the sidebar's count moves the
 *  moment an export starts rather than on the next poll. */
function sendTemporalUsage() {
  send('temporal:usage', temporalUsageState());
}

ipcMain.handle('temporal:usage', () => temporalUsageState());

ipcMain.handle('payment:getPlans', () => getMonitor().getPlans());
ipcMain.handle('payment:getMethods', (_event, lang) => getMonitor().getPaymentMethods(lang));
ipcMain.handle('payment:createOrder', (_event, planId, method) => getMonitor().createOrder(planId, method));
ipcMain.handle('payment:orderStatus', (_event, orderId) => getMonitor().orderStatus(orderId));
ipcMain.handle('payment:history', () => getMonitor().paymentHistory());

// Checkout pages are the provider's, not ours, so they are never loaded into
// the app's own window: `external` opens the system browser, and `embedded`
// gets a plain child window with no preload and no node access — it shows a
// QR code and must not be able to reach anything of ours.
let paymentWindow = null;

function closePaymentWindow() {
  if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.close();
  paymentWindow = null;
}

ipcMain.handle('payment:openExternal', async (_event, url) => {
  if (!/^https:\/\//i.test(String(url || ''))) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('payment:openEmbedded', (_event, url) => {
  if (!/^https:\/\//i.test(String(url || ''))) return false;
  closePaymentWindow();
  paymentWindow = new BrowserWindow({
    width: 480,
    height: 720,
    parent: targetWindow() ?? undefined,
    modal: false,
    title: app.getName(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#fafafa',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  paymentWindow.on('closed', () => {
    paymentWindow = null;
    // The renderer keeps polling either way — the window closing is not the
    // same as the payment failing — but it should stop showing a dialog for
    // a window that is no longer there.
    send('payment:window-closed');
  });
  void paymentWindow.loadURL(url);
  return true;
});

ipcMain.handle('payment:closeEmbedded', () => {
  closePaymentWindow();
  return true;
});

// ─── Start full processing job ────────────────────────────────────
ipcMain.handle('job:start', (_event, payload) => {
  const isExport = isExportJob(payload);

  // The trial's allowance of temporal exports. Checked before anything is
  // spawned or cleaned up, so a refused export leaves the previous job's
  // preview exactly where it was.
  if (isExport && payload?.method === 'temporal') {
    const usage = temporalUsageState();
    if (!usage.allowed) {
      send('job:error', `${OWN_MESSAGE_PREFIX}errors.temporalTrialExhausted`);
      return false;
    }
  }

  if (currentJob) {
    // Previews are short probes the app starts on its own (a still on load, a
    // one-second clip on request). If one is still running when the user hits Export,
    // the export wins — refusing it silently would look like a dead button.
    if (isExport && !currentJob.isExport) {
      currentJob.superseded = true;
      currentJob.child.kill('SIGTERM');
    } else {
      return false;
    }
  }

  // Clean up the previous job's preview clip before starting.
  purgePreviewClips();

  const { command, args } = backendCommand();
  // Only a resolved path can be checked up front; a bare command name is left
  // to the OS (and reported through the spawn 'error' handler below).
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    send('job:error', missingBackendMessage(command));
    return false;
  }

  const child = spawn(command, args, { env: backendEnv() });
  const job = { child, isExport, cancelled: false, superseded: false };
  currentJob = job;

  // Counted once the run is under way. Counting before the spawn would charge
  // for an export that never started because the backend is missing.
  if (isExport && payload?.method === 'temporal') {
    temporalUsage.recordUse(usageDir(), licenseContext());
    sendTemporalUsage();
  }

  // Per-job state shared with the line parser.
  const ctx = { outputPath: null, errored: false, mode: payload?.mode ?? 'full' };

  // stdout arrives in arbitrary chunks; keep the trailing partial line buffered
  // so a message split across two chunks is still parsed correctly.
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    // A superseded preview may still be draining; its output is no longer ours.
    if (currentJob !== job) return;
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) handleBackendLine(trimmed, ctx);
    }
  });

  child.stderr.on('data', (chunk) => {
    console.error('[python stderr]', chunk.toString());
  });

  child.on('error', (err) => {
    if (currentJob === job) currentJob = null;
    send('job:error', `Failed to start Python: ${err.message}`);
  });

  child.stdin.on('error', () => { /* process died before the payload was written */ });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  child.on('close', (code) => {
    // Only clear the slot if this job still owns it: a superseded preview
    // exits after the export that replaced it has already started.
    if (currentJob === job) currentJob = null;

    if (job.cancelled || job.superseded) return;

    // Flush any final line that arrived without a trailing newline.
    const tail = stdoutBuffer.trim();
    stdoutBuffer = '';
    if (tail) handleBackendLine(tail, ctx);

    // Two things must not reach job:done, because both would flip the UI to
    // "Export complete" over something that is not a finished export: a
    // preview job, which reports through job:preview-ready and carries its own
    // temp path; and a job that printed an ERROR line, whatever it then exits
    // with — that line is the backend's verdict on a file it never wrote.
    if (code === 0 && !ctx.errored) {
      if (job.isExport) send('job:done', ctx.outputPath ?? payload?.outputPath ?? null);
    } else if (!ctx.errored) {
      send('job:error', `Process exited with code ${code}`);
    }
  });

  return true;
});

// ─── Cancel / abort job ───────────────────────────────────────────
ipcMain.handle('job:cancel', () => {
  if (!currentJob) return false;
  currentJob.cancelled = true;
  currentJob.child.kill('SIGTERM');
  // The slot is cleared by the 'close' handler, so a cancelled process is
  // still reaped before a new job can start.
  return true;
});

/**
 * Check for updates against the release feed electron-builder publishes.
 *
 * Only meaningful in a packaged build that carries an app-update.yml; a
 * development run or a build made without a publish provider has no feed, so
 * this stays quiet rather than reporting a failure the user cannot act on.
 */
function initAutoUpdate() {
  if (!app.isPackaged) return;

  const feed = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(feed)) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater unavailable:', err.message);
    return;
  }

  // A failed check is a log line, never a dialog: the app works without it.
  autoUpdater.on('error', (err) => console.warn('[update] check failed:', err.message));
  autoUpdater.on('update-available', (info) => send('update:available', info?.version ?? null));
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', info?.version ?? null));

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn('[update] check failed:', err.message);
  });

  return autoUpdater;
}

// ─── Install a downloaded update ──────────────────────────────────
ipcMain.handle('update:install', () => {
  if (!app.isPackaged) return false;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
    return true;
  } catch (err) {
    console.warn('[update] install failed:', err.message);
    return false;
  }
});

app.whenReady().then(() => {
  // The product name, for the window, the menu bar and the About dialog.
  // package.json's `name` is the npm one — lower case and hyphenated — so
  // without this the app introduces itself as "smoothvoice-watermark-remover".
  app.setName(PRODUCT_NAME);

  // The signing secret is in public source, so a build still using it can
  // have its license tokens forged offline. The service prints the matching
  // warning on its side; this is the client half.
  if (usingDefaultSigningSecret) {
    console.warn(
      '[license] LICENSE_SIGNING_SECRET is not set — this build verifies license '
      + 'tokens with the public default from license-config.js. Tokens can be forged '
      + 'offline. Set it to the same private value as the deployed service before '
      + 'accepting real payments.',
    );
  }

  // Resolving the trial talks to the service, so it is deliberately not
  // awaited: an unreachable service must not hold up the window.
  void getMonitor().initialize().catch((err) => {
    console.warn('[license] could not initialise:', err.message);
  });
  protocol.handle(MEDIA_SCHEME, handleMediaRequest);
  createWindow();
  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop any running job and clean up preview temp files when the app quits.
app.on('before-quit', () => {
  if (monitor) monitor.stop();
  closePaymentWindow();
  if (currentJob) {
    currentJob.cancelled = true;
    currentJob.child.kill('SIGTERM');
    currentJob = null;
  }
  purgeTempFiles();
});
