/**
 * E2E: the licence, through the real IPC surface.
 *
 * The licence service itself is not reached — the fixtures point LICENSE_URL
 * at a dead port and each test injects the state and the payment answers it
 * needs. What is being tested is this app: that it reads the state it is
 * given, gates the right features on it, and drives a payment to the point
 * where the service takes over.
 */
import { test, expect } from './fixtures/electron-fixture';
import {
  LICENSED_STATE, TRIAL_STATE, demoCalls, paymentCalls, setLicenseState, setTemporalUsage,
  stubDemoLicense, stubPayments,
} from './fixtures/subscription-state';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ appTag: 'subscription' });

const PLANS = [
  { id: 'monthly', period: 'month', durationDays: 30, discountPercent: 0, price: 99, priceUSD: 14, originalPrice: 99, originalPriceUSD: 14, currency: 'cny' },
  { id: 'quarterly', period: 'quarter', durationDays: 90, discountPercent: 5, price: 282, priceUSD: 40, originalPrice: 297, originalPriceUSD: 42, currency: 'cny' },
  { id: 'semi_annual', period: 'half_year', durationDays: 180, discountPercent: 10, price: 535, priceUSD: 76, originalPrice: 594, originalPriceUSD: 85, currency: 'cny' },
  { id: 'annual', period: 'year', durationDays: 365, discountPercent: 15, price: 1010, priceUSD: 144, originalPrice: 1188, originalPriceUSD: 170, currency: 'cny' },
];

const METHODS = [
  { id: 'wechat_pay', enabled: true, name: 'WeChat Pay', icon: '微', color: '#07c160' },
  { id: 'card', enabled: true, name: 'Bank Card', icon: '💳', color: null },
];

const ORDER = {
  orderId: 'e2e-order-1', planId: 'quarterly', method: 'wechat_pay', status: 'pending',
  amount: 28200, currency: 'cny', createdAt: 0,
  presentAs: 'embedded', redirectUrl: 'https://checkout.example/e2e-order-1',
};

/** Put the app in a given licence state and reload into it. */
async function asState(electronApp: ElectronApplication, page: Page, state: unknown) {
  await setLicenseState(electronApp, state);
  await page.reload();
  await expect(page.getByTestId('status-bar')).toBeVisible();
}

/**
 * Get the app into the editor with a video loaded. The job is stubbed at the
 * IPC layer so no Python process is spawned — same approach as sidebar.spec.
 */
async function loadVideo(page: Page, electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dialog:openFile');
    ipcMain.handle('dialog:openFile', async () => '/fake/video.mp4');
    ipcMain.removeHandler('job:start');
    ipcMain.handle('job:start', () => true);
  });
  if (await page.locator('[data-testid="empty-state"]').isVisible()) {
    await page.getByTestId('empty-state').click();
  } else {
    await page.getByTestId('change-video').click();
  }
  await expect(page.getByTestId('btn-export')).toBeVisible({ timeout: 10_000 });
}

test.describe('on a free trial', () => {
  test.beforeEach(async ({ electronApp, page }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
    await asState(electronApp, page, TRIAL_STATE);
  });

  test('counts the trial down in the bottom bar', async ({ page }) => {
    await expect(page.getByTestId('subscription-bar-label')).toHaveText(/free trial \([12] days \d{2}:\d{2} left\)/);
    await expect(page.getByTestId('status-bar-subscribe')).toBeVisible();
  });

  test('caps previews at one second, and says why', async ({ page, electronApp }) => {
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('preview-locked')).toBeVisible();
    await expect(page.getByTestId('preview-seconds')).toHaveValue('1');
    await expect(page.locator('[data-testid="preview-seconds"] option[value="5"]')).toBeDisabled();
  });

  test('lends temporal fill while the trial has runs left, and counts them', async ({ page, electronApp }) => {
    // The trial used to get none of this method at all. It now gets three
    // exports of it, and the card says how many are left before they run out
    // rather than only once the number reaches zero.
    await setTemporalUsage(electronApp, { used: 0, remaining: 3, allowed: true });
    await page.reload();
    await loadVideo(page, electronApp);

    const temporal = page.getByTestId('method-temporal');
    // Not `toBeEnabled`: temporal fill also needs four cores and 4 GB, and a
    // runner may have neither — a different reason, checked in sidebar.spec.
    // What the allowance decides is that neither the subscription nor a spent
    // allowance is what stands in the way.
    await expect(temporal).not.toContainText('Needs a subscription');
    await expect(temporal).not.toContainText('trial runs');
    await expect(page.getByTestId('temporal-uses-left')).toHaveText('3 left');
  });

  test('takes it back once the runs are spent, and says which limit was hit', async ({ page, electronApp }) => {
    await setTemporalUsage(electronApp, { used: 3, remaining: 0, allowed: false });
    await page.reload();
    await loadVideo(page, electronApp);

    const temporal = page.getByTestId('method-temporal');
    await expect(temporal).toBeDisabled();
    // "Needs a subscription" on a method they ran twice this morning reads as
    // a bug; this has to name the allowance that ran out.
    await expect(temporal).toContainText('trial runs');
    await expect(page.getByTestId('temporal-uses-left')).toBeHidden();
  });

  test('greys temporal fill out with no allowance at all, as before', async ({ page, electronApp }) => {
    // An ended trial gets the method back the way it was: locked, and asking
    // for a subscription rather than reporting a spent allowance.
    await setTemporalUsage(electronApp, { used: 0, remaining: 3, allowed: false });
    await page.reload();
    await loadVideo(page, electronApp);

    const temporal = page.getByTestId('method-temporal');
    await expect(temporal).toBeDisabled();
    await expect(temporal).toContainText('Needs a subscription');
  });
});

test.describe('the subscription page', () => {
  test.beforeEach(async ({ electronApp, page }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
    await asState(electronApp, page, TRIAL_STATE);
  });

  test('shows the plans and prices the service returned', async ({ page }) => {
    await page.getByTestId('nav-subscription').click();

    await expect(page.getByTestId('plan-monthly')).toContainText('¥99/month');
    await expect(page.getByTestId('plan-quarterly')).toContainText('¥282/quarter');
    await expect(page.getByTestId('plan-semi_annual')).toContainText('¥535/6 months');
    await expect(page.getByTestId('plan-annual')).toContainText('¥1010/year');
  });

  test('offers the payment methods the service says are usable', async ({ page }) => {
    await page.getByTestId('nav-subscription').click();

    await expect(page.getByTestId('pay-wechat_pay')).toContainText('WeChat Pay');
    await expect(page.getByTestId('pay-card')).toContainText('Bank Card');
    // The first one the service listed is selected, not a hardcoded default.
    await expect(page.getByTestId('pay-wechat_pay')).toHaveAttribute('aria-pressed', 'true');
  });

  test('opens from the bottom bar too', async ({ page }) => {
    await page.getByTestId('status-bar-subscribe').click();
    await expect(page.getByTestId('subscription-page')).toBeVisible();
  });
});


test.describe('the demo licence', () => {
  /**
   * The entry that hands out seven days with no payment, driven through the
   * real preload bridge and the real IPC channels — what the main process
   * does at the other end is stubbed, for the reason `stubDemoLicense`
   * gives.
   */
  const DEMO_STATE = {
    status: 'active',
    payload: {
      userId: 'e2e-user', appId: 'smoothvoice', planId: 'demo',
      licenseKey: 'DEMO-E2E', expiresAt: 4_102_444_800, issuedAt: 0,
    },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    daysRemaining: 7,
    graceDaysLeft: 0,
    trial: { ...TRIAL_STATE.trial, active: false },
  };

  test.beforeEach(async ({ electronApp }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
  });

  test('offers seven free days on the subscription page', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp);
    await asState(electronApp, page, TRIAL_STATE);
    await page.getByTestId('nav-subscription').click();

    const panel = page.getByTestId('demo-license');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('7 days');
    await expect(panel).toContainText('no payment');
  });

  test('activates on one click, with nothing typed in', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp);
    await asState(electronApp, page, TRIAL_STATE);
    await page.getByTestId('nav-subscription').click();

    await page.getByTestId('demo-activate').click();
    await expect(page.getByTestId('demo-success')).toBeVisible();

    // It went over the real channel, and it carried no code.
    const calls = await demoCalls(electronApp);
    expect(calls.activations).toEqual([{ code: null }]);
  });

  test('takes an activation code too, and passes it through unchanged', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp);
    await asState(electronApp, page, TRIAL_STATE);
    await page.getByTestId('nav-subscription').click();

    await page.getByTestId('demo-code').fill('DEMO-2026');
    await page.getByTestId('demo-code-submit').click();
    await expect(page.getByTestId('demo-success')).toBeVisible();

    const calls = await demoCalls(electronApp);
    expect(calls.activations).toEqual([{ code: 'DEMO-2026' }]);
  });

  test('says a device has already had its demo, rather than offering another', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp, { used: true });
    await asState(electronApp, page, TRIAL_STATE);
    await page.getByTestId('nav-subscription').click();

    await expect(page.getByTestId('demo-activate')).toBeDisabled();
  });

  test('counts a running demo down, and still sells a subscription', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp, { used: true });
    await asState(electronApp, page, DEMO_STATE);
    await page.getByTestId('nav-subscription').click();

    await expect(page.getByTestId('demo-remaining')).toContainText(/[67] days \d{2}:\d{2} left/);
    // Named as a demo everywhere, not as a plan somebody bought.
    await expect(page.getByTestId('subscription-bar-label')).toHaveText('Subscription: Demo licence');
    // And the paid entry is untouched: a demo is upgraded by buying one.
    await expect(page.getByTestId('subscribe-annual')).toBeEnabled();
  });

  test('unlocks temporal fill for as long as it runs', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp, { used: true });
    await asState(electronApp, page, DEMO_STATE);
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('method-temporal')).not.toContainText('Needs a subscription');
    await expect(page.getByTestId('preview-locked')).toBeHidden();
  });

  test('locks them again once it has expired, and asks for a plan', async ({ electronApp, page }) => {
    await stubDemoLicense(electronApp, { used: true });
    await asState(electronApp, page, {
      ...DEMO_STATE,
      status: 'expired',
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      daysRemaining: 0,
      trial: { ...TRIAL_STATE.trial, active: false },
    });
    await setTemporalUsage(electronApp, { used: 3, remaining: 0, allowed: false });
    await page.reload();
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('method-temporal')).toBeDisabled();
    await expect(page.getByTestId('status-bar-subscribe')).toBeVisible();
  });
});

test.describe('paying', () => {
  test('creates an order, opens the checkout, and waits for the service', async ({ page, electronApp }) => {
    await stubPayments(electronApp, {
      plans: PLANS,
      methods: METHODS,
      order: ORDER,
      // Pending first, then paid: what polling an order that settles looks like.
      statuses: [{ status: 'pending' }, { status: 'paid', licensed: true, state: LICENSED_STATE }],
    });
    await asState(electronApp, page, TRIAL_STATE);

    await page.getByTestId('nav-subscription').click();
    await page.getByTestId('subscribe-quarterly').click();

    // The app waits rather than asking the user whether they paid.
    await expect(page.getByTestId('payment-dialog')).toBeVisible();
    await expect(page.getByTestId('subscribe-success')).toBeVisible({ timeout: 30_000 });

    const calls = await paymentCalls(electronApp);
    // A QR-code method gets its own window; the checkout URL is the
    // provider's and is never loaded into the app's own window.
    expect(calls.opened).toContain(`embedded:${ORDER.redirectUrl}`);
    expect(calls.statusCalls).toBeGreaterThan(1);
  });

  test('opens the system browser for a method that presents there', async ({ page, electronApp }) => {
    await stubPayments(electronApp, {
      plans: PLANS,
      methods: METHODS,
      order: { ...ORDER, method: 'card', presentAs: 'external' },
      statuses: [{ status: 'paid', licensed: true, state: LICENSED_STATE }],
    });
    await asState(electronApp, page, TRIAL_STATE);

    await page.getByTestId('nav-subscription').click();
    await page.getByTestId('pay-card').click();
    await page.getByTestId('subscribe-quarterly').click();
    await expect(page.getByTestId('subscribe-success')).toBeVisible({ timeout: 30_000 });

    const calls = await paymentCalls(electronApp);
    expect(calls.opened).toContain(`external:${ORDER.redirectUrl}`);
  });

  test('says what went wrong when the order cannot be created', async ({ page, electronApp }) => {
    await stubPayments(electronApp, {
      plans: PLANS, methods: METHODS, order: { error: 'payment method not available' },
    });
    await asState(electronApp, page, TRIAL_STATE);

    await page.getByTestId('nav-subscription').click();
    await page.getByTestId('subscribe-monthly').click();

    await expect(page.getByTestId('subscribe-error')).toContainText('payment method not available');
    expect((await paymentCalls(electronApp)).opened).toEqual([]);
  });
});

test.describe('which app the licence is for', () => {
  /**
   * The service holds one set of tables for every app on the account, so what
   * this build calls itself decides whose trial and whose subscription it
   * gets. Both halves are worth reaching through the real app: the id it
   * declares, and what it says when the service scopes something elsewhere.
   */
  test('declares itself to the licence service', async ({ page, electronApp }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
    await asState(electronApp, page, TRIAL_STATE);

    // Through the preload bridge, as the renderer reads it: a build carrying
    // the wrong appId looks exactly like one whose subscription vanished.
    const appId = await page.evaluate(async () =>
      (await (window as any).electronAPI.licenseConfig()).appId);
    expect(appId).toBe('smoothvoice');
  });

  test('explains a subscription that belongs to another app', async ({ page, electronApp }) => {
    // Retrying never fixes this, so the page must not word it as a payment
    // that failed — it tells the user to activate here instead.
    await stubPayments(electronApp, {
      plans: PLANS, methods: METHODS,
      order: { error: 'appId mismatch', code: 'app_mismatch' },
    });
    await asState(electronApp, page, TRIAL_STATE);

    await page.getByTestId('nav-subscription').click();
    await page.getByTestId('subscribe-monthly').click();

    await expect(page.getByTestId('subscribe-error')).toContainText(/different app/i);
    await expect(page.getByTestId('subscribe-error')).not.toContainText('appId mismatch');
    expect((await paymentCalls(electronApp)).opened).toEqual([]);
  });
});

test.describe('with a licence in force', () => {
  test.beforeEach(async ({ electronApp, page }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
    await asState(electronApp, page, LICENSED_STATE);
  });

  test('names the plan in the bar and drops the prompt', async ({ page }) => {
    await expect(page.getByTestId('subscription-bar-label')).toHaveText('Subscription: Yearly');
    await expect(page.getByTestId('status-bar-subscribe')).toBeHidden();
  });

  test('lifts the preview cap, and stops the licence blocking temporal fill', async ({ page, electronApp }) => {
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('preview-locked')).toBeHidden();
    await page.getByTestId('preview-seconds').selectOption('5');
    await expect(page.getByTestId('preview-seconds')).toHaveValue('5');

    // Not `toBeEnabled`: temporal fill also needs four cores and 4 GB, and a
    // runner may have neither — that is a different reason, checked in
    // sidebar.spec. What a licence decides is that the *subscription* is no
    // longer what is standing in the way.
    await expect(page.getByTestId('method-temporal')).not.toContainText('Needs a subscription');
  });

  test('shows the plan, its end date, and that nothing renews itself', async ({ page }) => {
    await page.getByTestId('nav-subscription').click();

    const panel = page.getByTestId('manage-subscription');
    await expect(panel).toContainText('Yearly');
    await expect(panel).toContainText('Runs until');
    await expect(panel).toContainText('nothing renews automatically');
  });
});

test.describe('in the grace period', () => {
  test('keeps the features working but still asks for a renewal', async ({ page, electronApp }) => {
    await stubPayments(electronApp, { plans: PLANS, methods: METHODS });
    await asState(electronApp, page, {
      ...LICENSED_STATE,
      status: 'grace_period',
      daysRemaining: 0,
      graceDaysLeft: 2,
    });

    await expect(page.getByTestId('subscription-bar-label')).toContainText('2 days of grace');
    // The prompt stays: the grace period is the last chance to notice.
    await expect(page.getByTestId('status-bar-subscribe')).toBeVisible();

    await loadVideo(page, electronApp);
    // Same as above: the grace period stops the licence being the blocker,
    // whatever the runner's hardware says about temporal fill.
    await expect(page.getByTestId('method-temporal')).not.toContainText('Needs a subscription');
  });
});
