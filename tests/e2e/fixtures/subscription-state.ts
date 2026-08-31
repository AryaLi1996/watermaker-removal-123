/**
 * Put the app's subscription into a known state before a spec runs.
 *
 * Pinned for the same reason the language is: a run's editor features would
 * otherwise depend on how long ago the container's user-data directory was
 * created. The specs that exercise temporal fill, the deep engine and the
 * longer previews are testing what a subscriber sees, so every fixture grants
 * a plan; tests/e2e/subscription.spec.ts clears it again to test the trial.
 *
 * The record is written straight to the file the main process reads. Modules
 * are pulled in with `require`, not `import()`: the body of an
 * `electronApp.evaluate` runs through an eval in the main process, which has
 * no host callback for a dynamic import — one throws "A dynamic import
 * callback was not specified" and fails every spec that uses the fixture.
 * `process.mainModule` is the fallback for an eval scope that turns out not to
 * carry `require`, since a wrong guess here costs a whole CI run.
 */
import type { ElectronApplication } from '@playwright/test';

/** The record as it is written. A year is longer than any spec runs for. */
function paidRecord(now: number) {
  return {
    plan: 'yearly',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    autoRenew: true,
  };
}

/** Write a year-long plan into the record the main process reads. */
export async function grantSubscription(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ app }, record) => {
    // See the note above: `require`, with mainModule as the fallback.
    const load = typeof require === 'function'
      ? require
      : (id: string) => process.mainModule!.require(id);
    const fs = load('fs');
    const path = load('path');
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'subscription.json'), JSON.stringify(record));
  }, paidRecord(Date.now()));
}

/** Remove it, so the next load grants a fresh trial the way a first run does. */
export async function clearSubscription(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ app }) => {
    // See the note above: `require`, with mainModule as the fallback.
    const load = typeof require === 'function'
      ? require
      : (id: string) => process.mainModule!.require(id);
    const fs = load('fs');
    const path = load('path');
    fs.rmSync(path.join(app.getPath('userData'), 'subscription.json'), { force: true });
  });
}
