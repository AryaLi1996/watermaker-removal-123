/**
 * E2E: Full watermark-removal pipeline using the real sample video.
 *
 * This test drives the actual Electron → Python backend stack end-to-end:
 *  1. Opens sample/samplevideo.mp4 via a mocked file dialog
 *  2. Waits for the Python preview_frame job to finish (real process)
 *  3. Sets the output path
 *  4. Patches startJob so the export uses a hard-coded bottom ROI
 *     (video is 784×1168 — bottom 12 % ≈ rows 1028–1168, full width)
 *  5. Clicks Export and waits for the Python full-export job to complete
 *  6. Asserts the done-panel is shown and the output MP4 exists on disk
 *
 * Runtime: ~30–90 s depending on CPU (10 s video, single-pass inpaint).
 * The test-level timeout is set to 3 minutes to accommodate slow CI machines.
 */
import { test, expect } from './fixtures/electron-fixture';
import path from 'path';
import fs from 'fs';

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..', '..');
const SAMPLE_VIDEO = path.join(ROOT, 'sample', 'samplevideo.mp4');
const OUTPUT_DIR = path.join(ROOT, 'sample');
const OUTPUT_VIDEO = path.join(OUTPUT_DIR, 'samplevideo-output.mp4');

// ── ROI: bottom-right corner of the 784×1168 frame ────────────────────────────
// Targets the "Watermark" text at the bottom-right of the sample video.
const BOTTOM_ROI = { x: 490, y: 1080, w: 294, h: 88 };

test.describe('Watermark removal — real pipeline', () => {
  // Give this suite extra time: Python extraction + encode takes ~30–90 s
  test.setTimeout(180_000);

  test.beforeAll(() => {
    // Ensure sample video exists so the test fails with a clear message
    if (!fs.existsSync(SAMPLE_VIDEO)) {
      throw new Error(`Sample video not found: ${SAMPLE_VIDEO}`);
    }
    // Clean up any leftover output from a previous run
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (fs.existsSync(OUTPUT_VIDEO)) fs.unlinkSync(OUTPUT_VIDEO);
  });

  test('removes bottom-of-frame watermark from samplevideo.mp4', async ({
    page,
    electronApp,
  }) => {
    // ── 1. Mock dialogs to use real files ────────────────────────────────────
    await electronApp.evaluate(
      ({ ipcMain }, { sampleVideo, outputVideo }) => {
        ipcMain.removeHandler('dialog:openFile');
        ipcMain.removeHandler('dialog:saveFile');
        ipcMain.handle('dialog:openFile', async () => sampleVideo);
        ipcMain.handle('dialog:saveFile', async () => outputVideo);
      },
      { sampleVideo: SAMPLE_VIDEO, outputVideo: OUTPUT_VIDEO },
    );

    // ── 2. Load the video ─────────────────────────────────────────────────────
    // The shared Electron instance may still be in a loaded state from a
    // previous test file. Handle both idle and non-idle gracefully.
    const isIdle = await page.locator('[data-testid="empty-state"]').isVisible();
    if (isIdle) {
      await page.getByTestId('empty-state').click();
    } else {
      await page.getByTestId('change-video').click();
    }

    // The sidebar switches to loaded state; Export button becomes visible
    await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });

    // ── 3. Wait for the Python preview_frame job to finish ───────────────────
    // "Loading preview…" disappears once onPreviewReady fires
    await expect(page.getByText('Loading preview…')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Loading preview…')).toBeHidden({ timeout: 60_000 });

    // ── 4. Set the output path via Browse ────────────────────────────────────
    await page.getByTestId('browse-output').click();
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 5_000 });

    // ── 5. Patch startJob to inject the bottom ROI for the full-export mode ──
    //       The preview_frame mode has already completed, so any subsequent call
    //       will be the real export job.
    await page.evaluate((roi) => {
      const original = (window as any).electronAPI.startJob;
      (window as any).electronAPI.startJob = async (config: any) => {
        if (config.mode === 'full') {
          config.roi = roi;
          config.method = 'inpaint'; // Smart Fill — best for logos/overlays
        }
        return original(config);
      };
    }, BOTTOM_ROI);

    // ── 6. Click Export ───────────────────────────────────────────────────────
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    // Watch the progress bar advance (optional — just confirms Python is alive)
    await expect(page.getByText(/^\d+%$/)).toBeVisible({ timeout: 15_000 });

    // ── 7. Wait for the job to complete ──────────────────────────────────────
    await expect(page.getByTestId('done-panel')).toBeVisible({ timeout: 150_000 });

    // ── 8. Verify output file exists and is non-zero ──────────────────────────
    expect(fs.existsSync(OUTPUT_VIDEO), 'Output MP4 should exist').toBe(true);
    const outputSize = fs.statSync(OUTPUT_VIDEO).size;
    expect(outputSize, 'Output MP4 should be non-empty').toBeGreaterThan(0);

    // ── 9. Verify the output video is a valid MP4 ─────────────────────────────
    // MP4 magic: bytes 4–7 = 'ftyp'
    const buf = Buffer.alloc(8);
    const fd = fs.openSync(OUTPUT_VIDEO, 'r');
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    expect(buf.slice(4, 8).toString('ascii'), 'Output should be a valid MP4').toBe('ftyp');

    console.log(`✓ Output written to: ${OUTPUT_VIDEO} (${outputSize} bytes)`);
  });
});
