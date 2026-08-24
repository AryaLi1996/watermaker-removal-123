/**
 * E2E: renderer flow (load → ROI canvas → export → reveal)
 *
 * Drives the real UI against the stand-in Python backend, so the parts of the
 * renderer that depend on backend events — metadata display, the Konva ROI
 * canvas, the progress panel and the automatic reveal on completion — are
 * covered without ffmpeg.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ appTag: 'renderer-flow' });

const INPUT = '/fake/clip.mp4';
const OUTPUT = '/fake/clip_processed.mp4';

/** Mock the native dialogs and record what shell:openPath was asked to reveal. */
async function mockShell(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }, { input, output }) => {
    (globalThis as any).__revealed = [];
    ipcMain.removeHandler('dialog:openFile');
    ipcMain.removeHandler('dialog:saveFile');
    ipcMain.removeHandler('shell:openPath');
    ipcMain.handle('dialog:openFile', async () => input);
    ipcMain.handle('dialog:saveFile', async () => output);
    ipcMain.handle('shell:openPath', (_e, filePath) => {
      (globalThis as any).__revealed.push(filePath);
    });
  }, { input: INPUT, output: OUTPUT });
}

function revealed(electronApp: ElectronApplication) {
  return electronApp.evaluate(() => (globalThis as any).__revealed as string[]);
}

/** Load a video from whatever state the shared app instance is in. */
async function loadVideo(page: Page) {
  if (await page.getByTestId('btn-load-video').isVisible()) {
    await page.getByTestId('btn-load-video').click();
  } else {
    await page.getByTestId('change-video').click();
  }
  await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });
}

test.describe('renderer flow', () => {
  test('the sidebar offers a load button before any video is loaded', async ({ page, electronApp }) => {
    await mockShell(electronApp);
    await expect(page.getByTestId('btn-load-video')).toBeVisible();
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('loading a video shows its metadata and the ROI canvas', async ({ page, electronApp }) => {
    await mockShell(electronApp);
    await loadVideo(page);

    // Metadata from the backend's STATE:meta line
    await expect(page.getByText('640×480')).toBeVisible({ timeout: 10_000 });
    // The Konva stage renders the preview still
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });
    // Output path is auto-derived from the input filename
    await expect(page.getByText('clip_processed.mp4')).toBeVisible();
  });

  test('switching method swaps the parameter controls', async ({ page, electronApp }) => {
    await mockShell(electronApp);
    await loadVideo(page);

    await page.getByText('Blur', { exact: true }).click();
    await expect(page.getByText('Blur Strength')).toBeVisible();

    await page.getByText('Clone Stamp', { exact: true }).click();
    await expect(page.getByText('Blur Strength')).toBeHidden();
  });

  test('export reveals the finished file without being asked', async ({ page, electronApp }) => {
    await mockShell(electronApp);
    await loadVideo(page);

    await page.getByTestId('btn-export').click();

    await expect(page.getByTestId('done-panel')).toBeVisible({ timeout: 10_000 });
    // The path came back from the backend's STATE:done line, and was revealed
    expect(await revealed(electronApp)).toContain(OUTPUT);
  });
});
