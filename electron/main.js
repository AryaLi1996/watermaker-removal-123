'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

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

/** Active Python child process reference (for cancel). */
let activeJob = null;

/** Set while a cancel is in flight, so the exit is not reported as done/error. */
let cancelRequested = false;

/**
 * Temp files created by the Python backend that live outside its own temp_dir
 * (preview PNG frames, preview clip MP4s). We track them here and delete them
 * when the next job starts or the app quits, ensuring no accumulation.
 */
const trackedTempFiles = new Set();

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
      sandbox: false,
      // In dev mode the renderer is served from http://localhost:5173.
      // Without this, Electron blocks file:// URLs (preview frames) as cross-origin.
      webSecurity: !isDev,
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

/** Delete every tracked preview temp file. */
function purgeTempFiles() {
  for (const f of trackedTempFiles) {
    try { fs.unlinkSync(f); } catch { /* file may already be gone */ }
  }
  trackedTempFiles.clear();
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
    trackedTempFiles.add(previewPath); // will be deleted on next job start / app quit
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
ipcMain.handle('shell:openPath', (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// ─── Python quick hello (used during Epic 1 validation) ──────────
ipcMain.handle('python:run', async (_event, payload) => {
  return new Promise((resolve, reject) => {
    const child = spawn(getPythonPath(), [backendScript()]);

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { console.error('[python stderr]', chunk.toString()); });

    // Without this, a missing venv makes the unhandled 'error' event crash main.
    child.on('error', (err) => reject(new Error(`Failed to start Python: ${err.message}`)));

    child.stdin.on('error', () => { /* process died before the payload was written */ });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`Python exited with code ${code}`));
    });
  });
});

// ─── Start full processing job ────────────────────────────────────
ipcMain.handle('job:start', (_event, payload) => {
  if (activeJob) return false; // already running

  // Clean up any preview temp files from the previous job before starting.
  purgeTempFiles();

  const python = getPythonPath();
  // Only a resolved venv path can be checked up front; a bare command name is
  // left to the OS (and reported through the spawn 'error' handler below).
  if (path.isAbsolute(python) && !fs.existsSync(python)) {
    send('job:error', `Python environment not found at ${python}. Run ./dev.sh to create it.`);
    return false;
  }

  cancelRequested = false;
  const child = spawn(python, [backendScript()]);
  activeJob = child;

  // Per-job state shared with the line parser.
  const ctx = { outputPath: null, errored: false };

  // stdout arrives in arbitrary chunks; keep the trailing partial line buffered
  // so a message split across two chunks is still parsed correctly.
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
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
    activeJob = null;
    send('job:error', `Failed to start Python: ${err.message}`);
  });

  child.stdin.on('error', () => { /* process died before the payload was written */ });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  child.on('close', (code) => {
    // Flush any final line that arrived without a trailing newline.
    const tail = stdoutBuffer.trim();
    stdoutBuffer = '';
    if (tail) handleBackendLine(tail, ctx);

    activeJob = null;

    if (cancelRequested) {
      // The user asked for this exit — no done/error event.
      cancelRequested = false;
      return;
    }
    if (code === 0) send('job:done', ctx.outputPath ?? payload?.outputPath ?? null);
    else if (!ctx.errored) send('job:error', `Process exited with code ${code}`);
  });

  return true;
});

// ─── Cancel / abort job ───────────────────────────────────────────
ipcMain.handle('job:cancel', () => {
  if (!activeJob) return false;
  cancelRequested = true;
  activeJob.kill('SIGTERM');
  // activeJob is cleared by the 'close' handler, so a cancelled process is
  // still reaped before a new job can start.
  return true;
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop any running job and clean up preview temp files when the app quits.
app.on('before-quit', () => {
  if (activeJob) {
    cancelRequested = true;
    activeJob.kill('SIGTERM');
    activeJob = null;
  }
  purgeTempFiles();
});
