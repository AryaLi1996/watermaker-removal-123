/**
 * Put the app's subscription into a known state before a spec runs.
 *
 * Pinned for the same reason the language is: a run's editor features would
 * otherwise depend on how long ago the container's user-data directory was
 * created. The specs that exercise temporal fill, the deep engine and the
 * longer previews are testing what a subscriber sees, so every fixture grants
 * a plan; tests/e2e/subscription.spec.ts clears it again to test the trial.
 *
 * The record is written straight to the file the main process reads. `fs` and
 * `path` are pulled in with a dynamic import rather than `require`, which is
 * module-scoped and so not reliably in scope inside an evaluated function.
 */
import type { ElectronApplication } from '@playwright/test';

/** Write a year-long plan into the record the main process reads. */
export async function grantSubscription(electronApp: ElectronApplication) {
  await electronApp.evaluate(async ({ app }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const now = Date.now();
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'subscription.json'),
      JSON.stringify({
        plan: 'yearly',
        startDate: new Date(now).toISOString(),
        endDate: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenew: true,
      }),
    );
  });
}

/** Remove it, so the next load grants a fresh trial the way a first run does. */
export async function clearSubscription(electronApp: ElectronApplication) {
  await electronApp.evaluate(async ({ app }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.rmSync(path.join(app.getPath('userData'), 'subscription.json'), { force: true });
  });
}
