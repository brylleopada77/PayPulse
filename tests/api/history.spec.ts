import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedAdmin, createFundedUser, createUser, fundAccount, getBalanceCents, transfer, type TestUser } from '../helpers/api';
import { ageOutgoingTransactions } from '../helpers/db';

// GET /api/accounts/me/transactions paging: limit, before (cursor), direction (IN / OUT).

type Tx = { transactionId: number; direction: string };
const page = async (request: APIRequestContext, user: TestUser, query = '') =>
  request.get(`/api/accounts/me/transactions${query}`, { headers: authHeader(user.token) });

/** 1 top-up of ₱1,000 + 6 top-ups of ₱1 + 3 sends of ₱1 = 10 transactions: 7 in, 3 out. */
async function userWithHistory(request: APIRequestContext) {
  const alice = await createFundedUser(request, 1000);
  const bob = await createUser(request);
  for (let i = 0; i < 6; i++) await fundAccount(request, alice.accountNumber, 1);
  for (let i = 0; i < 3; i++) await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 });
  await ageOutgoingTransactions(alice.accountNumber, '11 seconds');
  return alice;
}

test.describe('Transaction history paging', () => {
  test('pages through everything with limit + before, newest first, no gaps or repeats', async ({ request }) => {
    const alice = await userWithHistory(request);
    const all = await (await page(request, alice, '?limit=100')).json();
    expect(all.transactions).toHaveLength(10);
    expect(all).toMatchObject({ hasMore: false, nextBefore: null });

    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const body = await (await page(request, alice, `?limit=4${cursor ? `&before=${cursor}` : ''}`)).json();
      seen.push(...body.transactions.map((t: Tx) => t.transactionId));
      cursor = body.nextBefore;
      pages += 1;
      expect(body.hasMore).toBe(cursor !== null);
    } while (cursor);

    expect(pages).toBe(3); // 4 + 4 + 2
    expect(seen).toEqual(all.transactions.map((t: Tx) => t.transactionId));
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  test('direction=IN / OUT filters money in and money out', async ({ request }) => {
    const alice = await userWithHistory(request);
    const moneyIn = await (await page(request, alice, '?direction=IN')).json();
    const moneyOut = await (await page(request, alice, '?direction=out')).json();
    expect(moneyIn.transactions).toHaveLength(7);
    expect(moneyIn.transactions.every((t: Tx) => t.direction === 'CREDIT')).toBe(true);
    expect(moneyOut.transactions).toHaveLength(3);
    expect(moneyOut.transactions.every((t: Tx) => t.direction === 'DEBIT')).toBe(true);
  });

  test('without parameters it still returns the latest transactions (up to 50)', async ({ request }) => {
    const alice = await userWithHistory(request);
    const body = await (await page(request, alice)).json();
    expect(body.transactions).toHaveLength(10);
    expect(body.hasMore).toBe(false);
  });

  for (const [query, code] of [
    ['?limit=0', 'INVALID_LIMIT'],
    ['?limit=101', 'INVALID_LIMIT'],
    ['?limit=abc', 'INVALID_LIMIT'],
    ['?before=-5', 'INVALID_CURSOR'],
    ['?direction=SIDEWAYS', 'INVALID_DIRECTION'],
  ] as const) {
    test(`rejects ${query} (400 ${code})`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await page(request, alice, query);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    });
  }
});

test.describe('Savings interest in the history', () => {
  test('every day of PayPulse Save interest is listed, marked SAVINGS, with a receipt', async ({ request }) => {
    const saver = await createFundedAdmin(request, 20_000); // admin: uses the QA "simulate interest" tool
    await request.post('/api/v1/savings/deposit', { data: { amount: 10_000 }, headers: authHeader(saver.token) });
    const walletBefore = await getBalanceCents(request, saver);
    const accrue = await request.post('/api/qa/savings/accrue', { data: { days: 3 }, headers: authHeader(saver.token) });
    expect(accrue.status(), await accrue.text()).toBe(200);

    const body = await (await page(request, saver)).json();
    const interest = body.transactions.filter((t: Tx & { type: string }) => t.type === 'INTEREST');
    expect(interest).toHaveLength(3);
    for (const row of interest) {
      expect(row).toMatchObject({ direction: 'CREDIT', account: 'SAVINGS' });
      expect(row.description).toMatch(/^Savings interest for \d{4}-\d{2}-\d{2}$/);
      expect(Number(row.amount)).toBeGreaterThan(0);
    }
    // Wallet rows are still marked WALLET, and interest never touches the Available Balance.
    expect(body.transactions.find((t: { type: string }) => t.type === 'SAVINGS_TRANSFER')).toMatchObject({ account: 'WALLET' });
    expect(await getBalanceCents(request, saver)).toBe(walletBefore);
    // "Money in" includes the interest.
    const moneyIn = await (await page(request, saver, '?direction=IN')).json();
    expect(moneyIn.transactions.filter((t: { type: string }) => t.type === 'INTEREST')).toHaveLength(3);

    const receipt = await (
      await request.get(`/api/accounts/me/transactions/${interest[0].transactionId}/receipt`, { headers: authHeader(saver.token) })
    ).json();
    expect(receipt).toMatchObject({ title: 'Savings Interest Earned', amount: interest[0].amount, direction: 'RECEIVED' });
    expect(receipt.note).toMatch(/^Interest for \d{4}-\d{2}-\d{2} at 6\.00% p\.a\., added to PayPulse Save$/);
  });

  test("you can't open someone else's interest receipt", async ({ request }) => {
    const saver = await createFundedAdmin(request, 5_000);
    const other = await createUser(request);
    await request.post('/api/v1/savings/deposit', { data: { amount: 5_000 }, headers: authHeader(saver.token) });
    await request.post('/api/qa/savings/accrue', { data: { days: 1 }, headers: authHeader(saver.token) });
    const [row] = (await (await page(request, saver)).json()).transactions.filter((t: { type: string }) => t.type === 'INTEREST');
    const response = await request.get(`/api/accounts/me/transactions/${row.transactionId}/receipt`, { headers: authHeader(other.token) });
    expect(response.status()).toBe(404);
  });
});
