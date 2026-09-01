/**
 * Global setup — runs once before all E2E tests.
 * Builds the renderer bundle (renderer/dist/) so Electron can load the
 * production HTML file.  Skip if already built.
 */
import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup() {
  console.log('[e2e setup] Building renderer…');
  execSync('npm run build:renderer', {
    cwd: path.join(__dirname, '..', '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      // This is a production build, so Vite reads renderer/.env.production —
      // which turns the demo licence off for a release. The suite covers that
      // entry, so it builds with it back on; the *disabled* case is covered
      // where it belongs, against the main process's own flag
      // (SubscriptionPage.test.tsx and App.subscription.test.tsx), rather
      // than by shipping a bundle the specs cannot see.
      VITE_DISABLE_DEMO_LICENSE: 'false',
    },
  });
}
