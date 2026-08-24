/**
 * E2E: IPC bridge smoke tests
 *
 * These tests call the actual Electron IPC handlers directly (without
 * going through the Python backend) to verify the communication layer
 * is wired correctly.
 */
import { test, expect } from './fixtures/electron-fixture';

test.describe('IPC bridge', () => {
  test('dialog:openFile returns null when dialog is cancelled', async ({ electronApp }) => {
    // Override the real handler to simulate cancel
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dialog:openFile');
      ipcMain.handle('dialog:openFile', async () => null);
    });

    const result = await electronApp.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.executeJavaScript(
        `window.electronAPI.openFile().then(r => r)`
      );
    });

    expect(result).toBeNull();
  });

  test('dialog:saveFile returns path when confirmed', async ({ electronApp }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dialog:saveFile');
      ipcMain.handle('dialog:saveFile', async () => '/Users/test/output.mp4');
    });

    const result = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.executeJavaScript(
        `window.electronAPI.saveFile('output.mp4').then(r => r)`
      );
    });

    expect(result).toBe('/Users/test/output.mp4');
  });

  test('job:cancel IPC does not throw when no active job', async ({ electronApp }) => {
    // cancelJob should resolve cleanly even with no active Python process
    const error = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.executeJavaScript(
        `window.electronAPI.cancelJob().then(() => null).catch(e => e.message)`
      );
    });
    expect(error).toBeNull();
  });

  test('progress events are forwarded to renderer', async ({ page, electronApp }) => {
    // Register a listener in the page, fire the event from main, assert it arrived
    await page.evaluate(() => {
      (window as any).__testProgress = null;
      (window as any).electronAPI.onJobProgress((p: number) => {
        (window as any).__testProgress = p;
      });
    });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('job:progress', 42.5);
    });

    await page.waitForFunction(() => (window as any).__testProgress !== null, { timeout: 3_000 });
    const received = await page.evaluate(() => (window as any).__testProgress);
    expect(received).toBe(42.5);
  });

  test('state events are forwarded to renderer', async ({ page, electronApp }) => {
    await page.evaluate(() => {
      (window as any).__testState = null;
      (window as any).electronAPI.onJobState((s: string) => {
        (window as any).__testState = s;
      });
    });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('job:state', 'extracting_frames');
    });

    await page.waitForFunction(() => (window as any).__testState !== null, { timeout: 3_000 });
    const received = await page.evaluate(() => (window as any).__testState);
    expect(received).toBe('extracting_frames');
  });

  test('meta events deliver video metadata to renderer', async ({ page, electronApp }) => {
    await page.evaluate(() => {
      (window as any).__testMeta = null;
      (window as any).electronAPI.onJobMeta((m: object) => {
        (window as any).__testMeta = m;
      });
    });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        'job:meta',
        { width: 1920, height: 1080, fps: 30, duration: 60 }
      );
    });

    await page.waitForFunction(() => (window as any).__testMeta !== null, { timeout: 3_000 });
    const received = await page.evaluate(() => (window as any).__testMeta);
    expect(received).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 60 });
  });
});
