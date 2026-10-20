/**
 * Visual regression: the glassmorphic iOS dock (and the Home screen around it) across viewports.
 *
 * Every test logs in as a brand-new user, so the screen content is identical on every run
 * (₱0.00 balance, no card, no transactions); only the account number differs, and it is masked.
 * Baselines live next to this file in dock.visual.spec.ts-snapshots/, one set per OS
 * (fonts render differently on Windows and Linux). Update them after an intended UI change:
 *   npx playwright test --project=visual --update-snapshots
 */
import { test, expect, type Page } from '@playwright/test';
import { createUser } from '../helpers/api';
import { login } from '../helpers/ui';

const VIEWPORTS = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-15', width: 393, height: 852 },
  { name: 'pixel-7', width: 412, height: 915 },
  { name: 'ipad-mini', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

/** Wait until every Home widget has its data, so nothing changes while the screenshot is taken. */
async function settle(page: Page) {
  await expect(page.getByTestId('savings-meta')).not.toBeEmpty();
  await expect(page.getByTestId('loan-tile-text')).toHaveText('Available: ₱50,000.00');
  await expect(page.getByTestId('bell-dot')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const vp of VIEWPORTS) {
  test.describe(`Glass dock @ ${vp.name} (${vp.width}x${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });

    test('dock on Home: frosted pill, raised Scan & Pay, active Home badge', async ({ page, request }) => {
      await login(page, await createUser(request, 'Visual Tester'));
      await settle(page);
      const dock = page.getByRole('navigation', { name: 'Main' });
      await expect(dock).toHaveScreenshot(`dock-home-${vp.name}.png`);
    });

    test('dock on the Card tab: active state moves to Card', async ({ page, request }) => {
      await login(page, await createUser(request, 'Visual Tester'));
      await settle(page);
      await page.getByTestId('nav-card').click();
      await expect(page.getByTestId('card-empty')).toBeVisible();
      await page.mouse.move(0, 0); // no hover state on the tab
      const dock = page.getByRole('navigation', { name: 'Main' });
      await expect(dock).toHaveScreenshot(`dock-card-${vp.name}.png`);
    });

    test('Home screen with the dock over the content', async ({ page, request }) => {
      await login(page, await createUser(request, 'Visual Tester'));
      await settle(page);
      await expect(page).toHaveScreenshot(`home-${vp.name}.png`, {
        mask: [page.getByTestId('account-number')],
      });
    });
  });
}
