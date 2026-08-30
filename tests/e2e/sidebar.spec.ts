/**
 * E2E: Sidebar UI controls
 *
 * These tests mock the Electron dialog and IPC to verify UI state
 * transitions and button enable/disable logic without a real video.
 */
import { test, expect } from './fixtures/electron-fixture';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';

test.use({ appTag: 'sidebar' });

// A real MP4 fixture (tiny black video used only for dialog mock responses)
const FIXTURE_MP4 = path.join(__dirname, '..', '..', 'fixtures', 'sample.mp4');

/** Replace job:start with a no-op so no Python process is spawned. */
async function stubStartJob(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('job:start');
    ipcMain.handle('job:start', () => true);
  });
}

/**
 * Same stub, but keeping every payload so a test can assert on what the
 * renderer actually asked the backend for — which is the only place the
 * preview's quality downgrade is observable.
 */
async function recordStartJob(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain, app }) => {
    (app as unknown as { __jobs: unknown[] }).__jobs = [];
    ipcMain.removeHandler('job:start');
    ipcMain.handle('job:start', (_event, payload) => {
      (app as unknown as { __jobs: unknown[] }).__jobs.push(payload);
      return true;
    });
  });
}

function recordedJobs(electronApp: ElectronApplication) {
  return electronApp.evaluate(
    ({ app }) => (app as unknown as { __jobs: Record<string, unknown>[] }).__jobs,
  );
}

/** Get the app out of the empty state and into the editor, with jobs stubbed. */
async function loadVideo(page: Page, electronApp: ElectronApplication) {
  if (!(await page.locator('[data-testid="empty-state"]').isVisible())) return;
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dialog:openFile');
    ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
  });
  await page.getByTestId('empty-state').click();
  await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
}

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

    // Stub the job at the IPC layer: contextBridge exposes a frozen object, so
    // assigning to window.electronAPI.startJob from the page does nothing and
    // a real Python job would race these assertions.
    await stubStartJob(electronApp);

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
      await stubStartJob(electronApp);
      await page.getByTestId('empty-state').click();
      await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
    }

    // In loaded state the method picker should be rendered
    await expect(page.getByText('Smart Fill', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Blur', { exact: true })).toBeVisible();
    await expect(page.getByText('Solid Color', { exact: true })).toBeVisible();
    await expect(page.getByText('Clone Stamp', { exact: true })).toBeVisible();
    await expect(page.getByTestId('method-temporal')).toBeVisible();
  });

  // Temporal fill is slower than everything else in the list, so choosing it
  // has to bring both halves of that bargain on screen: the quality dial and
  // the warning about the wait.
  test('choosing temporal fill reveals its quality dial and its warning', async ({ page, electronApp }) => {
    const isIdle = await page.locator('[data-testid="empty-state"]').isVisible();
    if (isIdle) {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('dialog:openFile');
        ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
      });
      await stubStartJob(electronApp);
      await page.getByTestId('empty-state').click();
      await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 5_000 });
    }

    const temporal = page.getByTestId('method-temporal');
    // A machine too small for the method greys it out and says why; there is
    // nothing to reveal there, and nothing broken either.
    if (!(await temporal.isEnabled())) {
      await expect(temporal).toContainText('Needs at least');
      return;
    }

    await temporal.click();
    await expect(page.getByTestId('quality-balanced')).toBeVisible();
    await expect(page.getByTestId('quality-fast')).toBeVisible();
    await expect(page.getByTestId('quality-quality')).toBeVisible();
    await expect(page.getByTestId('temporal-note')).toContainText('Slower');

    await page.getByTestId('quality-fast').click();
    await expect(page.getByTestId('quality-fast')).toHaveAttribute('aria-pressed', 'true');

    // Back to a single-frame method: the dial belongs to this one alone.
    await page.getByTestId('method-inpaint').click();
    await expect(page.getByTestId('temporal-note')).toBeHidden();
  });

  // The method is new enough that "Beta" is the only thing the list says
  // about it, and that is a label, not an explanation.
  test('temporal fill explains what it does on hover', async ({ page, electronApp }) => {
    await stubStartJob(electronApp);
    await loadVideo(page, electronApp);

    const info = page.getByTestId('temporal-info');
    await expect(info).toBeVisible();
    const explanation = await info.getAttribute('title');
    expect(explanation).toBeTruthy();
    expect(explanation).toContain('motion');

    // The glyph is the affordance; the whole row carries the explanation, so
    // it is reachable without hitting an 11px target — and so a screen reader
    // gets it as the button's description rather than as part of its name.
    const temporal = page.getByTestId('method-temporal');
    if (await temporal.isEnabled()) {
      expect(await temporal.getAttribute('title')).toBe(explanation);
    }
    expect(await info.getAttribute('aria-hidden')).toBe('true');
  });

  // A preview that is quietly rougher than the export it stands in for is a
  // preview that misleads, so the swap is stated wherever it applies.
  test('a temporal preview says it runs at the quick setting', async ({ page, electronApp }) => {
    await recordStartJob(electronApp);
    await loadVideo(page, electronApp);

    const temporal = page.getByTestId('method-temporal');
    if (!(await temporal.isEnabled())) {
      await expect(temporal).toContainText('Needs at least');
      return;
    }
    await temporal.click();

    await page.getByTestId('quality-quality').click();
    await expect(page.getByTestId('temporal-preview-fast')).toContainText('Fast');

    // Already at the quick setting: nothing differs, so nothing is claimed.
    await page.getByTestId('quality-fast').click();
    await expect(page.getByTestId('temporal-preview-fast')).toBeHidden();

    // And the swap is real, not only described: the preview job goes out at
    // 'fast' while the dial still reads 'High'.
    await page.getByTestId('quality-quality').click();
    await page.getByTestId('btn-preview').click();

    // Loading the video already sent a 'preview_frame' job of its own, so the
    // clip preview has to be picked out by mode rather than taken as the first.
    await expect
      .poll(
        async () => (await recordedJobs(electronApp)).filter((j) => j.mode === 'preview').length,
        { timeout: 5_000 },
      )
      .toBe(1);

    const preview = (await recordedJobs(electronApp)).find((j) => j.mode === 'preview')!;
    expect(preview.method).toBe('temporal');
    expect(preview.temporalQuality).toBe('fast');
    // The dial itself did not move: the export still gets what was chosen.
    await expect(page.getByTestId('quality-quality')).toHaveAttribute('aria-pressed', 'true');
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
    await stubStartJob(electronApp);

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
