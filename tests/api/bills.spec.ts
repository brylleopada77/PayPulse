import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  authHeader,
  createAdmin,
  createFundedAdmin,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  wrongMpinFor,
  type TestUser,
} from '../helpers/api';
import { ageOutgoingTransactions, checkLedgerIntegrity } from '../helpers/db';

// Pay Bills: wallet -> Biller Settlement (GL 2040), plus a ₱5.00 cashback (GL 5020 -> wallet) on
// bills of ₱100 or more, at most 3 cashbacks a day. Same guards as a transfer.

const MERALCO = { billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz' };

const bills = {
  catalog: async (request: APIRequestContext, user: TestUser) =>
    (await request.get('/api/v1/bills', { headers: authHeader(user.token) })).json(),
  pay: (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    request.post('/api/v1/bills/pay', { data: { mpin: user.mpin, ...data }, headers: authHeader(user.token) }),
};
const history = async (request: APIRequestContext, user: TestUser) =>
  (await (await request.get('/api/accounts/me/transactions', { headers: authHeader(user.token) })).json()).transactions;
const receipt = async (request: APIRequestContext, user: TestUser, id: number) =>
  (await request.get(`/api/accounts/me/transactions/${id}/receipt`, { headers: authHeader(user.token) })).json();

test.describe('Pay Bills: catalog', () => {
  test('5 categories, 23 billers, free convenience fee and today\'s cashback status', async ({ request }) => {
    const alice = await createUser(request);
    const catalog = await bills.catalog(request, alice);

    expect(catalog.categories.map((c: { code: string }) => c.code)).toEqual(['UTILITIES', 'TELECOMS', 'GOVERNMENT', 'LOANS', 'CABLE']);
    expect(catalog.billers).toHaveLength(23);
    const names = catalog.billers.map((b: { name: string }) => b.name);
    for (const name of ['Meralco', 'Maynilad', 'PLDT Home', 'Converge ICT', 'SSS (PRN)', 'Pag-IBIG Fund', 'BDO Credit Card', 'Cignal TV']) {
      expect(names).toContain(name);
    }
    expect(catalog.billers.find((b: { code: string }) => b.code === 'MERALCO')).toEqual({
      code: 'MERALCO',
      name: 'Meralco',
      logo: '/img/billers/meralco.png',
      category: 'UTILITIES',
      accountLabel: 'Customer Account Number (CAN)',
      accountHint: '10-digit CAN on your bill',
      sensitive: false,
    });
    // every biller has its current logo, served as an image (card / credit billers reuse their bank's)
    for (const b of catalog.billers) {
      expect(b.logo, b.code).toMatch(/^\/img\/(billers|banks)\/[a-z]+\.png$/);
      const img = await request.get(b.logo);
      expect(img.status(), b.logo).toBe(200);
      expect(img.headers()['content-type'], b.logo).toBe('image/png');
    }
    expect(catalog.billers.find((b: { code: string }) => b.code === 'BDO_CC').logo).toBe('/img/banks/bdo.png');
    expect(catalog).toMatchObject({
      convenienceFee: '0.00',
      cashback: { amount: '5.00', minBill: '100.00', dailyMax: 3, usedToday: 0, remainingToday: 3 },
    });
  });
});

test.describe('Pay Bills: payment and ₱5.00 cashback', () => {
  test('deducts the bill, credits ₱5.00 cashback, two history rows, balanced ledger', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const response = await bills.pay(request, alice, { ...MERALCO, amount: 1500 });

    expect(response.status()).toBe(201);
    const paid = await response.json();
    expect(paid).toMatchObject({
      status: 'PAID',
      biller: { code: 'MERALCO', name: 'Meralco', category: 'UTILITIES' },
      accountNumber: '1234567890',
      accountName: 'Juan Dela Cruz',
      amount: '1500.00',
      convenienceFee: '0.00',
      cashback: { earned: true, amount: '5.00', reason: null, remainingToday: 2 },
      balanceAfter: '505.00',
    });
    expect(paid.reference).toMatch(/^REF-BILL-\d{8}-\d{4,}$/);
    expect(await getBalanceCents(request, alice)).toBe(50_500); // 2,000 - 1,500 + 5

    const [cashback, bill] = await history(request, alice);
    expect(bill).toMatchObject({ type: 'BILL_PAYMENT', direction: 'DEBIT', amount: '1500.00', description: 'Bill Payment - Meralco' });
    expect(cashback).toMatchObject({
      type: 'CASHBACK',
      direction: 'CREDIT',
      amount: '5.00',
      description: 'Cashback Reward - Bills Payment',
    });

    expect(await receipt(request, alice, paid.transactionId)).toMatchObject({
      reference: paid.reference,
      title: 'Bills Payment Successful',
      amount: '1500.00',
      fee: '0.00',
      recipient: { name: 'Meralco', account: '1234567890' },
      biller: { name: 'Meralco', accountNumber: '1234567890', accountName: 'Juan Dela Cruz' },
      cashback: '5.00',
    });
    expect(await receipt(request, alice, paid.cashbackTransactionId)).toMatchObject({
      title: 'Cashback Received',
      amount: '5.00',
      direction: 'RECEIVED',
      note: `For Meralco bill ${paid.reference}`,
    });

    const report = await checkLedgerIntegrity([alice.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.negativeAccounts).toEqual([]);
  });

  test('no cashback on bills under ₱100', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const paid = await (await bills.pay(request, alice, { ...MERALCO, amount: 99.99 })).json();

    expect(paid.cashback).toMatchObject({ earned: false, amount: '0.00', reason: 'BELOW_MINIMUM', remainingToday: 3 });
    expect(paid.cashbackTransactionId).toBeNull();
    expect(await getBalanceCents(request, alice)).toBe(40_001);
    expect((await history(request, alice)).map((t: { type: string }) => t.type)).toEqual(['BILL_PAYMENT', 'DEPOSIT']);
  });

  test('at most 3 cashbacks a day: the 4th bill is paid without one', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    for (let i = 0; i < 3; i++) {
      expect((await (await bills.pay(request, alice, { ...MERALCO, amount: 100 })).json()).cashback.earned).toBe(true);
    }
    await ageOutgoingTransactions(alice.accountNumber, '11 seconds'); // past the anti-spam window, still today

    const fourth = await (await bills.pay(request, alice, { ...MERALCO, amount: 100 })).json();
    expect(fourth.cashback).toMatchObject({ earned: false, reason: 'DAILY_LIMIT_REACHED', usedToday: 3, remainingToday: 0 });
    expect(await getBalanceCents(request, alice)).toBe(100_000 - 40_000 + 1_500);
    expect((await bills.catalog(request, alice)).cashback.remainingToday).toBe(0);
  });

  test('credit card billers: only the last 4 digits are kept', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const paid = await (
      await bills.pay(request, alice, { billerCode: 'BDO_CC', accountNumber: '4111 1111 1111 1234', accountName: 'Juan Dela Cruz', amount: 500 })
    ).json();

    expect(paid.accountNumber).toBe('••••1234');
    const r = await receipt(request, alice, paid.transactionId);
    expect(r.biller.accountNumber).toBe('••••1234');
    expect(JSON.stringify(r)).not.toContain('4111111111111234');
  });
});

test.describe('Pay Bills: validation and guards', () => {
  for (const [label, data, code] of [
    ['an unknown biller', { ...MERALCO, billerCode: 'ACME', amount: 100 }, 'UNKNOWN_BILLER'],
    ['a Meralco CAN that is not 10 digits', { ...MERALCO, accountNumber: '12345', amount: 100 }, 'INVALID_BILLER_ACCOUNT'],
    ['a missing account name', { ...MERALCO, accountName: ' ', amount: 100 }, 'INVALID_ACCOUNT_NAME'],
    ['a zero amount', { ...MERALCO, amount: 0 }, 'INVALID_AMOUNT'],
    ['3 decimals', { ...MERALCO, amount: '10.555' }, 'INVALID_AMOUNT'],
  ] as const) {
    test(`rejects ${label} (400 ${code}) and moves no money`, async ({ request }) => {
      const alice = await createFundedUser(request, 1000);
      const response = await bills.pay(request, alice, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect(await getBalanceCents(request, alice)).toBe(100_000);
    });
  }

  test('the field error names the biller\'s account label', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const response = await bills.pay(request, alice, { ...MERALCO, accountNumber: 'ABC', amount: 100 });
    expect(await response.json()).toEqual({
      error: {
        code: 'INVALID_BILLER_ACCOUNT',
        message: 'Enter a valid Customer Account Number (CAN) (10-digit CAN on your bill)',
        details: { field: 'accountNumber', accountLabel: 'Customer Account Number (CAN)', hint: '10-digit CAN on your bill' },
      },
    });
  });

  test('needs the right MPIN', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const wrong = await bills.pay(request, alice, { ...MERALCO, amount: 100, mpin: wrongMpinFor(alice) });
    expect(wrong.status()).toBe(403);
    expect((await wrong.json()).error.code).toBe('INVALID_MPIN');
    const missing = await bills.pay(request, alice, { ...MERALCO, amount: 100, mpin: undefined });
    expect(missing.status()).toBe(400);
    expect(await getBalanceCents(request, alice)).toBe(100_000);
  });

  test('insufficient balance: 422 and nothing is recorded', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const response = await bills.pay(request, alice, { ...MERALCO, amount: 100.01 });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalanceCents(request, alice)).toBe(10_000);
    expect(await history(request, alice)).toHaveLength(1);
  });

  test('bill payments count toward the ₱50,000 daily send limit', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);
    expect((await bills.pay(request, alice, { ...MERALCO, amount: 30_000 })).status()).toBe(201);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 20_000.01 });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', details: { sentToday: '30000.00' } });
  });

  test('parallel payments never overdraw: the wallet is locked during each payment', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const results = await Promise.all(Array.from({ length: 5 }, () => bills.pay(request, alice, { ...MERALCO, amount: 300 })));
    const paid = results.filter((r) => r.status() === 201).length;

    expect(paid).toBeGreaterThan(0);
    expect(paid).toBeLessThanOrEqual(3);
    for (const r of results.filter((x) => x.status() !== 201)) expect([422, 429]).toContain(r.status());
    expect(await getBalanceCents(request, alice)).toBe(100_000 - paid * 29_500);
  });

  test('frozen account: 423 ACCOUNT_FROZEN (QA sandbox, admin)', async ({ request }) => {
    const admin = await createFundedAdmin(request, 1000);
    await request.put('/api/qa/settings', { data: { frozen: true }, headers: authHeader(admin.token) });
    const response = await bills.pay(request, admin, { ...MERALCO, amount: 100 });
    expect(response.status()).toBe(423);
    expect(await getBalanceCents(request, admin)).toBe(100_000);
  });

  test('Trigger HTTP 500: the payment fails cleanly, no bill and no cashback', async ({ request }) => {
    const admin = await createAdmin(request);
    await request.post('/api/qa/reset', { headers: authHeader(admin.token) });
    await request.put('/api/qa/settings', { data: { failNextTransaction: true }, headers: authHeader(admin.token) });

    const response = await bills.pay(request, admin, { ...MERALCO, amount: 1000 });
    expect(response.status()).toBe(500);
    expect(await getBalanceCents(request, admin)).toBe(10_000_000);
    expect(await history(request, admin)).toEqual([]);
  });
});
