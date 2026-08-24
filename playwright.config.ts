import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // Electron tests are always serial — one browser context = one app instance
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    // Screenshot on failure
    screenshot: 'only-on-failure',
    // Video on failure
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // Global setup: build the renderer before running E2E tests
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [
    {
      name: 'electron',
      use: {
        // Playwright resolves the Electron binary automatically
        // when using the _electron fixture.
      },
    },
  ],
  outputDir: 'test-results',
});
