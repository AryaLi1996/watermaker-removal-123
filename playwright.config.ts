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
  // The screenshot generator is a documentation tool, not a correctness test:
  // it drives a real multi-minute export purely to capture images for the docs.
  // It also deadlocks on the GitHub ubuntu runner — it consumes whatever test
  // budget it is given (3.0m against a 180s limit, 7.0m against 420s) while
  // passing on the macOS and Windows runners and locally, including pinned to
  // two cores. That is unexplained and tracked in TESTING.md.
  //
  // CI therefore skips it; the same end-to-end pipeline is covered there by
  // watermark-removal.spec.ts. Regenerate the images with `npm run screenshots`,
  // which sets SCREENSHOTS=1 to opt back in.
  testIgnore:
    process.env.CI && !process.env.SCREENSHOTS
      ? ['**/capture-screenshots.spec.ts']
      : [],

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
