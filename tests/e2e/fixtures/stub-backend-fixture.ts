/**
 * Electron fixture that runs the app against the stand-in Python backend
 * (fake_backend.py) instead of the real pipeline, so the IPC layer and the
 * renderer flows can be tested without ffmpeg or OpenCV.
 */
import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';

const repoRoot = path.join(__dirname, '..', '..', '..');

type Fixtures = { electronApp: ElectronApplication; page: Page };

export const test = base.extend<Fixtures>({
  electronApp: [
    async ({}, use) => {
      const app = await electron.launch({
        args: [path.join(repoRoot, 'electron', 'main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          WATERMARK_PYTHON: process.env.PYTHON_BIN || 'python3',
          WATERMARK_BACKEND: path.join(__dirname, 'fake_backend.py'),
        },
      });
      await use(app);
      await app.close();
    },
    { scope: 'worker' },
  ],
  page: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect };
