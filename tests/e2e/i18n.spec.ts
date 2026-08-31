/**
 * E2E: switching the interface language.
 *
 * The fixture pins English, so this spec drives the switcher itself and puts
 * it back afterwards.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ appTag: 'i18n' });

const INPUT = '/fake/clip.mp4';

async function mockDialogs(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler('dialog:openFile');
    ipcMain.removeHandler('shell:openPath');
    ipcMain.handle('dialog:openFile', async () => input);
    ipcMain.handle('shell:openPath', () => true);
  }, INPUT);
}

async function chooseLanguage(page: Page, code: 'en' | 'zh') {
  await page.getByTestId('language-select').selectOption(code);
}

test.describe('language', () => {
  test.afterEach(async ({ page }) => {
    // Leave the app in English for whatever runs next.
    await chooseLanguage(page, 'en');
  });

  test('switching to Chinese translates the interface immediately', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);

    await expect(page.getByText('SmoothVoice Watermark Remover')).toBeVisible();
    await expect(page.getByText('Click to browse for a video file')).toBeVisible();

    await chooseLanguage(page, 'zh');

    await expect(page.getByText('舒音水印去除')).toBeVisible();
    await expect(page.getByText('点击选择视频文件')).toBeVisible();
    // No reload was needed
    await expect(page.getByText('SmoothVoice Watermark Remover')).toBeHidden();
    // The window is named in the language the user reads: Electron takes the
    // window title from the document, which App sets from the active locale.
    await expect(page).toHaveTitle('舒音水印去除');
  });

  test('the choice survives a restart', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await chooseLanguage(page, 'zh');
    await expect(page.getByText('舒音水印去除')).toBeVisible();

    await page.reload();

    await expect(page.getByText('舒音水印去除')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('language-select')).toHaveValue('zh');
  });

  test('the controls that appear after loading a video are translated too', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await chooseLanguage(page, 'zh');

    await page.getByTestId('btn-load-video').click();
    await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });

    // Sidebar headings, method names and the action buttons
    await expect(page.getByText('去除方式')).toBeVisible();
    await expect(page.getByText('智能修复', { exact: true })).toBeVisible();
    await expect(page.getByTestId('btn-export')).toHaveText('导出');
    await expect(page.getByTestId('btn-preview')).toHaveText('预览');
    await expect(page.getByTestId('preview-warning')).toHaveText('预览时长越长，生成时间越长');
    await expect(page.getByTestId('save-preset')).toHaveText('保存当前设置');
  });

  test('the status line follows the language while a job runs', async ({ page, electronApp }) => {
    // The backend announces stages as keys for exactly this reason: it cannot
    // know which language the person watching reads.
    await mockDialogs(electronApp);
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('job:start');
      ipcMain.handle('job:start', () => true);
    });

    await page.getByTestId('btn-load-video').click();
    await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });
    await chooseLanguage(page, 'zh');

    await page.getByTestId('btn-export').click();
    const panel = page.getByTestId('progress-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('job:state', 'stage:encoding');
    });
    await expect(panel).toContainText('正在编码视频');

    // The stage already on screen re-renders when the language changes
    await chooseLanguage(page, 'en');
    await expect(panel).toContainText('Encoding video');

    await page.getByTestId('btn-cancel').click();
  });

  test('backend failures are reported in the chosen language', async ({ page, electronApp }) => {
    await mockDialogs(electronApp);
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('job:start');
      ipcMain.handle('job:start', () => true);
    });

    await page.getByTestId('btn-load-video').click();
    await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });
    await chooseLanguage(page, 'zh');

    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible({ timeout: 5_000 });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('job:error', "Permission denied: '/root/out.mp4'");
    });

    const panel = page.getByTestId('error-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel).toContainText('没有写入该位置的权限');

    // Switching language re-renders the message that is already on screen
    await chooseLanguage(page, 'en');
    await expect(panel).toContainText('No permission to write there');

    await page.getByTestId('dismiss-error').click();
  });
});
