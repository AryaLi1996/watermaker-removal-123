'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

/** Resolve the Python binary path cross-platform. */
function getPythonPath() {
  const base = path.join(__dirname, '..', 'backend', '.venv');
  return process.platform === 'win32'
    ? path.join(base, 'Scripts', 'python.exe')
    : path.join(base, 'bin', 'python');
}

/** Active Python child process reference (for cancel). */
let activeJob = null;

/**
 * Temp files created by the Python backend that live outside its own temp_dir
 * (preview PNG frames, preview clip MP4s). We track them here and delete them
 * when the next job starts or the app quits, ensuring no accumulation.
 */
const trackedTempFiles = new Set();

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

app.whenReady().then(() => {
  const win = createWindow();

  // ─── Dialog: open video file ────────────────────────────────────
  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select a Video File',
      filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi'] }],
      properties: ['openFile'],
    });
    return canceled ? null : filePaths[0];
  });

  // ─── Dialog: save output file ───────────────────────────────────
  ipcMain.handle('dialog:saveFile', async (_event, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Processed Video',
      defaultPath: defaultName || 'output_processed.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    return canceled ? null : filePath;
  });

  // ─── Open folder in Finder / Explorer ──────────────────────────
  ipcMain.handle('shell:openPath', (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  // ─── Python quick hello (used during Epic 1 validation) ────────
  ipcMain.handle('python:run', async (_event, payload) => {
    return new Promise((resolve, reject) => {
      const python = getPythonPath();
      const child = spawn(python, [path.join(__dirname, '..', 'backend', 'main.py')]);

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { console.error('[python stderr]', chunk.toString()); });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();

      child.on('close', (code) => {
        if (code === 0) resolve(output.trim());
        else reject(new Error(`Python exited with code ${code}`));
      });
    });
  });

  // ─── Start full processing job ──────────────────────────────────
  ipcMain.handle('job:start', (_event, payload) => {
    if (activeJob) return; // already running

    // Clean up any preview temp files from the previous job before starting.
    for (const f of trackedTempFiles) {
      try { fs.unlinkSync(f); } catch { /* file may already be gone */ }
    }
    trackedTempFiles.clear();

    const python = getPythonPath();
    activeJob = spawn(python, [path.join(__dirname, '..', 'backend', 'main.py')]);

    activeJob.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        // ── Check specific STATE subtypes BEFORE the generic STATE handler ──
        const previewMatch = line.match(/^STATE:preview_ready:(.+)$/);
        if (previewMatch) {
          const previewPath = previewMatch[1].trim();
          trackedTempFiles.add(previewPath); // will be deleted on next job start / app quit
          win.webContents.send('job:preview-ready', previewPath);
          continue;
        }
        const metaMatch = line.match(/^STATE:meta:(.+)$/);
        if (metaMatch) {
          try {
            win.webContents.send('job:meta', JSON.parse(metaMatch[1].trim()));
          } catch { /* ignore malformed meta */ }
          continue;
        }
        const doneMatch = line.match(/^STATE:done:(.+)$/);
        if (doneMatch) {
          // job:done fires from the 'close' event below; ignore here
          continue;
        }
        const progressMatch = line.match(/^PROGRESS:([\d.]+)$/);
        if (progressMatch) {
          win.webContents.send('job:progress', parseFloat(progressMatch[1]));
          continue;
        }
        const stateMatch = line.match(/^STATE:(.+)$/);
        if (stateMatch) {
          win.webContents.send('job:state', stateMatch[1]);
          continue;
        }
        if (line.startsWith('ERROR:')) {
          win.webContents.send('job:error', line.slice(6));
          continue;
        }
        if (line.startsWith('DEBUG:')) {
          console.log('[python debug]', line.slice(6));
        }
      }
    });

    activeJob.stderr.on('data', (chunk) => {
      console.error('[python stderr]', chunk.toString());
    });

    activeJob.stdin.write(JSON.stringify(payload));
    activeJob.stdin.end();

    activeJob.on('close', (code) => {
      if (code === 0) win.webContents.send('job:done');
      else if (code !== null) win.webContents.send('job:error', `Process exited with code ${code}`);
      activeJob = null;
    });
  });

  // ─── Cancel / abort job ─────────────────────────────────────────
  ipcMain.handle('job:cancel', () => {
    if (activeJob) {
      activeJob.kill('SIGTERM');
      activeJob = null;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up any lingering preview temp files when the app quits.
app.on('before-quit', () => {
  for (const f of trackedTempFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  trackedTempFiles.clear();
});
