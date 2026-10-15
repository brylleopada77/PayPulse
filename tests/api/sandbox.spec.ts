import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  authHeader,
  bankTransfer,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  type TestUser,
} from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';

// These endpoints only exist when the server runs with QA_SANDBOX=true (local .env, Docker, CI).

const qa = {
  state: (request: APIRequestContext, user: TestUser) =>
    request.get('/api/qa/state', { headers: authHeader(user.token) }),
  set: (request: APIRequestContext, user: TestUser, settings: Record<string, boolean>) =>
    request.put('/api/qa/settings', { data: settings, headers: authHeader(user.token) }),
  reset: (request: APIRequestContext, user: TestUser) =>
    request.post('/api/qa/reset', { headers: authHeader(user.token) }),
};

test.describe('QA sandbox: switches', () => {
  test('everything is off for a new user', async ({ request }) => {
    const alice = await createUser(request);
    const response = await qa.state(request, alice);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ slowNetwork: false, failNextTransaction: false, frozen: false });
  });

  test('QA endpoints need a login', async ({ request }) => {
    expect((await request.get('/api/qa/state')).status()).toBe(401);
  });

  test('slow network delays every API call by about 3 seconds', async ({ request }) => {
    test.slow();
    const alice = await createUser(request);
    await qa.set(request, alice, { slowNetwork: true });

    const started = Date.now();
    const response = await request.get('/api/accounts/me', { headers: authHeader(alice.token) });
    const slowMs = Date.now() - started;

    expect(response.status()).toBe(200);
    expect(slowMs).toBeGreaterThanOrEqual(2900);

    // The QA controls themselves are never slowed down, so the switch can be turned off quickly.
    const offStarted = Date.now();
    await qa.set(request, alice, { slowNetwork: false });
    expect(Date.now() - offStarted).toBeLessThan(2000);
  });

  test('fail next transaction: one 500 with no money moved, then back to normal', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await qa.set(request, alice, { failNextTransaction: true });

    const failed = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(failed.status()).toBe(500);
    expect(await failed.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        details: { simulated: true, source: 'QA sandbox: fail next transaction' },
      },
    });
    expect(await getBalanceCents(request, alice)).toBe(10000);
    expect((await (await qa.state(request, alice)).json()).failNextTransaction).toBe(false);

    const retry = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(retry.status()).toBe(201);
  });

  test('fail next transaction also applies to top-ups', async ({ request }) => {
    const alice = await createUser(request);
    await qa.set(request, alice, { failNextTransaction: true });

    const topUp = await request.post('/api/payments/mock-checkout', { data: { amount: 50 }, headers: authHeader(alice.token) });

    expect(topUp.status()).toBe(500);
    expect(await getBalanceCents(request, alice)).toBe(0);
  });

  test('a frozen account cannot send (Express or Bank) but can still receive', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const bob = await createFundedUser(request, 100);
    await qa.set(request, alice, { frozen: true });

    const express = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(express.status()).toBe(423);
    expect(await express.json()).toEqual({
      error: { code: 'ACCOUNT_FROZEN', message: 'This account is frozen. Sending money is blocked until it is unfrozen.' },
    });
    const bank = await bankTransfer(request, alice, { bankCode: 'BDO', accountNumber: '0012345678', accountName: 'X Y', amount: 10 });
    expect(bank.status()).toBe(423);

    expect((await transfer(request, bob, { toAccountNumber: alice.accountNumber, amount: 5 })).status()).toBe(201);
    const me = await (await request.get('/api/accounts/me', { headers: authHeader(alice.token) })).json();
    expect(me).toMatchObject({ frozen: true, balanceCents: 50500 });

    await qa.set(request, alice, { frozen: false });
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 })).status()).toBe(201);
  });

  test('switches only affect your own account', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await qa.set(request, alice, { frozen: true, failNextTransaction: true });

    const bobState = await (await qa.state(request, bob)).json();
    expect(bobState).toMatchObject({ frozen: false, failNextTransaction: false });
  });
});

test.describe('QA sandbox: reset account state', () => {
  test('reset sets the balance to ₱1,000, clears history and turns all switches off', async ({ request }) => {
    const alice = await createFundedUser(request, 300);
    const bob = await createUser(request);
    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 25 });
    await qa.set(request, alice, { frozen: true, slowNetwork: false, failNextTransaction: true });

    const reset = await qa.reset(request, alice);

    expect(reset.status()).toBe(200);
    expect(await reset.json()).toMatchObject({ balance: '1000.00', frozen: false, failNextTransaction: false, slowNetwork: false });
    expect(await getBalanceCents(request, alice)).toBe(100000);
    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    expect(history.transactions).toEqual([]);
    // Bob keeps his history: rows are hidden for Alice, never deleted.
    const bobHistory = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(bob.token) })).json();
    expect(bobHistory.transactions).toHaveLength(1);
  });

  test('reset works down as well as up, and keeps the ledger balanced', async ({ request }) => {
    const alice = await createFundedUser(request, 2500);
    expect((await qa.reset(request, alice)).status()).toBe(200);
    expect(await getBalanceCents(request, alice)).toBe(100000);

    const report = await checkLedgerIntegrity([alice.accountNumber, 'SYS-QA-ADJUSTMENT']);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.mismatchedAccounts).toEqual([]);
  });

  test('reset restarts the transfer limits', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    for (let i = 0; i < 3; i++) await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 });
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 })).status()).toBe(429);

    await qa.reset(request, alice);

    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 })).status()).toBe(201);
  });

  test('after a reset, transfers work normally from ₱1,000', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);
    await qa.reset(request, alice);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 400 });

    expect(response.status()).toBe(201);
    expect((await response.json()).balanceAfter).toBe('600.00');
  });
});
