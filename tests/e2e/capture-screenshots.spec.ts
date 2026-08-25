/**
 * Playwright script — captures app screenshots for use in README / docs.
 *
 * Uses the real sample/samplevideo.mp4 so screenshots show actual video content.
 *
 * Run with:
 *   npm run screenshots
 */
import { test } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { SANDBOX_ARGS } from './fixtures/launch-args';

// This spec drives its own Electron sessions rather than using the shared
// fixture, so it needs the same launch arguments.

const ROOT    = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SAMPLE  = path.join(ROOT, 'sample', 'samplevideo.mp4');
const OUTPUT  = path.join(ROOT, 'sample', 'samplevideo-output.mp4');

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

// ──────────────────────────────────────────────────────────────────────────
test('capture: idle (empty) state', async () => {
  const app = await electron.launch({
    args: [...SANDBOX_ARGS, path.join(ROOT, 'electron', 'main.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="empty-state"]', { timeout: 15_000 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT_DIR, '01-idle.png') });
  await app.close();
});

// ──────────────────────────────────────────────────────────────────────────
// One Electron session for all remaining shots: real video, real Python preview,
// real export, real done state.
test('capture: video loaded / processing / done (real sample video)', async () => {
  // A real 300-frame inpaint export. It takes ~20s on a fast workstation but
  // ~1m45s on a 2-core CI runner (measured), so the budget has to suit the
  // slowest machine that runs it, not the fastest.
  test.setTimeout(420_000);
  const app = await electron.launch({
    args: [...SANDBOX_ARGS, path.join(ROOT, 'electron', 'main.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="empty-state"]', { timeout: 15_000 });

  // Mock dialogs AFTER app is fully ready (ipcMain handlers already registered)
  await app.evaluate(
    ({ ipcMain }, { sample, output }) => {
      ipcMain.removeHandler('dialog:openFile');
      ipcMain.removeHandler('dialog:saveFile');
      ipcMain.handle('dialog:openFile', async () => sample);
      ipcMain.handle('dialog:saveFile', async () => output);
    },
    { sample: SAMPLE, output: OUTPUT },
  );

  // ─ Load the video (Python runs preview_frame in the background) ────────────
  await win.getByTestId('empty-state').click();
  await win.waitForSelector('[data-testid="btn-export"]', { timeout: 10_000 });

  // Wait for Python to extract the preview frame — canvas appears once ready
  await win.waitForSelector('canvas', { timeout: 60_000 });
  await win.waitForTimeout(400); // let the canvas settle

  // Screenshot 02: real video frame displayed, method picker visible
  await win.screenshot({ path: path.join(OUT_DIR, '02-loaded.png') });

  // ─ Set the output path ──────────────────────────────────────────────────
  await win.getByTestId('browse-output').click();
  await win.waitForSelector('[data-testid="btn-export"]:not([disabled])', { timeout: 5_000 });
  await win.waitForTimeout(200);

  // Screenshot 03: ready to export — Export button bright, output filename shown
  await win.screenshot({ path: path.join(OUT_DIR, '03-ready-to-export.png') });

  // The default selection box already sits over the watermark strip in this
  // sample, so the export needs no ROI override. (An earlier attempt to patch
  // window.electronAPI.startJob from the page did nothing: contextBridge
  // exposes a frozen object, so the assignment silently failed.)

  // ─ Start the real export job ────────────────────────────────────────────
  await win.getByTestId('btn-export').click();
  await win.waitForSelector('[data-testid="progress-panel"]', { timeout: 5_000 });

  // Wait until a progress % is painted, then snapshot mid-processing
  await win.waitForFunction(
    () => /^\d+%$/.test(document.body.innerText.match(/\d+%/)?.[0] ?? ''),
    { timeout: 30_000 },
  );
  await win.waitForTimeout(200);

  // Screenshot 04: progress bar mid-way with real frame in sidebar
  await win.screenshot({ path: path.join(OUT_DIR, '04-processing.png') });

  // ─ Wait for the job to finish ───────────────────────────────────────────────
  await win.waitForSelector('[data-testid="done-panel"]', { timeout: 150_000 });
  await win.waitForTimeout(300);

  // Screenshot 05: done panel — export complete, Reveal in Finder visible
  await win.screenshot({ path: path.join(OUT_DIR, '05-done.png') });

  await app.close();

  // Confirm output was written
  if (!fs.existsSync(OUTPUT)) throw new Error('Output file was not created');
  const size = fs.statSync(OUTPUT).size;
  console.log(`✓ Output saved to: ${OUTPUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
});

