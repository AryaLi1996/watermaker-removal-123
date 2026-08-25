/**
 * Shared Electron fixture for all E2E tests.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/electron-fixture';
 *   test.use({ appTag: 'my-spec' });
 *
 * Worker-scoped fixtures are reused across spec files in the same worker, so
 * one file's IPC stubs would leak into the next. Each spec declares its own
 * `appTag`; Playwright tears the app down and relaunches it when that value
 * changes, giving every file a genuinely fresh Electron instance.
 */
import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { SANDBOX_ARGS } from './launch-args';


type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
};

type ElectronOptions = {
  /** Identifies the spec file, so each gets its own app instance. */
  appTag: string;
};

export const test = base.extend<ElectronFixtures, ElectronOptions>({
  appTag: ['shared', { option: true, scope: 'worker' }],

  // Launch Electron once per test file
  electronApp: [
    async ({ appTag }, use) => {
      void appTag; // depended on so a new tag forces a fresh app
      const app = await electron.launch({
        args: [...SANDBOX_ARGS, path.join(__dirname, '..', '..', '..', 'electron', 'main.js')],
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
