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

const ROOT    = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SAMPLE  = path.join(ROOT, 'sample', 'samplevideo.mp4');
const OUTPUT  = path.join(ROOT, 'sample', 'samplevideo-output.mp4');

// ROI: bottom-right corner of the 784×1168 frame (where the "Watermark" text lives)
const BOTTOM_ROI = { x: 490, y: 1080, w: 294, h: 88 };

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

// ──────────────────────────────────────────────────────────────────────────
test('capture: idle (empty) state', async () => {
  const app = await electron.launch({
    args: [path.join(ROOT, 'electron', 'main.js')],
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
  // Override the default 30s config timeout for this test — Python export takes ~20s
  test.setTimeout(180_000);
  const app = await electron.launch({
    args: [path.join(ROOT, 'electron', 'main.js')],
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

  // ─ Patch startJob to pin the ROI to the bottom watermark strip ───────────
  await win.evaluate((roi) => {
    const orig = (window as any).electronAPI.startJob;
    (window as any).electronAPI.startJob = async (cfg: any) => {
      if (cfg.mode === 'full') { cfg.roi = roi; cfg.method = 'inpaint'; }
      return orig(cfg);
    };
  }, BOTTOM_ROI);

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

