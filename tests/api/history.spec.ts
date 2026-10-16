import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedUser, createUser, fundAccount, transfer, type TestUser } from '../helpers/api';
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
