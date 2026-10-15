/**
 * Resilience (chaos) tests of the web wallet in a real browser.
 *
 * The chaos middleware (src/middleware/chaos.js, QA_SANDBOX=true, ADMIN accounts only) is driven with x-chaos-*
 * request headers that the test adds to the page's requests. Every test checks the user-facing
 * behaviour (retry toasts, error messages, receipts) AND that no money was lost or duplicated.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createFundedAdmin, createUser, getBalanceCents, authHeader, type TestUser } from './helpers/api';
import { checkLedgerIntegrity } from './helpers/db';

async function login(page: Page, user: TestUser) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('balance')).not.toHaveText('—');
}

/** Start an Express Send in the UI up to (not including) the MPIN Confirm click. */
async function startSend(page: Page, to: TestUser, amount: string, mpin: string) {
  await page.getByTestId('open-send').click();
  await page.getByTestId('method-express').click();
  await page.getByTestId('send-to').fill(to.accountNumber);
  await page.getByTestId('send-amount').fill(amount);
  await page.getByTestId('send-submit').click();
  await page.getByTestId('review-confirm').click();
  await page.getByTestId('mpin-input-digit').first().click();
  await page.keyboard.type(mpin);
}

/** Turn chaos on for the page's API calls (GETs stay healthy: rate 0 unless the test says otherwise). */
async function chaos(page: Page, headers: Record<string, string>) {
  await page.setExtraHTTPHeaders({ 'x-chaos-mode': 'true', 'x-chaos-rate': '0', ...headers });
}

async function historyCount(request: APIRequestContext, user: TestUser) {
  const body = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(user.token) })).json();
  return body.transactions.length;
}

test.describe('Resilience: the wallet UI under chaos', () => {
  test('503 drops: the UI retries with toasts and the transfer completes exactly once', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500, 'Alice Tan');
    const bob = await createUser(request, 'Bob Cruz');
    await login(page, alice);
    await startSend(page, bob, '120', alice.mpin);

    // The first 2 attempts of this transfer (same Idempotency-Key) are dropped before they run.
    await chaos(page, { 'x-chaos-fault': 'drop', 'x-chaos-drop-attempts': '2' });
    await page.getByTestId('mpin-submit').click();

    await expect(page.getByTestId('toast')).toContainText('Retrying (1/3)');
    await expect(page.getByTestId('toast')).toContainText('Retrying (2/3)');
    await expect(page.getByTestId('receipt-dialog')).toBeVisible();
    await expect(page.getByTestId('receipt-title')).toHaveText('Transfer Successful');
    await page.getByTestId('receipt-done').click();
    await expect(page.getByTestId('balance')).toHaveText('₱380.00');

    // Zero balance corruption: exactly one ₱120 transfer, ledger consistent.
    expect(await getBalanceCents(request, alice)).toBe(38000);
    expect(await getBalanceCents(request, bob)).toBe(12000);
    const report = await checkLedgerIntegrity([alice.accountNumber, bob.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.negativeAccounts).toEqual([]);
  });

  test('answer lost AFTER the transfer ran: the retry replays it instead of sending twice', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500);
    const bob = await createUser(request);
    await login(page, alice);
    await startSend(page, bob, '75', alice.mpin);

    await chaos(page, { 'x-chaos-fault': 'drop', 'x-chaos-drop-when': 'after', 'x-chaos-drop-attempts': '1' });
    await page.getByTestId('mpin-submit').click();

    await expect(page.getByTestId('toast')).toContainText('Retrying (1/3)');
    await expect(page.getByTestId('receipt-dialog')).toBeVisible();
    await page.getByTestId('receipt-done').click();

    expect(await getBalanceCents(request, alice)).toBe(42500);
    expect(await getBalanceCents(request, bob)).toBe(7500); // once, not twice
    expect(await historyCount(request, bob)).toBe(1);
  });

  test('every retry fails: a clear error, nothing confirmed, and no money moved', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500);
    const bob = await createUser(request);
    await login(page, alice);
    const historyBefore = await historyCount(request, alice);
    await startSend(page, bob, '50', alice.mpin);

    await chaos(page, { 'x-chaos-fault': 'drop', 'x-chaos-drop-attempts': '10' });
    await page.getByTestId('mpin-submit').click();

    await expect(page.getByTestId('toast')).toContainText('Retrying (3/3)');
    await expect(page.locator('#mpin-form .form-error')).toContainText("isn't confirmed", { timeout: 15_000 });
    await expect(page.getByTestId('receipt-dialog')).toBeHidden();

    await page.setExtraHTTPHeaders({}); // network healthy again
    await page.locator('#mpin-dialog [data-close]').click();
    await page.getByTestId('refresh').click();
    await expect(page.getByTestId('balance')).toHaveText('₱500.00');
    expect(await getBalanceCents(request, alice)).toBe(50000);
    expect(await getBalanceCents(request, bob)).toBe(0);
    expect(await historyCount(request, alice)).toBe(historyBefore);
  });

  test('2-second database lock: the UI shows it is waiting, then completes', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500);
    const bob = await createUser(request);
    await login(page, alice);
    await startSend(page, bob, '10', alice.mpin);

    await chaos(page, { 'x-chaos-fault': 'db-lock' });
    const started = Date.now();
    await page.getByTestId('mpin-submit').click();
    await expect(page.getByTestId('net-indicator')).toBeVisible();
    await expect(page.getByTestId('receipt-dialog')).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);

    expect(await getBalanceCents(request, alice)).toBe(49000);
    expect(await getBalanceCents(request, bob)).toBe(1000);
  });

  test('savings moves are retried safely too', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500);
    await login(page, alice);
    await page.getByTestId('savings-add').click();
    await page.getByTestId('savings-amount').fill('200');

    await chaos(page, { 'x-chaos-fault': 'drop', 'x-chaos-drop-when': 'after', 'x-chaos-drop-attempts': '2' });
    await page.getByTestId('savings-submit').click();

    await expect(page.getByTestId('toast')).toContainText('Retrying (2/3)');
    await expect(page.getByTestId('savings-dialog')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId('savings-balance')).toHaveText('₱200.00');
    expect(await getBalanceCents(request, alice)).toBe(30000);
  });
});
