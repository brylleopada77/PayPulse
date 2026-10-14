import { test, expect } from '@playwright/test';
import { authHeader, createFundedUser, createUser, getBalanceCents, transfer } from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';

test.describe('Money transfer - happy path', () => {
  test('moves money from sender to receiver', async ({ request }) => {
    const alice = await createFundedUser(request, 500, 'Alice');
    const bob = await createUser(request, 'Bob');

    const response = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 125.5,
      description: 'Dinner',
    });

    expect(response.status(), await response.text()).toBe(201);
    expect(await response.json()).toMatchObject({
      from: alice.accountNumber,
      to: bob.accountNumber,
      amount: '125.50',
      amountCents: 12550,
      balanceAfter: '374.50',
    });

    expect(await getBalanceCents(request, alice)).toBe(37450);
    expect(await getBalanceCents(request, bob)).toBe(12550);
  });

  test('writes a balanced pair of ledger entries', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: '40.00' });
    expect(response.status()).toBe(201);
    const { transactionId } = await response.json();

    const aliceHistory = await (
      await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })
    ).json();
    const bobHistory = await (
      await request.get('/api/accounts/me/transactions', { headers: authHeader(bob.token) })
    ).json();

    expect(aliceHistory.transactions[0]).toMatchObject({ transactionId, direction: 'DEBIT', amountCents: 4000 });
    expect(bobHistory.transactions[0]).toMatchObject({ transactionId, direction: 'CREDIT', amountCents: 4000 });

    const report = await checkLedgerIntegrity([alice.accountNumber, bob.accountNumber]);
    expect(report.mismatchedAccounts).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  test('allows spending the exact full balance', async ({ request }) => {
    const alice = await createFundedUser(request, 75.25);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 75.25 });

    expect(response.status()).toBe(201);
    expect(await getBalanceCents(request, alice)).toBe(0);
    expect(await getBalanceCents(request, bob)).toBe(7525);
  });

  test('sequential transfers add up correctly', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    for (let i = 0; i < 5; i++) {
      const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
      expect(response.status()).toBe(201);
    }

    expect(await getBalanceCents(request, alice)).toBe(5000);
    expect(await getBalanceCents(request, bob)).toBe(5000);
  });
});

test.describe('Money transfer - insufficient balance', () => {
  test('rejects a transfer larger than the balance', async ({ request }) => {
    const alice = await createFundedUser(request, 50);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 50.01 });

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalanceCents(request, alice)).toBe(5000);
    expect(await getBalanceCents(request, bob)).toBe(0);
  });

  test('rejects any transfer from an empty wallet', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 0.01 });

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('INSUFFICIENT_FUNDS');
  });
});

test.describe('Money transfer - invalid accounts and input', () => {
  test('rejects an unknown receiver account', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const response = await transfer(request, alice, { toAccountNumber: 'PP0000000000', amount: 10 });

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('RECEIVER_NOT_FOUND');
    expect(await getBalanceCents(request, alice)).toBe(10000);
  });

  test('does not allow sending to the system funding account', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const response = await transfer(request, alice, { toAccountNumber: 'SYS-EXTERNAL-FUNDING', amount: 10 });

    expect(response.status()).toBe(404);
    expect(await getBalanceCents(request, alice)).toBe(10000);
  });

  test('rejects a transfer to yourself', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const response = await transfer(request, alice, { toAccountNumber: alice.accountNumber, amount: 10 });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('SAME_ACCOUNT');
  });

  test('rejects a missing receiver account number', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const response = await transfer(request, alice, { toAccountNumber: '', amount: 10 });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_ACCOUNT_NUMBER');
  });

  for (const amount of [0, -10, 10.555, 'abc', null, '1e3']) {
    test(`rejects invalid amount: ${JSON.stringify(amount)}`, async ({ request }) => {
      const alice = await createFundedUser(request, 100);
      const bob = await createUser(request);

      const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount });

      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_AMOUNT');
      expect(await getBalanceCents(request, alice)).toBe(10000);
    });
  }

  test('requires authentication', async ({ request }) => {
    const response = await request.post('/api/transfers', {
      data: { toAccountNumber: 'PP1000000001', amount: 10 },
    });
    expect(response.status()).toBe(401);
  });
});
