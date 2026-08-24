/**
 * Shared Electron fixture for all E2E tests.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/electron-fixture';
 *
 * The `electronApp` and `page` fixtures launch a fresh Electron instance
 * for each test file (scope: 'worker') and close it after all tests in
 * that file complete.
 */
import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';

type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
};

export const test = base.extend<ElectronFixtures>({
  // Launch Electron once per test file
  electronApp: [
    async ({}, use) => {
      const app = await electron.launch({
        args: [path.join(__dirname, '..', '..', '..', 'electron', 'main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
        },
      });
      await use(app);
      await app.close();
    },
    { scope: 'worker' },
  ],

  // Get the first BrowserWindow page — waits for any stable app state
  page: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    // Accept idle state OR any loaded state so shared Electron instances keep working
    await window.waitForSelector(
      '[data-testid="empty-state"], [data-testid="btn-export"], [data-testid="progress-panel"], [data-testid="done-panel"]',
      { timeout: 15_000 },
    );
    await use(window);
  },
});

export { expect };
