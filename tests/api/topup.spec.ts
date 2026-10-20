import { spawn } from 'node:child_process';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createAdmin, createFundedAdmin, createUser, fundAccount, getBalanceCents, transfer, type TestUser } from '../helpers/api';

// "Add money" goes through the MOCK payment provider (no real charge), so it must not be a free
// money printer: only ADMIN accounts can use it (customers get 403 ADMIN_ONLY), with operator
// limits of ₱1,000,000/day and ₱10,000,000 held (wallet + savings), AML screening, and only on
// servers started with MOCK_PAYMENTS=true.

const topUp = (request: APIRequestContext, user: TestUser, amount: unknown, outcome = 'approve') =>
  request.post('/api/payments/mock-checkout', { data: { amount, outcome }, headers: authHeader(user.token) });

const ADMIN_ONLY = { error: { code: 'ADMIN_ONLY', message: 'This feature is only available to PayPulse admins' } };

test.describe('Add money is admin-only', () => {
  test('a customer cannot add money: 403 ADMIN_ONLY and no balance change', async ({ request }) => {
    const carol = await createUser(request);
    const response = await topUp(request, carol, 1000);

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual(ADMIN_ONLY);
    expect(await getBalanceCents(request, carol)).toBe(0);
  });

  test('a customer cannot read the top-up limits or use the QA sandbox', async ({ request }) => {
    const carol = await createUser(request);
    const limits = await request.get('/api/payments/limits', { headers: authHeader(carol.token) });
    expect(limits.status()).toBe(403);
    expect(await limits.json()).toEqual(ADMIN_ONLY);

    for (const response of [
      await request.get('/api/qa/state', { headers: authHeader(carol.token) }),
      await request.put('/api/qa/settings', { data: { frozen: true }, headers: authHeader(carol.token) }),
      await request.post('/api/qa/reset', { headers: authHeader(carol.token) }),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(ADMIN_ONLY);
    }
    expect(await getBalanceCents(request, carol)).toBe(0); // the reset (to ₱1,000) did not run
  });

  test('chaos headers are ignored for customers but work for admins', async ({ request }) => {
    const chaos = { 'x-chaos-mode': 'true', 'x-chaos-fault': 'drop', 'x-chaos-rate': '1' };
    const carol = await createUser(request);
    const admin = await createAdmin(request);

    const customer = await request.get('/api/accounts/me', { headers: { ...authHeader(carol.token), ...chaos } });
    expect(customer.status()).toBe(200);
    const adminCall = await request.get('/api/accounts/me', { headers: { ...authHeader(admin.token), ...chaos } });
    expect(adminCall.status()).toBe(503);
  });

  test('the account shows its role', async ({ request }) => {
    const carol = await createUser(request);
    const admin = await createAdmin(request);
    const me = (user: TestUser) => request.get('/api/accounts/me', { headers: authHeader(user.token) });
    expect((await (await me(carol)).json()).role).toBe('CUSTOMER');
    expect((await (await me(admin)).json()).role).toBe('ADMIN');
  });
});

test.describe('Add money (mock checkout) limits for admins', () => {
  test('the UI can see whether Add money is enabled', async ({ request }) => {
    const body = await (await request.get('/api/config')).json();
    expect(body.features).toMatchObject({ mockPayments: true });
  });

  test('₱1,000,000 per day: up to the limit works, one centavo more is refused', async ({ request }) => {
    const alice = await createAdmin(request);
    expect((await topUp(request, alice, 600_000)).status()).toBe(201);
    expect((await topUp(request, alice, 400_000)).status()).toBe(201);

    const over = await topUp(request, alice, 0.01);
    expect(over.status()).toBe(400);
    expect(await over.json()).toEqual({
      error: {
        code: 'TOPUP_DAILY_LIMIT_EXCEEDED',
        message: 'Daily top-up limit of ₱1,000,000.00 exceeded.',
        details: { dailyLimit: '1000000.00', addedToday: '1000000.00', remainingToday: '0.00', requested: '0.01' },
      },
    });
    expect(await getBalanceCents(request, alice)).toBe(100_000_000);
  });

  test('declined payments do not use up the daily limit', async ({ request }) => {
    const alice = await createAdmin(request);
    expect((await (await topUp(request, alice, 100_000, 'decline')).json()).credited).toBe(false);
    expect((await topUp(request, alice, 100_000)).status()).toBe(201);
  });

  test('₱10,000,000 maximum held, counting PayPulse Save too', async ({ request }) => {
    // ₱9,960,000 via real (signed) provider payments, at most ₱1,000,000 each
    const alice = await createFundedAdmin(request, 960_000);
    for (let i = 0; i < 9; i++) await fundAccount(request, alice.accountNumber, 1_000_000);
    await request.post('/api/v1/savings/deposit', { data: { amount: 900_000 }, headers: authHeader(alice.token) });

    expect((await topUp(request, alice, 40_000)).status()).toBe(201); // holds exactly ₱10,000,000
    const over = await topUp(request, alice, 0.01);

    expect(over.status()).toBe(400);
    const { error } = await over.json();
    expect(error).toMatchObject({
      code: 'WALLET_LIMIT_EXCEEDED',
      message: 'Wallet limit of ₱10,000,000.00 exceeded.',
      details: { walletLimit: '10000000.00', currentHoldings: '10000000.00', roomLeft: '0.00' },
    });
  });

  test('parallel top-ups cannot get past the limit (per-user lock)', async ({ request }) => {
    const alice = await createAdmin(request);
    const results = await Promise.all(Array.from({ length: 10 }, () => topUp(request, alice, 200_000)));
    const credited = results.filter((r) => r.status() === 201).length;

    expect(credited).toBe(5);
    expect(await getBalanceCents(request, alice)).toBe(100_000_000);
  });

  test('more than 5 top-ups in a minute: held for compliance review, and sends are held too', async ({ request }) => {
    const alice = await createAdmin(request);
    const bob = await createUser(request);
    for (let i = 0; i < 5; i++) expect((await topUp(request, alice, 1)).status()).toBe(201);

    const sixth = await topUp(request, alice, 1);
    expect(sixth.status()).toBe(403);
    expect((await sixth.json()).error).toMatchObject({
      code: 'TRANSACTION_HELD_FOR_REVIEW',
      details: { rule: 'TOPUP_VELOCITY', topUpsInWindow: 6 },
    });
    const compliance = await (await request.get('/api/accounts/me/compliance', { headers: authHeader(alice.token) })).json();
    expect(compliance.amlStatus).toBe('UNDER_REVIEW');
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 })).status()).toBe(403);
  });

  test('the limits endpoint shows what can still be added', async ({ request }) => {
    const alice = await createAdmin(request);
    await topUp(request, alice, 1200);
    expect(await (await request.get('/api/payments/limits', { headers: authHeader(alice.token) })).json()).toEqual({
      dailyLimit: '1000000.00',
      addedToday: '1200.00',
      remainingToday: '998800.00',
      walletLimit: '10000000.00',
      currentHoldings: '1200.00',
      roomLeft: '9998800.00',
    });
  });
});

test.describe('Production mode (MOCK_PAYMENTS off)', () => {
  test('the mock checkout does not exist and the UI hides Add money', async () => {
    test.slow();
    const port = 3990 + Math.floor(Math.random() * 9);
    const server = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(port), MOCK_PAYMENTS: 'false', PESONET_WORKER: 'false', INTEREST_JOB: 'false' },
      stdio: 'ignore',
    });
    try {
      const base = `http://localhost:${port}`;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${base}/health`)).ok) break;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const config = await (await fetch(`${base}/api/config`)).json();
      expect(config.features.mockPayments).toBe(false);

      const checkout = await fetch(`${base}/api/payments/mock-checkout`, { method: 'POST' });
      expect(checkout.status).toBe(404);
      expect((await checkout.json()).error.code).toBe('ROUTE_NOT_FOUND');
    } finally {
      server.kill();
    }
  });
});
