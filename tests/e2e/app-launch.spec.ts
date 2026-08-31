/**
 * E2E: App launch and initial render
 *
 * These tests verify the application starts up correctly and the idle
 * (empty) state is rendered as expected — without needing a real video file.
 */
import { test, expect } from './fixtures/electron-fixture';

test.use({ appTag: 'app-launch' });

test.describe('App launch', () => {
  test('window opens and reaches idle state', async ({ page }) => {
    // The empty state should be visible immediately on launch
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('shows correct prompt text', async ({ page }) => {
    await expect(page.getByText('Click to browse for a video file')).toBeVisible();
    await expect(page.getByText('MP4 · MKV · MOV · AVI')).toBeVisible();
  });

  test('app title is visible in the top bar', async ({ page }) => {
    await expect(page.getByText('SmoothVoice Watermark Remover')).toBeVisible();
  });

  test('names the window after the app', async ({ page, electronApp }) => {
    // The fixture pins English, so this is the English brand name.
    await expect(page).toHaveTitle('SmoothVoice Watermark Remover');
    // And the process introduces itself the same way to the OS — the menu
    // bar and the About dialog read app.getName(), not package.json's `name`.
    const name = await electronApp.evaluate(({ app }) => app.getName());
    expect(name).toBe('SmoothVoice Watermark Remover');
  });

  test('export and preview buttons are not present in idle state', async ({ page }) => {
    await expect(page.getByTestId('btn-export')).not.toBeVisible();
    await expect(page.getByTestId('btn-preview')).not.toBeVisible();
  });

  test('window has the correct minimum size', async ({ electronApp }) => {
    const size = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      return { width, height };
    });
    expect(size.width).toBeGreaterThanOrEqual(900);
    expect(size.height).toBeGreaterThanOrEqual(600);
  });

  test('context isolation is enabled (nodeIntegration is off)', async ({ page }) => {
    // With nodeIntegration=false, require() and Node's process are not available
    // in the renderer context — verify from the renderer side.
    const hasRequire = await page.evaluate(() => typeof require !== 'undefined');
    const hasNodeProcess = await page.evaluate(
      () =>
        typeof (window as any).process !== 'undefined' &&
        (window as any).process.versions != null,
    );
    expect(hasRequire).toBe(false);
    expect(hasNodeProcess).toBe(false);
  });

  test('electronAPI is exposed on window', async ({ page }) => {
    const hasAPI = await page.evaluate(() => typeof (window as any).electronAPI === 'object');
    expect(hasAPI).toBe(true);
  });

  test('all required electronAPI methods are exposed', async ({ page }) => {
    const methods = await page.evaluate(() => {
      const api = (window as any).electronAPI;
      return [
        'openFile', 'saveFile', 'startJob', 'cancelJob',
        'openPath', 'onJobProgress', 'onJobState', 'onJobDone',
        'onJobError', 'onPreviewReady', 'onJobMeta', 'removeJobListeners',
      ].map((m) => ({ method: m, type: typeof api[m] }));
    });
    for (const { method, type } of methods) {
      expect(type, `electronAPI.${method} should be a function`).toBe('function');
    }
  });
});
