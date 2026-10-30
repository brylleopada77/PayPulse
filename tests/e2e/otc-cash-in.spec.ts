/**
 * Cash In over the counter in a real browser: category pills over a 2-column partner grid (no inner
 * scrollbar), the amount with the counter fee, then the 12-digit code with its ITF barcode and a live
 * 24-hour countdown. The partner's signed webhook pays it and the screen turns "Paid" by itself.
 */
import { createHmac } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { WEBHOOK_SECRET, createAdmin, createUser } from '../helpers/api';
import { login } from '../helpers/ui';

async function openCashIn(page: Page) {
  await page.getByTestId('open-otc').click();
  await expect(page.getByTestId('otc-dialog')).toBeVisible();
}

const partner = (page: Page, name: RegExp | string) => page.getByTestId('otc-partners').getByRole('radio', { name });

test.describe('Cash In over the counter', () => {
  test('category pills filter the 2-column grid; nothing in the dialog scrolls on its own', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, await createUser(request, 'Alice Tan'));
    await openCashIn(page);

    const cards = page.getByTestId('otc-partners').getByTestId('otc-card');
    await expect(cards.filter({ visible: true })).toHaveCount(19);
    const tabs = page.getByTestId('otc-tabs');
    await tabs.getByRole('radio', { name: 'Pawnshops' }).click();
    await expect(cards.filter({ visible: true })).toHaveCount(7);
    await tabs.getByRole('radio', { name: 'Stores' }).click();
    await expect(cards.filter({ visible: true })).toHaveCount(4);
    await tabs.getByRole('radio', { name: 'Malls' }).click();
    await expect(cards.filter({ visible: true })).toHaveCount(4);
    await tabs.getByRole('radio', { name: 'Pharmacies' }).click();
    await expect(cards.filter({ visible: true })).toHaveCount(4);
    await tabs.getByRole('radio', { name: 'All', exact: true }).click();

    // logos where we have them, the badge where not; a fee tag on every card
    await expect(cards.filter({ hasText: 'Cebuana' }).locator('.bank-avatar img')).toHaveAttribute('src', '/img/otc/cebuana.png');
    await expect(cards.filter({ hasText: 'RD Pawnshop' }).locator('.bank-avatar')).toHaveText('RD');
    await expect(cards.filter({ hasText: 'Bayad Center' }).locator('.otc-fee-tag')).toHaveText('Free');
    await expect(cards.filter({ hasText: '7-Eleven' }).locator('.otc-fee-tag')).toHaveText('₱15 fee');
    const broken = await page.getByTestId('otc-partners').locator('img').evaluateAll((imgs) =>
      Promise.all(imgs.map((img) => (img as HTMLImageElement).decode().then(() => null, () => (img as HTMLImageElement).src))));
    expect(broken.filter(Boolean)).toEqual([]);

    // two columns
    const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    expect(Math.round(a!.y)).toBe(Math.round(b!.y));
    const innerScrollers = await page.getByTestId('otc-dialog').evaluate((dialog) =>
      [...dialog.querySelectorAll('*')].filter((el) => {
        const { overflowY } = getComputedStyle(el);
        return /auto|scroll/.test(overflowY) && el.scrollHeight > el.clientHeight + 1;
      }).map((el) => el.id || el.className));
    expect(innerScrollers).toEqual([]);
  });

  test('7-Eleven ₱500: fee ₱15, a 12-digit code with a barcode and countdown; the counter pays it and the screen turns Paid', async ({ page, request }) => {
    const alice = await createUser(request, 'Alice Tan');
    await login(page, alice);
    await openCashIn(page);

    await partner(page, /7-Eleven/).click();
    await expect(page.getByTestId('otc-partner')).toContainText('7-Eleven (CLiQQ)');
    await expect(page.getByTestId('otc-amount')).toBeFocused();
    await page.getByTestId('otc-amount').fill('500');
    await expect(page.getByTestId('otc-summary')).toContainText('Counter fee₱15.00');
    await expect(page.getByTestId('otc-summary')).toContainText('Pay at the counter₱515.00');
    await expect(page.getByTestId('otc-summary')).toContainText('Added to your wallet₱500.00');
    await page.getByTestId('otc-generate').click();

    const ref = page.getByTestId('otc-ref');
    await expect(ref).toHaveText(/^\d{4} \d{4} \d{4}$/);
    await expect(page.getByTestId('otc-pay')).toHaveText('₱515.00');
    await expect(page.getByTestId('otc-status')).toHaveText('Waiting for payment');
    await expect(page.getByTestId('otc-expiry')).toContainText(/Valid for 24 hours · Expires in 23:59:\d\d/);
    await expect(page.getByTestId('otc-howto')).toHaveText(
      'Present this reference code or barcode to the cashier at any 7-Eleven (CLiQQ) branch and pay the exact amount.');
    // ITF: 12 digits -> 2 start bars + 6 pairs x 5 bars + 2 stop bars
    await expect(page.getByTestId('otc-barcode').locator('rect')).toHaveCount(2 + 30 + 2);

    // the cashier takes ₱515: the partner confirms; the open screen notices by itself
    const reference = (await ref.textContent())!.replaceAll(' ', '');
    const body = JSON.stringify({ reference, amountPaid: '515.00' });
    const paid = await request.post('/api/webhooks/otc', {
      data: body,
      headers: { 'X-PayPulse-Signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'), 'Content-Type': 'application/json' },
    });
    expect(paid.status()).toBe(200);
    await expect(page.getByTestId('otc-status')).toHaveText('Paid · ₱500.00 added to your wallet', { timeout: 15_000 });
    await page.getByTestId('otc-done').click();
    await expect(page.getByTestId('balance')).toHaveText('₱500.00');
    await expect(page.getByTestId('tx-item').first()).toContainText(`Cash in at 7-Eleven (CLiQQ) (${await ref.textContent()})`);
  });

  test('an unpaid code is listed when Cash In opens again; below ₱100 is refused before any request', async ({ page, request }) => {
    await login(page, await createUser(request, 'Alice Tan'));
    await openCashIn(page);
    await partner(page, /Cebuana/).click();
    await page.getByTestId('otc-amount').fill('99');
    await page.getByTestId('otc-generate').click();
    await expect(page.locator('#otc-form .form-error')).toHaveText('Cash in from ₱100 to ₱50,000 per code');

    await page.locator('#otc-chips').getByText('₱1,000').click();
    await expect(page.getByTestId('otc-summary')).toContainText('Pay at the counter₱1,010.00'); // 1%
    await page.getByTestId('otc-generate').click();
    const ref = await page.getByTestId('otc-ref').textContent();
    await page.getByTestId('otc-done').click();

    await openCashIn(page);
    const pendingCode = page.getByTestId('otc-pending-code');
    await expect(pendingCode).toHaveText('Cebuana Lhuillier · ₱1,010.00');
    await pendingCode.click();
    await expect(page.getByTestId('otc-ref')).toHaveText(ref!);
  });

  test('keyboard: arrows move between cards, Enter picks; Back returns to the grid', async ({ page, request }) => {
    await login(page, await createUser(request, 'Alice Tan'));
    await openCashIn(page);
    await page.keyboard.press('Tab'); // from the pills into the grid
    await expect(partner(page, /Cebuana/)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(partner(page, /M Lhuillier/)).toBeFocused();
    await expect(page.locator('#otc-pick')).toBeVisible(); // arrows don't leave the grid
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('otc-partner')).toContainText('M Lhuillier');
    await page.locator('#otc-back').click();
    await expect(partner(page, /M Lhuillier/)).toBeFocused();
  });

  test('QA sandbox (admin): "Simulate counter payment" pays the code', async ({ page, request }) => {
    await login(page, await createAdmin(request));
    await openCashIn(page);
    await partner(page, /Bayad Center/).click();
    await page.getByTestId('otc-amount').fill('300');
    await expect(page.getByTestId('otc-summary')).toContainText('Counter feeFree');
    await page.getByTestId('otc-generate').click();
    await page.getByTestId('otc-simulate').click();
    await expect(page.getByTestId('otc-status')).toHaveText('Paid · ₱300.00 added to your wallet');
    await expect(page.getByTestId('otc-simulate')).toBeDisabled();
  });
});
