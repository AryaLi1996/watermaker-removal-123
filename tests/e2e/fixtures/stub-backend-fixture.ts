/**
 * Electron fixture that runs the app against the stand-in Python backend
 * (fake_backend.py) instead of the real pipeline, so the IPC layer and the
 * renderer flows can be tested without ffmpeg or OpenCV.
 *
 * Each spec sets its own `appTag` so the app is not shared between files —
 * see electron-fixture.ts for why.
 */
import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { SANDBOX_ARGS } from './launch-args';
import { grantSubscription } from './subscription-state';


const repoRoot = path.join(__dirname, '..', '..', '..');

type Fixtures = { electronApp: ElectronApplication; page: Page };

type Options = {
  /** Identifies the spec file, so each gets its own app instance. */
  appTag: string;
};

export const test = base.extend<Fixtures, Options>({
  appTag: ['stub-backend', { option: true, scope: 'worker' }],

  electronApp: [
    async ({ appTag }, use) => {
      void appTag; // depended on so a new tag forces a fresh app
      const app = await electron.launch({
        args: [...SANDBOX_ARGS, path.join(repoRoot, 'electron', 'main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // Point licensing at a port nothing listens on. The suite must not
          // reach the real service: doing so would write this runner's device
          // id into the shared production trial table, and make the tests
          // depend on what that service says. Every spec stubs the licence
          // and payment IPC it needs (fixtures/subscription-state.ts); this
          // makes the unstubbed calls fail fast instead of going out.
          LICENSE_URL: 'http://127.0.0.1:9/',
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
    // Pin the language — see electron-fixture.ts for why.
    await window.evaluate(() => window.localStorage.setItem('watermark-remover:locale', 'en'));
    // Pin the theme — see electron-fixture.ts for why.
    await window.evaluate(() => window.localStorage.setItem('theme-preference', 'dark'));
    // Pin the licence — see electron-fixture.ts for why.
    await grantSubscription(electronApp);
    await window.reload();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect };
