/**
 * Put the app's licence into a known state before a spec runs.
 *
 * Pinned for the same reason the language and the theme are: a run's editor
 * features would otherwise depend on what the shared licence service happens
 * to say about the machine the suite is running on.
 *
 * The state is injected by replacing the `license:getState` IPC handler
 * rather than by writing a licence file. A real licence file would have to
 * carry a token signed with the deployment's secret and encrypted with a key
 * bound to this machine — reproducing both in a test would mean reproducing
 * the security properties they exist for.
 */
import type { ElectronApplication } from '@playwright/test';

/** A trial in progress: the state a fresh install is in. */
export const TRIAL_STATE = {
  status: 'unlicensed',
  payload: null,
  expiresAt: null,
  daysRemaining: 0,
  graceDaysLeft: 0,
  trial: {
    used: true,
    active: true,
    start: null,
    end: null,
    msRemaining: 2 * 24 * 60 * 60 * 1000,
    durationDays: 3,
    source: 'server',
  },
};

/** A paid plan in force — what the editor specs need to reach the features. */
export const LICENSED_STATE = {
  status: 'active',
  payload: { userId: 'e2e-user', planId: 'annual', licenseKey: 'E2E-TEST-KEY', expiresAt: 4_102_444_800, issuedAt: 0 },
  expiresAt: '2100-01-01T00:00:00.000Z',
  daysRemaining: 365,
  graceDaysLeft: 0,
  trial: { ...TRIAL_STATE.trial, active: false },
};

/** Replace what the renderer is told about the licence. */
export async function setLicenseState(electronApp: ElectronApplication, state: unknown) {
  await electronApp.evaluate(({ ipcMain }, injected) => {
    ipcMain.removeHandler('license:getState');
    ipcMain.handle('license:getState', () => injected);
  }, state);
}

/** The editor specs run as a subscriber: that is the state in which the
 *  features they drive exist at all. */
export async function grantSubscription(electronApp: ElectronApplication) {
  await setLicenseState(electronApp, LICENSED_STATE);
}

/**
 * Pin the trial's allowance of temporal-fill exports.
 *
 * The real count lives in the main process and is derived from the *real*
 * licence state there, not the one `setLicenseState` injects into the
 * renderer — so a spec that wants an exhausted allowance has to say so here
 * rather than by spending three exports.
 */
export async function setTemporalUsage(
  electronApp: ElectronApplication,
  usage: { used: number; remaining: number; allowed: boolean; limited?: boolean },
) {
  await electronApp.evaluate(({ ipcMain }, injected) => {
    ipcMain.removeHandler('temporal:usage');
    ipcMain.handle('temporal:usage', () => injected);
  }, { limit: 3, exhausted: usage.remaining === 0, limited: true, ...usage });
}

/**
 * Stub the demo licence, so a spec never takes the *real* one.
 *
 * The real handlers mint a token and write a "this device has had its demo"
 * record into the app's userData — which is the runner's own, not a temporary
 * one. A spec that let them run would spend the developer's demo, and would
 * pass exactly once. So the channels are replaced, and what is left to test
 * is the whole of what this app decides: that the entry is offered, that the
 * click reaches the main process through the real bridge, and that the answer
 * is worded correctly.
 */
export async function stubDemoLicense(
  electronApp: ElectronApplication,
  options: { used?: boolean; result?: unknown } = {},
) {
  await electronApp.evaluate(({ ipcMain, app }, opts) => {
    const store = app as unknown as { __demo: { activations: unknown[] } };
    store.__demo = { activations: [] };

    for (const channel of ['license:demoState', 'license:activateDemo']) {
      ipcMain.removeHandler(channel);
    }

    const demo = { used: !!opts.used, durationDays: 7, issuedAt: null, expiresAt: null };
    ipcMain.handle('license:demoState', () => demo);
    ipcMain.handle('license:activateDemo', (_e: unknown, code?: string) => {
      store.__demo.activations.push({ code: code ?? null });
      return opts.result ?? { success: true, demo: { ...demo, used: true } };
    });
  }, options);
}

/** What `stubDemoLicense` recorded — one entry per activation attempt, with
 *  the code it carried (null for the one-click path). */
export function demoCalls(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ app }) =>
    (app as unknown as { __demo: { activations: { code: string | null }[] } }).__demo);
}

/** Stub the payment routes, so no spec talks to the real service. */
export async function stubPayments(
  electronApp: ElectronApplication,
  options: { plans?: unknown[]; methods?: unknown[]; order?: unknown; statuses?: unknown[] } = {},
) {
  await electronApp.evaluate(({ ipcMain, app }, opts) => {
    const store = app as unknown as { __payments: { opened: string[]; statusCalls: number } };
    store.__payments = { opened: [], statusCalls: 0 };

    for (const channel of [
      'payment:getPlans', 'payment:getMethods', 'payment:createOrder',
      'payment:orderStatus', 'payment:openExternal', 'payment:openEmbedded',
    ]) {
      ipcMain.removeHandler(channel);
    }

    ipcMain.handle('payment:getPlans', () => ({ plans: opts.plans ?? [], source: 'server' }));
    ipcMain.handle('payment:getMethods', () => ({ methods: opts.methods ?? [], source: 'server' }));
    ipcMain.handle('payment:createOrder', () => opts.order);
    ipcMain.handle('payment:orderStatus', () => {
      const statuses = (opts.statuses ?? []) as unknown[];
      const index = Math.min(store.__payments.statusCalls, statuses.length - 1);
      store.__payments.statusCalls += 1;
      return statuses[index];
    });
    // The checkout page is never actually opened in a test: record the URL
    // instead, which is the part worth asserting.
    ipcMain.handle('payment:openExternal', (_e: unknown, url: string) => {
      store.__payments.opened.push(`external:${url}`);
      return true;
    });
    ipcMain.handle('payment:openEmbedded', (_e: unknown, url: string) => {
      store.__payments.opened.push(`embedded:${url}`);
      return true;
    });
  }, options);
}

/** What `stubPayments` recorded. */
export function paymentCalls(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ app }) =>
    (app as unknown as { __payments: { opened: string[]; statusCalls: number } }).__payments);
}
