/**
 * Balance refresh: tapping Refresh shows the pulsing PayPulse logo (where the toast would be), then
 * the new balance. No "Balance updated" toast: the logo is the feedback.
 */
import { test, expect } from '@playwright/test';
import { createFundedUser, createUser, transfer } from '../helpers/api';
import { login } from '../helpers/ui';

test.describe('Balance refresh', () => {
  test('Refresh shows the logo while it reloads, then the new balance', async ({ page, request }) => {
    const alice = await createFundedUser(request, 1000, 'Alice Tan');
    const bob = await createFundedUser(request, 500, 'Bob Cruz');
    await login(page, alice);
    const indicator = page.getByTestId('refresh-indicator');
    await expect(indicator).toBeHidden(); // closed until Refresh is tapped
    await expect(page.getByTestId('balance')).toHaveText('₱1,000.00');

    // money arrives outside the page; hold the wallet call so the logo can be seen mid-refresh
    expect((await transfer(request, bob, { toAccountNumber: alice.accountNumber, amount: 250 })).status()).toBe(201);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/accounts/me', async (route) => { await held; await route.continue(); });

    const refresh = page.getByTestId('refresh');
    await refresh.click();
    await expect(indicator).toBeVisible();
    await expect(indicator.locator('.refresh-mark .boot-pulse')).toBeAttached();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');

    release();
    await expect(indicator).toBeHidden();
    await expect(refresh).not.toHaveAttribute('aria-busy');
    await expect(page.getByTestId('balance')).toHaveText('₱1,250.00');
    await expect(page.getByTestId('toast')).toBeHidden(); // no blank toast
  });

  test('a failed refresh hides the logo and shows the error', async ({ page, request }) => {
    await login(page, await createUser(request, 'Alice Tan'));
    await page.route('**/api/accounts/me', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong' } }) }));
    await page.getByTestId('refresh').click();
    await expect(page.getByTestId('toast')).toHaveClass(/error/);
    await expect(page.getByTestId('refresh-indicator')).toBeHidden();
  });
});
