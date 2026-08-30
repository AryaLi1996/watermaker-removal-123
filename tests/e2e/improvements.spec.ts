/**
 * E2E: the workflow improvements — shortcuts, presets, friendly errors and
 * the time-remaining estimate.
 *
 * Runs against the stand-in Python backend, so no ffmpeg is involved.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ appTag: 'improvements' });

const INPUT = '/fake/clip.mp4';
const OUTPUT = '/fake/clip_processed.mp4';

async function mockDialogs(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }, { input, output }) => {
    ipcMain.removeHandler('dialog:openFile');
    ipcMain.removeHandler('dialog:saveFile');
    ipcMain.removeHandler('shell:openPath');
    ipcMain.handle('dialog:openFile', async () => input);
    ipcMain.handle('dialog:saveFile', async () => output);
    ipcMain.handle('shell:openPath', () => true);
  }, { input: INPUT, output: OUTPUT });
}

/** Keep the app in "processing" without a backend behind it. */
async function stubStartJob(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('job:start');
    ipcMain.handle('job:start', () => true);
  });
}

async function send(electronApp: ElectronApplication, channel: string, value?: unknown) {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send(payload.channel, payload.value);
  }, { channel, value });
}

/** Presets persist in localStorage, so tests must start from a known state. */
async function clearCustomPresets(page: Page) {
  await page.evaluate(() => window.localStorage.removeItem('watermark-remover:custom-presets'));
  await page.reload();
}

async function loadVideo(page: Page) {
  if (await page.getByTestId('btn-load-video').isVisible()) {
    await page.getByTestId('btn-load-video').click();
  } else {
    await page.getByTestId('change-video').click();
  }
  await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });
  // The tests below drive the app by keyboard, and a shortcut is only bound
  // once the sidebar's controls are up. Waiting on the export button alone
  // proves the state flipped, not that the picker those shortcuts change is
  // on screen.
  await expect(page.getByTestId('method-picker')).toBeVisible({ timeout: 10_000 });
}

test.describe('keyboard shortcuts', () => {
  test('number keys switch the removal method', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await loadVideo(page);

    await page.keyboard.press('2');
    await expect(page.getByText('Blur Strength')).toBeVisible();

    await page.keyboard.press('1');
    await expect(page.getByText('Blur Strength')).toBeHidden();
    await expect(page.getByText('Smoothness (radius px)')).toBeVisible();
  });

  test('a shortcut does not fire while typing in a field', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await loadVideo(page);
    await page.keyboard.press('1'); // known starting method

    await page.getByTestId('save-preset').click();
    await page.getByTestId('preset-name').fill('2');

    // The "2" went into the field, so the method must not have changed.
    await expect(page.getByText('Smoothness (radius px)')).toBeVisible();
    await expect(page.getByTestId('preset-name')).toHaveValue('2');
    await page.keyboard.press('Escape');
  });

  test('the shortcut list is discoverable in the sidebar', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await loadVideo(page);

    const hints = page.getByTestId('shortcut-hints');
    await expect(hints).toBeVisible();
    await hints.click(); // it is a <details>
    await expect(hints.getByText('Export')).toBeVisible();
  });
});

test.describe('presets', () => {
  test('applying a preset sets its method and parameters', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await loadVideo(page);

    await page.getByTestId('preset-blur-strong').click();
    await expect(page.getByText('Blur Strength')).toBeVisible();
    // The preset pins a specific kernel size, shown beside the slider
    await expect(page.getByText('81', { exact: true })).toBeVisible();
  });

  test('a saved preset survives a restart and can be removed', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    // Custom presets live in localStorage, which outlives the app: clear them
    // so this test does not inherit presets from an earlier run.
    await clearCustomPresets(page);
    await loadVideo(page);

    await page.getByTestId('save-preset').click();
    await page.getByTestId('preset-name').fill('My favourite');
    await page.getByTestId('preset-name-confirm').click();

    const saved = page.locator('[data-testid^="preset-custom-"]');
    await expect(saved).toHaveCount(1);
    await expect(saved).toContainText('My favourite');

    // Reload to prove it was persisted, not just held in memory
    await page.reload();
    await loadVideo(page);
    await expect(page.locator('[data-testid^="preset-custom-"]')).toHaveCount(1);

    // Custom presets carry a delete control; built-ins do not.
    await expect(page.locator('[data-testid^="delete-custom-"]')).toHaveCount(1);
    await page.locator('[data-testid^="delete-custom-"]').click();
    await expect(page.locator('[data-testid^="preset-custom-"]')).toHaveCount(0);

    // And the removal sticks
    await page.reload();
    await loadVideo(page);
    await expect(page.locator('[data-testid^="preset-custom-"]')).toHaveCount(0);
  });

  test('⌘/Ctrl+S opens the save form', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await loadVideo(page);

    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('preset-name-form')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preset-name-form')).toBeHidden();
  });
});

test.describe('error reporting', () => {
  test('a technical failure is shown in plain language, with the detail on request', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await stubStartJob(electronApp);
    await loadVideo(page);

    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    await send(electronApp, 'job:error', "Permission denied: '/root/out.mp4'");

    const panel = page.getByTestId('error-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel).toContainText('No permission to write there');
    // The raw text is not thrown at the user, but is available
    await expect(panel).not.toContainText('/root/out.mp4');
    await expect(page.getByTestId('copy-error')).toBeVisible();

    await page.getByTestId('dismiss-error').click();
    await expect(panel).toBeHidden();
  });

  test('an unrecognised failure is passed through rather than reworded', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await stubStartJob(electronApp);
    await loadVideo(page);

    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    await send(electronApp, 'job:error', 'Something nobody has seen before');

    const panel = page.getByTestId('error-panel');
    await expect(panel).toContainText('Something nobody has seen before');
    // Nothing was hidden, so there is no detail worth copying
    await expect(page.getByTestId('copy-error')).toBeHidden();
    await page.getByTestId('dismiss-error').click();
  });
});

test.describe('progress estimate', () => {
  test('an estimate appears once there is enough progress to judge', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await stubStartJob(electronApp);
    await loadVideo(page);

    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    // Nothing to go on yet
    await expect(page.getByTestId('eta')).toHaveText('estimating…');

    // Feed progress at a steady rate; the estimate must settle on a time
    for (const percent of [10, 20, 30, 40]) {
      await send(electronApp, 'job:progress', percent);
      await page.waitForTimeout(150);
    }

    await expect(page.getByTestId('eta')).not.toHaveText('estimating…', { timeout: 5_000 });
    await expect(page.getByTestId('eta')).toContainText(/left|almost done/);

    await page.getByTestId('btn-cancel').click();
  });
});

/** Replace job:start with a handler that records what the renderer sent. */
async function captureStartJob(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    (globalThis as Record<string, unknown>).__lastJobPayload = null;
    ipcMain.removeHandler('job:start');
    ipcMain.handle('job:start', (_event, payload) => {
      (globalThis as Record<string, unknown>).__lastJobPayload = payload;
      return true;
    });
  });
}

interface CapturedJob {
  mode?: string;
  method?: string;
  previewSeconds?: number;
  temporalQuality?: string;
}

async function lastJobPayload(electronApp: ElectronApplication) {
  return electronApp.evaluate(() =>
    (globalThis as Record<string, unknown>).__lastJobPayload as CapturedJob | null);
}

test.describe('preview duration', () => {

  test('defaults to one second and sends the chosen length instead', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await captureStartJob(electronApp);
    await loadVideo(page);

    const selector = page.getByTestId('preview-seconds');
    await expect(selector).toHaveValue('1');
    await expect(page.getByTestId('preview-warning')).toHaveText('Longer preview takes more processing time');

    await page.getByTestId('btn-preview').click();
    await expect.poll(() => lastJobPayload(electronApp)).toMatchObject({ mode: 'preview', previewSeconds: 1 });
    await page.getByTestId('btn-cancel').click();

    await selector.selectOption('5');
    await page.getByTestId('btn-preview').click();
    await expect.poll(() => lastJobPayload(electronApp)).toMatchObject({ mode: 'preview', previewSeconds: 5 });
    await page.getByTestId('btn-cancel').click();
  });

  test('an export is unaffected by the preview length', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await captureStartJob(electronApp);
    await loadVideo(page);

    await page.getByTestId('preview-seconds').selectOption('3');
    await page.getByTestId('btn-export').click();

    await expect.poll(() => lastJobPayload(electronApp)).toMatchObject({ mode: 'full' });
    const payload = await lastJobPayload(electronApp);
    expect(payload?.previewSeconds).toBeUndefined();

    await page.getByTestId('btn-cancel').click();
  });
});

test.describe('temporal fill', () => {
  /**
   * The method is greyed out on a machine below the bar, and CI runners are
   * not all above it. Where it is unavailable there is nothing to drive, and
   * the greying-out is covered in sidebar.spec.ts.
   */
  async function selectTemporal(page: import('@playwright/test').Page): Promise<boolean> {
    const temporal = page.getByTestId('method-temporal');
    if (!(await temporal.isEnabled())) return false;
    await temporal.click();
    await expect(page.getByTestId('temporal-note')).toBeVisible();
    return true;
  }

  test('an export carries the method and the quality that were chosen', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await captureStartJob(electronApp);
    await loadVideo(page);
    if (!(await selectTemporal(page))) test.skip();

    await page.getByTestId('quality-high').click();
    await page.getByTestId('btn-export').click();

    await expect.poll(() => lastJobPayload(electronApp)).toMatchObject({
      mode: 'full',
      method: 'temporal',
      temporalQuality: 'high',
    });
    await page.getByTestId('btn-cancel').click();
  });

  test('a preview is capped at three seconds', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await captureStartJob(electronApp);
    await loadVideo(page);

    // Pick the longest preview first, then switch method: the length has to
    // follow, because the backend will cap it whatever the control says.
    await page.getByTestId('preview-seconds').selectOption('5');
    if (!(await selectTemporal(page))) test.skip();

    await expect(page.getByTestId('preview-seconds')).toHaveValue('3');
    await expect(page.getByTestId('preview-seconds').locator('option[value="5"]')).toBeDisabled();

    await page.getByTestId('btn-preview').click();
    await expect.poll(() => lastJobPayload(electronApp)).toMatchObject({
      mode: 'preview',
      method: 'temporal',
      previewSeconds: 3,
    });
    await page.getByTestId('btn-cancel').click();
  });
});
