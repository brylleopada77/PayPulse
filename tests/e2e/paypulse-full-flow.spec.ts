/**
 * PayPulse end-to-end flows in a real browser (Playwright project "ui", Google Chrome).
 *
 * Every test creates its own users through the API (so tests can run in parallel) and then drives
 * the web wallet like a customer. MPINs are random per user (and "123456" is rejected as too easy
 * to guess), so each test types the MPIN its user received at registration.
 */
import { test, expect } from '@playwright/test';
import { authHeader, createFundedUser, createUser, getBalanceCents, transfer } from '../helpers/api';
import { login, peso, typeCode } from '../helpers/ui';

test.describe('PayPulse full flow', () => {
  test('Pay Bills: Meralco ₱1,000 with MPIN -> receipt, and the net deduction is exactly ₱995.00', async ({ page, request }) => {
    const alice = await createFundedUser(request, 2000, 'Alice Reyes');
    await login(page, alice);
    const before = await getBalanceCents(request, alice);

    await page.getByTestId('open-bills').click();
    await page.getByTestId('bills-category-UTILITIES').click();
    await page.getByTestId('biller-MERALCO').click();
    await page.getByTestId('bills-account').fill('1234567890');
    await page.getByTestId('bills-account-name').fill('Alice Reyes');
    await page.getByTestId('bills-amount').fill('1000');
    await page.getByTestId('bills-continue').click();

    await expect(page.getByTestId('bills-total')).toHaveText('₱1,000.00');
    await expect(page.getByTestId('bills-cashback-banner')).toContainText('Earn ₱5.00 Cashback');
    await typeCode(page, 'bills-mpin-input', alice.mpin);
    await page.getByTestId('bills-pay').click();

    // Receipt modal pops up with the REF-BILL reference and the cashback stamp
    await expect(page.getByTestId('receipt-dialog')).toBeVisible();
    await expect(page.getByTestId('receipt-title')).toHaveText('Bills Payment Successful');
    await expect(page.getByTestId('receipt-ref')).toHaveText(/^REF-BILL-\d{8}-\d{4,}$/);
    await expect(page.getByTestId('receipt-cashback')).toHaveText('🎁 Cashback Earned: ₱5.00');
    await page.getByTestId('receipt-done').click();

    // ₱1,000 out, ₱5 cashback back in: net ₱995.00
    const after = await getBalanceCents(request, alice);
    expect(before - after).toBe(99_500);
    await expect(page.getByTestId('balance')).toHaveText(peso(after));
    await expect(page.getByTestId('tx-item').first()).toContainText('Cashback Reward - Bills Payment');
    await expect(page.getByTestId('tx-item').nth(1)).toContainText('Bill Payment - Meralco');
  });

  test('Instant Loan: ₱10,000 drawdown is credited immediately and shows in the history', async ({ page, request }) => {
    const bob = await createUser(request, 'Bob Santos');
    await login(page, bob);
    await expect(page.getByTestId('balance')).toHaveText('₱0.00');

    await page.getByTestId('loan-open').click();
    await page.getByTestId('loan-amount').fill('10000');
    await page.getByTestId('loan-term-6').check({ force: true });
    await expect(page.getByTestId('loan-amount-out')).toHaveText('₱10,000.00');
    await expect(page.getByTestId('loan-quote')).toContainText('₱10,900.00'); // total to repay at 1.5% x 6
    await page.getByTestId('loan-submit').click();
    await typeCode(page, 'card-mpin-input', bob.mpin);
    await page.locator('#card-mpin-form [type="submit"]').click();

    await expect(page.getByTestId('receipt-title')).toHaveText('Loan Disbursed');
    await page.getByTestId('receipt-done').click();

    await expect(page.getByTestId('balance')).toHaveText('₱10,000.00');
    expect(await getBalanceCents(request, bob)).toBe(1_000_000);
    const latest = page.getByTestId('tx-item').first();
    await expect(latest).toContainText('Loan Disbursement');
    await expect(latest).toContainText('+₱10,000.00');
    await expect(page.getByTestId('loan-tile-text')).toContainText('You owe ₱10,900.00');
  });

  test('Locked virtual card: an online payment is refused with 403, nothing is charged', async ({ page, request }) => {
    const carol = await createFundedUser(request, 1000, 'Carol Lim');
    await login(page, carol);

    // Issue the card in the UI, then lock it with the Freeze / Lock switch
    await page.getByTestId('nav-card').click();
    await page.getByTestId('card-generate').click();
    await typeCode(page, 'card-mpin-input', carol.mpin);
    await page.locator('#card-mpin-form [type="submit"]').click();
    await expect(page.getByTestId('vcard')).toBeVisible();
    await page.getByTestId('card-freeze').check({ force: true });
    await expect(page.getByTestId('card-lock-hint')).toHaveText('Card is locked: every payment is declined');

    // An online card payment against the locked card: 403 Forbidden
    const { cards } = await (await request.get('/api/v1/cards', { headers: authHeader(carol.token) })).json();
    expect(cards[0].status).toBe('FROZEN');
    const response = await request.post(`/api/v1/cards/${cards[0].token}/payments`, {
      data: { amount: 250, merchant: 'Lazada' },
      headers: authHeader(carol.token),
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error).toMatchObject({ code: 'CARD_FROZEN', details: { declined: true } });

    // The same purchase from the UI is declined with a clear message; the balance is untouched
    await page.getByTestId('card-pay-amount').fill('250');
    await page.getByTestId('card-pay-submit').click();
    await expect(page.locator('#card-pay-form .form-error')).toContainText('this card is locked');
    expect(await getBalanceCents(request, carol)).toBe(100_000);

    // Unlocking needs the MPIN; then the purchase (also MPIN-confirmed) goes through
    await page.getByTestId('card-freeze').click({ force: true }); // stays locked until the MPIN is confirmed
    await expect(page.getByTestId('card-mpin-dialog')).toBeVisible();
    await expect(page.getByTestId('card-freeze')).toBeChecked();
    await typeCode(page, 'card-mpin-input', carol.mpin);
    await page.locator('#card-mpin-form [type="submit"]').click();
    await expect(page.getByTestId('card-lock-hint')).toHaveText('Card is active: online payments are allowed');
    await page.getByTestId('card-pay-amount').fill('250');
    await page.getByTestId('card-pay-submit').click();
    await typeCode(page, 'card-mpin-input', carol.mpin);
    await page.locator('#card-mpin-form [type="submit"]').click();
    await expect(page.getByTestId('receipt-title')).toHaveText('Card Payment Approved');
    expect(await getBalanceCents(request, carol)).toBe(75_000);
  });

  test('Real-time: incoming money shows a live toast, rings the bell and updates the balance', async ({ page, request }) => {
    const dan = await createUser(request, 'Dan Cruz');
    const erin = await createFundedUser(request, 1000, 'Erin Go');
    await login(page, dan);
    await page.waitForFunction(() => (window as unknown as { io?: unknown }).io !== undefined);
    await page.waitForTimeout(500); // let the socket finish connecting

    await transfer(request, erin, { toAccountNumber: dan.accountNumber, amount: 500 });

    const toast = page.getByTestId('live-toast').first();
    await expect(toast).toContainText(`Received ₱500.00 from Account ${erin.accountNumber}`);
    await expect(page.getByTestId('bell-dot')).toBeVisible();
    await expect(page.getByTestId('balance')).toHaveText('₱500.00'); // no reload, no Refresh click

    await toast.locator('.live-toast-main').click(); // a live toast opens its receipt
    await expect(page.getByTestId('receipt-title')).toHaveText('Money Received');
  });
});

test.describe('Appearance (iOS dark glass)', () => {
  test.use({ colorScheme: 'dark' });

  test('Light (Royal Blue) is the default even on a dark device; Dark is remembered; Auto follows the device', async ({ page, request }) => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    await login(page, await createUser(request, 'Theme Tester'));
    expect(await theme()).toBe('light'); // default look: Royal Blue
    await expect(page.getByTestId('profile-dialog')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.getByTestId('savings-rate')).toHaveCSS('background-color', 'rgb(0, 82, 255)'); // solid blue rate badge

    await page.getByTestId('open-profile').click();
    const appearance = page.getByTestId('menu-appearance');
    await appearance.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('theme-light')).toBeChecked();
    await appearance.getByText('Dark').click();
    expect(await theme()).toBe('dark');

    await page.reload();
    await expect(page.getByTestId('balance')).not.toHaveText('—');
    expect(await theme()).toBe('dark'); // remembered on this device

    await page.getByTestId('open-profile').click();
    await expect(page.getByTestId('balance')).toHaveCSS('color', 'rgb(255, 255, 255)'); // white balance on the blue card

    await page.getByTestId('menu-appearance').getByText('Auto').click();
    await page.emulateMedia({ colorScheme: 'light' }); // the device switches to light
    await expect.poll(theme).toBe('light');
  });
});
