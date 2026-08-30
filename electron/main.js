'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { Readable } = require('stream');
const system = require('./system');

const isDev = process.env.NODE_ENV === 'development';

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
    backgroundColor: '#18181b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only reaches for contextBridge and ipcRenderer, both of
      // which a sandboxed preload keeps. Nothing here needs a full Node.
      sandbox: true,
    },
  });

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
ipcMain.handle('system:info', () => system.platformInfo());
ipcMain.handle('system:tempDir', () => system.tempDir());
ipcMain.handle('system:notify', (_event, title, body) => system.notify(title, body));

// ─── Start full processing job ────────────────────────────────────
ipcMain.handle('job:start', (_event, payload) => {
  const isExport = isExportJob(payload);

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
  if (currentJob) {
    currentJob.cancelled = true;
    currentJob.child.kill('SIGTERM');
    currentJob = null;
  }
  purgeTempFiles();
});
