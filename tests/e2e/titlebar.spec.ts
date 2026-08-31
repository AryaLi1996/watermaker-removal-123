/**
 * E2E: the top bar doubles as the window's title bar.
 *
 * On macOS this strip is the only thing at the top of the window — the system
 * title bar is hidden — so two properties have to hold at once: the strip
 * drags the window, and every control in it still takes a click. They pull
 * against each other, because a control inside a drag region stops responding
 * to the pointer entirely. A missed `no-drag` does not look broken in a
 * screenshot; the button simply stops working.
 *
 * These run on every platform even though only macOS hides the title bar: the
 * CSS is the same everywhere, so a regression is caught wherever CI runs
 * rather than only on the one runner that could see it by eye.
 */
import { test, expect } from './fixtures/electron-fixture';
import type { Page } from '@playwright/test';

test.use({ appTag: 'titlebar' });

/** What the compositor will do with a press on this element. */
function appRegion(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
  }, selector);
}

test.describe('the top bar', () => {
  test('drags the window, since on macOS it is the only title bar there is', async ({ page }) => {
    await expect(page.locator('.app-topbar')).toBeVisible();
    expect(await appRegion(page, '.app-topbar')).toBe('drag');
  });

  test('gives every control back to the pointer', async ({ page }) => {
    // A control left inside the drag region starts a window move instead of
    // firing, so this asserts the exemption rather than the appearance.
    for (const selector of ['[data-testid="nav-editor"]', '[data-testid="language-select"]']) {
      expect(await appRegion(page, selector), selector).toBe('no-drag');
    }
  });

  test('still navigates when clicked, not merely styled to', async ({ page }) => {
    // The regression this guards: `drag` on the strip swallowing the click.
    await page.getByTestId('nav-subscription').click();
    await expect(page.getByTestId('subscription-page')).toBeVisible();
    await page.getByTestId('nav-editor').click();
    await expect(page.getByTestId('subscription-page')).toBeHidden();
  });

  test('keeps its contents clear of the corner the window controls use', async ({ page }) => {
    // Off macOS the reservation is zero, so the assertion is the ordering
    // rather than a figure: whatever is reserved, nothing is drawn inside it.
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector('.app-topbar');
      if (!bar) return null;
      const padding = parseFloat(getComputedStyle(bar).paddingLeft);
      const barLeft = bar.getBoundingClientRect().left;
      const children = [...bar.children].map((c) => c.getBoundingClientRect().left - barLeft);
      return { padding, firstChild: Math.min(...children) };
    });
    expect(overlap).not.toBeNull();
    expect(overlap!.firstChild).toBeGreaterThanOrEqual(overlap!.padding);
  });
});
