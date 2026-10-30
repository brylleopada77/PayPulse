import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedUser, createUser, getBalanceCents, transfer, wrongMpinFor, type TestUser } from '../helpers/api';
import { ageOutgoingTransactions, checkLedgerIntegrity } from '../helpers/db';

// Buy Load: wallet -> Telco Settlement (GL 2060), plus a ₱5.00 cashback (GL 5020 -> wallet) on loads
// of ₱50 or more, at most 3 load cashbacks a day. Same guards as a transfer.

const buy = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
  request.post('/api/v1/load/purchase', { data: { mpin: user.mpin, ...data }, headers: authHeader(user.token) });
const GO99 = { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'PROMO', promoCode: 'GOPLUS99' };
const history = async (request: APIRequestContext, user: TestUser) =>
  (await (await request.get('/api/accounts/me/transactions', { headers: authHeader(user.token) })).json()).transactions;

test.describe('Buy Load: catalog and network detection', () => {
  test('6 brands, regular amounts, promos per brand, cashback status', async ({ request }) => {
    const alice = await createUser(request);
    const catalog = await (await request.get('/api/v1/load', { headers: authHeader(alice.token) })).json();
    expect(catalog.brands.map((b: { code: string }) => b.code)).toEqual(['GLOBE', 'TM', 'SMART', 'TNT', 'DITO', 'GOMO']);
    expect(catalog.regularAmounts).toEqual([20, 50, 100, 200, 500, 1000]);
    const names = catalog.promos.map((p: { name: string }) => p.name);
    for (const n of ['Go+99', 'GoEXTRA99', 'Go+149', 'Power All 99', 'GIGA VIDEO 99', 'DITO 99', '30GB No Expiry']) expect(names).toContain(n);
    expect(catalog.promos.find((p: { code: string }) => p.code === 'GOMO30GB')).toMatchObject({ brand: 'GOMO', price: 399 });
    expect(catalog.cashback).toMatchObject({ amount: '5.00', minAmount: '50.00', dailyMax: 3, remainingToday: 3 });
  });

  test('every brand has a logo (served) or an initials badge, and at least 3 promos', async ({ request }) => {
    const alice = await createUser(request);
    const catalog = await (await request.get('/api/v1/load', { headers: authHeader(alice.token) })).json();
    for (const brand of catalog.brands) {
      expect(brand.badge.initials, brand.code).toBeTruthy();
      expect(brand.badge.color, brand.code).toMatch(/^#[0-9a-f]{6}$/);
      if (brand.logo) {
        const img = await request.get(brand.logo);
        expect(img.status(), brand.logo).toBe(200);
        expect(img.headers()['content-type'], brand.logo).toMatch(/^image\//);
      }
      expect(catalog.promos.filter((p: { brand: string }) => p.brand === brand.code).length, brand.code).toBeGreaterThanOrEqual(3);
    }
    expect(catalog.brands.filter((b: { logo: string | null }) => b.logo).map((b: { code: string }) => b.code)).toEqual(['GLOBE', 'TNT', 'DITO', 'GOMO']);
    expect(catalog.promos).toHaveLength(21);
    expect(new Set(catalog.promos.map((p: { code: string }) => p.code)).size).toBe(21); // codes are unique
  });

  for (const [mobile, network] of [
    ['09171234567', 'GLOBE'], ['0927 123 4567', 'GLOBE'], ['+639561234567', 'GLOBE'],
    ['09181234567', 'SMART'], ['09201234567', 'SMART'], ['09991234567', 'SMART'],
    ['09911234567', 'DITO'], ['09921234567', 'DITO'], ['09931234567', 'DITO'],
    ['09761234567', 'GOMO'], ['09771234567', 'GOMO'],
  ] as const) {
    test(`detects ${network} for ${mobile}`, async ({ request }) => {
      const alice = await createUser(request);
      const body = await (await request.get(`/api/v1/load/detect?mobile=${encodeURIComponent(mobile)}`, { headers: authHeader(alice.token) })).json();
      expect(body).toMatchObject({ detected: true, network: { code: network } });
    });
  }

  test('unknown prefix: not detected; bad number: 400', async ({ request }) => {
    const alice = await createUser(request);
    expect(await (await request.get('/api/v1/load/detect?mobile=09001234567', { headers: authHeader(alice.token) })).json())
      .toMatchObject({ mobileNumber: '09001234567', detected: false, network: null });
    const bad = await request.get('/api/v1/load/detect?mobile=12345', { headers: authHeader(alice.token) });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('INVALID_MOBILE');
  });
});

test.describe('Buy Load: purchase and ₱5.00 cashback', () => {
  test('Globe Go+99: ₱99 out, ₱5 back (net ₱94), two history rows, receipts, balanced ledger', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const response = await buy(request, alice, GO99);
    expect(response.status()).toBe(201);
    const bought = await response.json();
    expect(bought).toMatchObject({
      status: 'SUCCESSFUL',
      mobileNumber: '09171234567',
      brand: { code: 'GLOBE', name: 'Globe' },
      product: { type: 'PROMO', code: 'GOPLUS99', name: 'Go+99' },
      amount: '99.00',
      cashback: { earned: true, amount: '5.00', reason: null, remainingToday: 2 },
      balanceAfter: '406.00',
    });
    expect(bought.reference).toMatch(/^REF-LOAD-\d{8}-\d{4,}$/);
    expect(await getBalanceCents(request, alice)).toBe(50_000 - 9_400);

    const [cashback, load] = await history(request, alice);
    expect(load).toMatchObject({ type: 'LOAD_PURCHASE', direction: 'DEBIT', amount: '99.00', description: 'Buy Load - Globe (09171234567)' });
    expect(cashback).toMatchObject({ type: 'CASHBACK', direction: 'CREDIT', amount: '5.00', description: 'Cashback Reward - Buy Load' });

    const receipt = await (await request.get(`/api/accounts/me/transactions/${bought.transactionId}/receipt`, { headers: authHeader(alice.token) })).json();
    expect(receipt).toMatchObject({
      reference: bought.reference,
      title: 'Load Purchase Successful',
      load: { brand: 'Globe', mobileNumber: '09171234567', product: 'Go+99' },
      cashback: '5.00',
    });
    const cbReceipt = await (await request.get(`/api/accounts/me/transactions/${bought.cashbackTransactionId}/receipt`, { headers: authHeader(alice.token) })).json();
    expect(cbReceipt).toMatchObject({ title: 'Cashback Received', note: `For Globe load to 09171234567 (${bought.reference})` });
    expect((await checkLedgerIntegrity([alice.accountNumber])).unbalancedTransactions).toEqual([]);
  });

  test('regular load: ₱20 has no cashback (below ₱50), ₱50 has', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const small = await (await buy(request, alice, { mobileNumber: '09181234567', brand: 'TNT', productType: 'REGULAR', amount: 20 })).json();
    expect(small).toMatchObject({ amount: '20.00', brand: { name: 'TNT' }, cashback: { earned: false, reason: 'BELOW_MINIMUM' } });
    const fifty = await (await buy(request, alice, { mobileNumber: '09181234567', brand: 'SMART', productType: 'REGULAR', amount: 50 })).json();
    expect(fifty.cashback.earned).toBe(true);
    expect(await getBalanceCents(request, alice)).toBe(50_000 - 2_000 - 5_000 + 500);
  });

  test('at most 3 load cashbacks a day', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    for (let i = 0; i < 3; i++) expect((await (await buy(request, alice, GO99)).json()).cashback.earned).toBe(true);
    await ageOutgoingTransactions(alice.accountNumber, '11 seconds');
    const fourth = await (await buy(request, alice, GO99)).json();
    expect(fourth.cashback).toMatchObject({ earned: false, reason: 'DAILY_LIMIT_REACHED', remainingToday: 0 });
  });
});

test.describe('Buy Load: validation and guards', () => {
  for (const [label, data, code] of [
    ['a bad mobile number', { ...GO99, mobileNumber: '0917123' }, 'INVALID_MOBILE'],
    ['an unknown brand', { ...GO99, brand: 'SUN' }, 'INVALID_BRAND'],
    ['an unknown promo', { ...GO99, promoCode: 'FREE999' }, 'UNKNOWN_PROMO'],
    ['a promo of another brand', { ...GO99, brand: 'SMART' }, 'PROMO_NOT_FOR_BRAND'],
    ['regular load below ₱10', { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount: 5 }, 'INVALID_LOAD_AMOUNT'],
    ['regular load above ₱1,000', { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount: 1001 }, 'INVALID_LOAD_AMOUNT'],
    ['centavos in regular load', { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount: 49.5 }, 'INVALID_LOAD_AMOUNT'],
    ['an unknown product type', { ...GO99, productType: 'BUNDLE' }, 'INVALID_PRODUCT_TYPE'],
  ] as const) {
    test(`rejects ${label} (400 ${code}) and moves no money`, async ({ request }) => {
      const alice = await createFundedUser(request, 500);
      const response = await buy(request, alice, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect(await getBalanceCents(request, alice)).toBe(50_000);
    });
  }

  test('a sent "amount" cannot undercut a promo price (the catalog price is charged and limited)', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const bought = await (await buy(request, alice, { ...GO99, promoCode: 'GOMO30GB', brand: 'GOMO', amount: 1 })).json();
    expect(bought.amount).toBe('399.00');
  });

  test('needs the right MPIN; insufficient balance is 422', async ({ request }) => {
    const alice = await createFundedUser(request, 50);
    expect((await buy(request, alice, { ...GO99, mpin: wrongMpinFor(alice) })).status()).toBe(403);
    const broke = await buy(request, alice, GO99);
    expect(broke.status()).toBe(422);
    expect((await broke.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalanceCents(request, alice)).toBe(5_000);
  });

  test('load purchases count toward the daily send limit', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);
    expect((await buy(request, alice, { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount: 1000 })).status()).toBe(201);
    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 49_000.01 });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', details: { sentToday: '1000.00' } });
  });
});
