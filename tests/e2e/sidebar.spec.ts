/**
 * E2E: Sidebar UI controls
 *
 * These tests mock the Electron dialog and IPC to verify UI state
 * transitions and button enable/disable logic without a real video.
 */
import { test, expect } from './fixtures/electron-fixture';
import path from 'path';

// A real MP4 fixture (tiny black video used only for dialog mock responses)
const FIXTURE_MP4 = path.join(__dirname, '..', '..', 'fixtures', 'sample.mp4');

test.describe('Sidebar — output path', () => {
  test('Browse button is not visible in idle state', async ({ page }) => {
    await expect(page.getByTestId('browse-output')).not.toBeVisible();
  });

  test('Export button is enabled as soon as a video is selected', async ({ page, electronApp }) => {
    // Simulate a file being selected via IPC mock
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dialog:openFile');
      ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
    });

    // Also mock the preview_frame job so the app doesn't crash waiting for Python
    await page.evaluate(() => {
      const api = (window as any).electronAPI;
      // Override startJob to do nothing, then fake a meta + preview_ready event
      api.startJob = async () => {};
    });

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dialog:saveFile');
      ipcMain.handle('dialog:saveFile', async () => '/fake/output.mp4');
    });

    // Load a video from idle state or re-load via Change video
    const isIdle = await page.locator('[data-testid="empty-state"]').isVisible();
    if (isIdle) {
      await page.getByTestId('empty-state').click();
    } else {
      await page.getByTestId('change-video').click();
    }

    // Export button becomes enabled immediately — output path is auto-derived
    // from the input filename (no manual Browse step required)
    await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 5_000 });

    // Browse still works to change the output path
    await page.getByTestId('browse-output').click();
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 5_000 });
  });
});

test.describe('Sidebar — method picker', () => {
  // This test verifies the MethodPicker radio group renders
  test('method picker renders after file load (mocked)', async ({ page, electronApp }) => {
    // Previous tests may have left the app in loaded state — that's fine.
    // If still idle, we need to load a video first.
    const isIdle = await page.locator('[data-testid="empty-state"]').isVisible();
    if (isIdle) {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('dialog:openFile');
        ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
      });
      await page.evaluate(() => {
        (window as any).electronAPI.startJob = async () => {};
      });
      await page.getByTestId('empty-state').click();
      await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
    }

    // In loaded state the method picker should be rendered
    await expect(page.getByText('Smart Fill', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Blur', { exact: true })).toBeVisible();
    await expect(page.getByText('Solid Color', { exact: true })).toBeVisible();
    await expect(page.getByText('Clone Stamp', { exact: true })).toBeVisible();
  });
});

test.describe('Error panel', () => {
  test('error panel can be dismissed', async ({ page, electronApp }) => {
    // Self-contained: register mocks fresh, handle any app state
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dialog:openFile');
      ipcMain.removeHandler('dialog:saveFile');
      ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
      ipcMain.handle('dialog:saveFile', async () => '/fake/error-test-output.mp4');
    });
    await page.evaluate(() => { (window as any).electronAPI.startJob = async () => {}; });

    // If in idle state, load a video first
    if (await page.locator('[data-testid="empty-state"]').isVisible()) {
      await page.getByTestId('empty-state').click();
      await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
    }

    // Export is already enabled from file load (output path is auto-derived).
    // Clicking Browse just lets the user change the output location.
    await page.getByTestId('browse-output').click();
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 5_000 });

    // Dismiss any pre-existing error panel
    if (await page.getByTestId('error-panel').isVisible()) {
      await page.getByTestId('dismiss-error').click();
    }

    // Click Export — calls registerJobListeners() which wires onJobError → error panel
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    // Inject error from main process
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('job:error', 'Simulated test error');
    });

    await expect(page.getByTestId('error-panel')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Simulated test error')).toBeVisible();

    await page.getByTestId('dismiss-error').click();
    await expect(page.getByTestId('error-panel')).not.toBeVisible();
  });
});
