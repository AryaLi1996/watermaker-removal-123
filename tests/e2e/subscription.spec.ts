/**
 * E2E: the subscription, through the real IPC handlers and the record the
 * main process keeps on disk.
 *
 * The record lives in the app's user-data directory, so these tests clear it
 * between cases the way a fresh install would be — otherwise the first
 * purchase decides every test after it.
 */
import { test, expect } from './fixtures/electron-fixture';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ appTag: 'subscription' });

/** Put the app back to a first launch: no record, so a new trial is granted. */
async function resetSubscription(electronApp: ElectronApplication, page: Page) {
  await electronApp.evaluate(({ app }) => {
    const fs = require('fs');
    const path = require('path');
    fs.rmSync(path.join(app.getPath('userData'), 'subscription.json'), { force: true });
  });
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

/** Walk a plan through the simulated payment dialog. */
async function buy(page: Page, plan: string, method: 'wechat' | 'alipay' = 'wechat') {
  await page.getByTestId('nav-subscription').click();
  await page.getByTestId(`pay-${method}`).click();
  await page.getByTestId(`subscribe-${plan}`).click();
  await expect(page.getByTestId('payment-qr')).toBeVisible();
  await page.getByTestId('payment-confirm').click();
  await expect(page.getByTestId('subscribe-success')).toBeVisible();
}

test.beforeEach(async ({ electronApp, page }) => {
  await resetSubscription(electronApp, page);
});

test.describe('the free trial', () => {
  test('starts on first launch and is reported in the bottom bar', async ({ page }) => {
    await expect(page.getByTestId('subscription-bar-label')).toContainText('free trial');
    // Three days, so the countdown reads two-and-something days left.
    await expect(page.getByTestId('subscription-bar-label')).toContainText('2 days');
  });

  test('does not restart itself on the next launch', async ({ page }) => {
    const first = await page.getByTestId('subscription-bar-label').textContent();
    await page.reload();
    await expect(page.getByTestId('subscription-bar-label')).toHaveText(first!);
  });

  test('caps previews at one second, and says why', async ({ page, electronApp }) => {
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('preview-locked')).toBeVisible();
    await expect(page.getByTestId('preview-seconds')).toHaveValue('1');
    await expect(page.locator('[data-testid="preview-seconds"] option[value="5"]')).toBeDisabled();
  });
});

test.describe('the subscription page', () => {
  test('lists the four plans at their discounted prices', async ({ page }) => {
    await page.getByTestId('nav-subscription').click();

    await expect(page.getByTestId('plan-monthly')).toContainText('¥99/month');
    await expect(page.getByTestId('plan-quarterly')).toContainText('¥282/quarter');
    await expect(page.getByTestId('plan-halfyear')).toContainText('¥534/6 months');
    await expect(page.getByTestId('plan-yearly')).toContainText('¥1009/year');
  });

  test('opens from the bottom bar too', async ({ page }) => {
    await page.getByTestId('status-bar-subscribe').click();
    await expect(page.getByTestId('subscription-page')).toBeVisible();
  });

  test('shows a payment code, and charges nothing until it is confirmed', async ({ page }) => {
    await page.getByTestId('nav-subscription').click();
    await page.getByTestId('subscribe-monthly').click();
    await expect(page.getByTestId('payment-dialog')).toBeVisible();
    await expect(page.getByTestId('payment-summary')).toContainText('¥99');

    await page.getByTestId('payment-cancel').click();
    await expect(page.getByTestId('payment-dialog')).toBeHidden();
    await expect(page.getByTestId('subscription-bar-label')).toContainText('free trial');
  });
});

test.describe('a paid plan', () => {
  test('replaces the trial in the bottom bar and survives a restart', async ({ page }) => {
    await buy(page, 'quarterly', 'alipay');

    await expect(page.getByTestId('subscription-bar-label')).toHaveText('Subscription: Quarterly');
    await expect(page.getByTestId('status-bar-subscribe')).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('subscription-bar-label')).toHaveText('Subscription: Quarterly');
  });

  test('lifts the preview cap the free tier imposes', async ({ page, electronApp }) => {
    await buy(page, 'yearly');
    await page.getByTestId('nav-editor').click();
    await loadVideo(page, electronApp);

    await expect(page.getByTestId('preview-locked')).toBeHidden();
    await page.getByTestId('preview-seconds').selectOption('5');
    await expect(page.getByTestId('preview-seconds')).toHaveValue('5');
  });

  test('can have its auto-renewal cancelled without losing the plan', async ({ page }) => {
    await buy(page, 'halfyear');

    await expect(page.getByTestId('manage-subscription')).toContainText('Auto-renewal is on');
    await page.getByTestId('cancel-auto-renew').click();

    await expect(page.getByTestId('auto-renew-cancelled')).toBeVisible();
    await expect(page.getByTestId('manage-subscription')).toContainText('Auto-renewal is off');
    // The plan itself is untouched — it runs to the date that was paid for.
    await expect(page.getByTestId('subscription-bar-label')).toHaveText('Subscription: 6 months');
  });
});
