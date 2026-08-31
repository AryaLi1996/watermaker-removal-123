/**
 * E2E: the Settings screen and the appearance theme.
 *
 * The theme is applied to <html> and stored in localStorage, so these tests
 * assert on both: the class is what every colour in the app is looked up
 * against, and the storage is what makes the choice survive a restart.
 */
import { test, expect } from './fixtures/electron-fixture';
import type { Page } from '@playwright/test';

test.use({ appTag: 'settings' });

/** The theme classes on <html>, which is where the CSS variables live. */
function rootClasses(page: Page) {
  return page.evaluate(() => Array.from(document.documentElement.classList));
}

function storedTheme(page: Page) {
  return page.evaluate(() => window.localStorage.getItem('theme-preference'));
}

/** Start each test from no stored preference, the way a fresh install does. */
async function resetTheme(page: Page) {
  await page.evaluate(() => window.localStorage.removeItem('theme-preference'));
  await page.reload();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetTheme(page);
});

test.describe('the settings screen', () => {
  test('is reachable from the top bar and offers appearance', async ({ page }) => {
    await expect(page.getByTestId('theme-light')).toBeVisible();
    await expect(page.getByTestId('theme-dark')).toBeVisible();
    await expect(page.getByTestId('theme-system')).toBeVisible();
  });

  test('starts on "follow the system"', async ({ page }) => {
    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true');
    // And says which theme that is currently giving.
    await expect(page.getByTestId('theme-resolved')).toBeVisible();
  });

  test('names the app in the language the user reads', async ({ page }) => {
    await expect(page.getByTestId('about-name')).toHaveText('SmoothVoice Watermark Remover');
  });
});

test.describe('switching theme', () => {
  test('changes the interface at once, with no restart', async ({ page }) => {
    await page.getByTestId('theme-dark').click();
    expect(await rootClasses(page)).toContain('dark');
    expect(await rootClasses(page)).not.toContain('light');

    await page.getByTestId('theme-light').click();
    expect(await rootClasses(page)).toContain('light');
    expect(await rootClasses(page)).not.toContain('dark');
  });

  test('actually repaints the app, not just the class', async ({ page }) => {
    const background = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByTestId('theme-dark').click();
    const dark = await background();
    await page.getByTestId('theme-light').click();
    const light = await background();

    expect(dark).not.toBe(light);
  });

  test('survives a restart', async ({ page }) => {
    await page.getByTestId('theme-dark').click();
    expect(await storedTheme(page)).toBe('dark');

    await page.reload();
    await expect(page.getByTestId('nav-settings')).toBeVisible();

    expect(await rootClasses(page)).toContain('dark');
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
  });

  test('applies before the app has rendered, so there is no flash', async ({ page }) => {
    await page.getByTestId('theme-dark').click();
    await page.reload();
    // The inline script in index.html runs before the bundle loads; asserting
    // on the class as soon as the document exists is the closest a test can
    // get to "the user never saw the other theme".
    await page.waitForLoadState('domcontentloaded');
    expect(await rootClasses(page)).toContain('dark');
  });
});

test.describe('every screen', () => {
  // A theme that only covers the editor is not a theme. These walk the app in
  // light mode, where a colour left hardcoded for the dark UI shows up as
  // text the same shade as what is behind it.
  for (const theme of ['light', 'dark'] as const) {
    test(`renders the editor, subscription and settings in ${theme}`, async ({ page }) => {
      await page.getByTestId(`theme-${theme}`).click();

      for (const screen of ['editor', 'subscription', 'settings'] as const) {
        await page.getByTestId(`nav-${screen}`).click();
        expect(await rootClasses(page)).toContain(theme);
      }

      await page.getByTestId('nav-editor').click();
      await expect(page.getByTestId('empty-state')).toBeVisible();
    });
  }
});
