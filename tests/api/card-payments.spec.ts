import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedUser, createUser, getBalanceCents, transfer, type TestUser } from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';

// Online purchases with the virtual Visa: POST /api/v1/cards/:token/payments
// Wallet -> GL 2050 Card Settlement. A locked (FROZEN) card is declined with 403 CARD_FROZEN.

async function newCard(request: APIRequestContext, user: TestUser): Promise<string> {
  const response = await request.post('/api/v1/cards/generate', { data: { mpin: user.mpin }, headers: authHeader(user.token) });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).token;
}
const pay = (request: APIRequestContext, user: TestUser, token: string, data: Record<string, unknown>) =>
  request.post(`/api/v1/cards/${token}/payments`, { data, headers: authHeader(user.token) });
const setStatus = (request: APIRequestContext, user: TestUser, token: string, status: string) =>
  request.patch(`/api/v1/cards/${token}`, { data: { status }, headers: authHeader(user.token) });

test.describe('Virtual card payments', () => {
  test('an active card pays: wallet debited, receipt and history entry, ledger balanced', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const token = await newCard(request, alice);

    const response = await pay(request, alice, token, { amount: 249.5, merchant: 'Lazada' });
    expect(response.status()).toBe(201);
    const paid = await response.json();
    expect(paid).toMatchObject({ status: 'APPROVED', merchant: 'Lazada', amount: '249.50', balanceAfter: '750.50' });
    expect(paid.authCode).toMatch(/^[0-9A-F]{6}$/);
    expect(paid.card.maskedPan).toMatch(/^4847 35•• •••• \d{4}$/);
    expect(await getBalanceCents(request, alice)).toBe(75_050);

    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    expect(history.transactions[0]).toMatchObject({ type: 'CARD_PAYMENT', direction: 'DEBIT', amount: '249.50', description: 'Card payment - Lazada' });
    const receipt = await (
      await request.get(`/api/accounts/me/transactions/${paid.transactionId}/receipt`, { headers: authHeader(alice.token) })
    ).json();
    expect(receipt).toMatchObject({ title: 'Card Payment Approved', recipient: { name: 'Lazada' }, note: `Authorization code ${paid.authCode}` });

    const report = await checkLedgerIntegrity([alice.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  test('a locked card is declined with 403 CARD_FROZEN and no money moves; unlocking works again', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const token = await newCard(request, alice);
    expect((await setStatus(request, alice, token, 'FROZEN')).status()).toBe(200);

    const declined = await pay(request, alice, token, { amount: 100, merchant: 'Shopee' });
    expect(declined.status()).toBe(403);
    expect(await declined.json()).toEqual({
      error: {
        code: 'CARD_FROZEN',
        message: 'Payment declined: this card is locked. Unlock it in the Card tab to pay.',
        details: { declined: true },
      },
    });
    expect(await getBalanceCents(request, alice)).toBe(100_000);

    await setStatus(request, alice, token, 'ACTIVE');
    expect((await pay(request, alice, token, { amount: 100, merchant: 'Shopee' })).status()).toBe(201);
    expect(await getBalanceCents(request, alice)).toBe(90_000);
  });

  test('insufficient balance: 422 and nothing recorded', async ({ request }) => {
    const alice = await createFundedUser(request, 50);
    const token = await newCard(request, alice);
    const response = await pay(request, alice, token, { amount: 50.01 });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalanceCents(request, alice)).toBe(5_000);
  });

  test("you can't pay with someone else's card", async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const mallory = await createFundedUser(request, 500);
    const token = await newCard(request, alice);
    const response = await pay(request, mallory, token, { amount: 10 });
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('CARD_NOT_FOUND');
    expect(await getBalanceCents(request, alice)).toBe(50_000);
  });

  for (const [label, data, code] of [
    ['a zero amount', { amount: 0 }, 'INVALID_AMOUNT'],
    ['3 decimals', { amount: '1.005' }, 'INVALID_AMOUNT'],
    ['a one-letter merchant', { amount: 10, merchant: 'X' }, 'INVALID_MERCHANT'],
  ] as const) {
    test(`rejects ${label} (400 ${code})`, async ({ request }) => {
      const alice = await createFundedUser(request, 100);
      const token = await newCard(request, alice);
      const response = await pay(request, alice, token, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    });
  }

  test('card payments count toward the daily send limit', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);
    const token = await newCard(request, alice);
    expect((await pay(request, alice, token, { amount: 45_000, merchant: 'Steam' })).status()).toBe(201);
    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 5_000.01 });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', details: { sentToday: '45000.00' } });
  });

  test('parallel purchases never overdraw (card and wallet are locked)', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const token = await newCard(request, alice);
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(request, alice, token, { amount: 300 })));
    const approved = results.filter((r) => r.status() === 201).length;
    expect(approved).toBeGreaterThan(0);
    expect(approved).toBeLessThanOrEqual(3);
    for (const r of results.filter((x) => x.status() !== 201)) expect([422, 429]).toContain(r.status());
    expect(await getBalanceCents(request, alice)).toBe(100_000 - approved * 30_000);
  });
});
