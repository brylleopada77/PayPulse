import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  authHeader,
  createAdmin,
  createFundedUser,
  createUser,
  getBalanceCents,
  wrongMpinFor,
  type TestUser,
} from '../helpers/api';
import { checkLedgerIntegrity, tryStatement } from '../helpers/db';

// Instant Loan: ₱50,000 pre-approved credit line, ₱1,000-₱50,000 over 3/6/12 months at 1.50% a
// month flat. Disbursement credits the wallet at once (LOAN_DISBURSEMENT); repayments pay interest
// first, then principal (LOAN_REPAYMENT). One open loan per customer.

const loans = {
  overview: async (request: APIRequestContext, user: TestUser) =>
    (await request.get('/api/v1/loans', { headers: authHeader(user.token) })).json(),
  quote: (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    request.post('/api/v1/loans/quote', { data, headers: authHeader(user.token) }),
  apply: (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    request.post('/api/v1/loans', { data: { mpin: user.mpin, ...data }, headers: authHeader(user.token) }),
  repay: (request: APIRequestContext, user: TestUser, loanId: number, amount: unknown) =>
    request.post(`/api/v1/loans/${loanId}/repay`, { data: { amount }, headers: authHeader(user.token) }),
};
const qa = (request: APIRequestContext, user: TestUser, settings: Record<string, boolean>) =>
  request.put('/api/qa/settings', { data: settings, headers: authHeader(user.token) });

test.describe('Instant Loan: offer and quote', () => {
  test('every customer has a ₱50,000 pre-approved credit line', async ({ request }) => {
    const alice = await createUser(request);
    expect(await loans.overview(request, alice)).toEqual({
      creditLimit: '50000.00',
      available: '50000.00',
      minAmount: '1000.00',
      maxAmount: '50000.00',
      monthlyRate: '1.50',
      terms: [3, 6, 12],
      activeLoan: null,
    });
  });

  test('quote: ₱10,000 over 6 months = ₱900 interest, ₱1,816.67 a month, nothing booked', async ({ request }) => {
    const alice = await createUser(request);
    const response = await loans.quote(request, alice, { amount: 10000, termMonths: 6 });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      principal: '10000.00',
      termMonths: 6,
      monthlyRate: '1.50',
      interest: '900.00',
      totalRepayable: '10900.00',
      monthlyInstallment: '1816.67',
    });
    expect(await getBalanceCents(request, alice)).toBe(0);
  });
});

test.describe('Instant Loan: Apply & Disburse', () => {
  test('credits the wallet immediately and logs a "Loan Disbursement" transaction', async ({ request }) => {
    const alice = await createUser(request);
    const response = await loans.apply(request, alice, { amount: 10000, termMonths: 6 });

    expect(response.status()).toBe(201);
    const loan = await response.json();
    expect(loan).toMatchObject({
      status: 'ACTIVE',
      principal: '10000.00',
      termMonths: 6,
      totalRepayable: '10900.00',
      outstanding: '10900.00',
      balanceAfter: '10000.00',
      nextDue: { amount: '1816.67' },
    });
    expect(loan.reference).toMatch(/^REF-\d{8}-\d{4,}$/);
    // 5 x ₱1,816.67 + a last installment that absorbs the rounding.
    expect(loan.schedule.map((s: { amount: string }) => s.amount)).toEqual([
      '1816.67', '1816.67', '1816.67', '1816.67', '1816.67', '1816.65',
    ]);
    expect(await getBalanceCents(request, alice)).toBe(1_000_000);

    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    expect(history.transactions[0]).toMatchObject({
      type: 'LOAN_DISBURSEMENT',
      direction: 'CREDIT',
      amount: '10000.00',
      description: 'Loan Disbursement',
    });
    const receipt = await (
      await request.get(`/api/accounts/me/transactions/${loan.transactionId}/receipt`, { headers: authHeader(alice.token) })
    ).json();
    expect(receipt).toMatchObject({ title: 'Loan Disbursed', amount: '10000.00', sender: { name: 'PayPulse Instant Loan' } });

    expect(await loans.overview(request, alice)).toMatchObject({ available: '0.00', activeLoan: { loanId: loan.loanId } });
    const report = await checkLedgerIntegrity([alice.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.negativeAccounts).toEqual([]);
  });

  for (const [label, data, code] of [
    ['below ₱1,000', { amount: 999.99, termMonths: 6 }, 'LOAN_AMOUNT_OUT_OF_RANGE'],
    ['above ₱50,000', { amount: 50000.01, termMonths: 6 }, 'LOAN_AMOUNT_OUT_OF_RANGE'],
    ['a 9-month term', { amount: 5000, termMonths: 9 }, 'INVALID_LOAN_TERM'],
    ['a negative amount', { amount: -5000, termMonths: 3 }, 'INVALID_AMOUNT'],
  ] as const) {
    test(`rejects ${label} (400 ${code}) and credits nothing`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await loans.apply(request, alice, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect(await getBalanceCents(request, alice)).toBe(0);
    });
  }

  test('needs the right MPIN', async ({ request }) => {
    const alice = await createUser(request);
    const missing = await loans.apply(request, alice, { amount: 5000, termMonths: 3, mpin: undefined });
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error.code).toBe('MPIN_REQUIRED');

    const wrong = await loans.apply(request, alice, { amount: 5000, termMonths: 3, mpin: wrongMpinFor(alice) });
    expect(wrong.status()).toBe(403);
    expect((await wrong.json()).error.code).toBe('INVALID_MPIN');
    expect(await getBalanceCents(request, alice)).toBe(0);
  });

  test('one loan at a time: a second application gets 409 LOAN_ALREADY_ACTIVE', async ({ request }) => {
    const alice = await createUser(request);
    expect((await loans.apply(request, alice, { amount: 5000, termMonths: 3 })).status()).toBe(201);

    const second = await loans.apply(request, alice, { amount: 1000, termMonths: 3 });
    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('LOAN_ALREADY_ACTIVE');
    expect(await getBalanceCents(request, alice)).toBe(500_000);
  });

  test('parallel applications: exactly one is disbursed (per-user lock + unique index)', async ({ request }) => {
    const alice = await createUser(request);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => loans.apply(request, alice, { amount: 50000, termMonths: 12 })),
    );
    const statuses = results.map((r) => r.status()).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await getBalanceCents(request, alice)).toBe(5_000_000);
  });

  test('a customer under compliance review cannot borrow (403)', async ({ request }) => {
    const alice = await createUser(request);
    expect(await tryStatement(`UPDATE users SET aml_status = 'UNDER_REVIEW' WHERE email = $1`, [alice.email])).toBeNull();
    const response = await loans.apply(request, alice, { amount: 5000, termMonths: 3 });
    expect(response.status()).toBe(403);
    expect((await response.json()).error).toMatchObject({
      code: 'TRANSACTION_HELD_FOR_REVIEW',
      details: { rule: 'ACCOUNT_UNDER_REVIEW' },
    });
    expect(await getBalanceCents(request, alice)).toBe(0);
  });
});

test.describe('Instant Loan: repayment', () => {
  test('interest is paid first, then principal; paying it all closes the loan', async ({ request }) => {
    const alice = await createFundedUser(request, 1000); // to cover the ₱900 interest
    const loan = await (await loans.apply(request, alice, { amount: 10000, termMonths: 6 })).json();

    const first = await loans.repay(request, alice, loan.loanId, '1816.67');
    expect(first.status()).toBe(201);
    expect(await first.json()).toMatchObject({
      status: 'ACTIVE',
      payment: { amount: '1816.67', interest: '900.00', principal: '916.67' },
      outstanding: '9083.33',
      interestOutstanding: '0.00',
      principalOutstanding: '9083.33',
      nextDue: { amount: '1816.67' },
      schedule: [{ number: 1, status: 'PAID' }, { number: 2, status: 'DUE' }, {}, {}, {}, {}],
    });

    const full = await loans.repay(request, alice, loan.loanId, '9083.33');
    expect(full.status()).toBe(201);
    expect(await full.json()).toMatchObject({ status: 'PAID', outstanding: '0.00', nextDue: null, balanceAfter: '100.00' });
    expect(await getBalanceCents(request, alice)).toBe(10_000); // ₱11,000 in, ₱10,900 repaid

    expect(await loans.overview(request, alice)).toMatchObject({ available: '50000.00', activeLoan: null });
    expect((await loans.apply(request, alice, { amount: 1000, termMonths: 3 })).status()).toBe(201);
    const report = await checkLedgerIntegrity([alice.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  test('cannot pay more than is owed, or more than the wallet holds', async ({ request }) => {
    const alice = await createUser(request);
    const loan = await (await loans.apply(request, alice, { amount: 10000, termMonths: 3 })).json();

    const tooMuch = await loans.repay(request, alice, loan.loanId, '10450.01'); // owes ₱10,450.00
    expect(tooMuch.status()).toBe(400);
    expect(await tooMuch.json()).toMatchObject({
      error: { code: 'AMOUNT_EXCEEDS_BALANCE_DUE', details: { outstanding: '10450.00' } },
    });

    await request.post('/api/v1/savings/deposit', { data: { amount: 9500 }, headers: authHeader(alice.token) });
    const broke = await loans.repay(request, alice, loan.loanId, '3483.34');
    expect(broke.status()).toBe(422);
    expect((await broke.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await getBalanceCents(request, alice)).toBe(50_000);
  });

  test("you can't see or repay someone else's loan", async ({ request }) => {
    const alice = await createUser(request);
    const mallory = await createFundedUser(request, 5000);
    const loan = await (await loans.apply(request, alice, { amount: 5000, termMonths: 3 })).json();

    const response = await loans.repay(request, mallory, loan.loanId, '100');
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('LOAN_NOT_FOUND');
    expect(await getBalanceCents(request, mallory)).toBe(500_000);
  });
});

test.describe('Instant Loan with the QA sandbox (admin)', () => {
  test('frozen account: 423 and no loan', async ({ request }) => {
    const admin = await createAdmin(request);
    await qa(request, admin, { frozen: true });
    const response = await loans.apply(request, admin, { amount: 5000, termMonths: 3 });
    expect(response.status()).toBe(423);
    expect((await response.json()).error.code).toBe('ACCOUNT_FROZEN');
    expect((await loans.overview(request, admin)).activeLoan).toBeNull();
  });

  test('Trigger HTTP 500: the application fails cleanly and nothing is disbursed', async ({ request }) => {
    const admin = await createAdmin(request);
    await qa(request, admin, { failNextTransaction: true });
    const response = await loans.apply(request, admin, { amount: 5000, termMonths: 3 });
    expect(response.status()).toBe(500);
    expect((await response.json()).error).toMatchObject({ code: 'INTERNAL_ERROR', details: { simulated: true } });
    expect(await getBalanceCents(request, admin)).toBe(0);
    expect((await loans.overview(request, admin)).activeLoan).toBeNull();
  });

  test('Reset DB State: ₱100,000 wallet, open loan written off, ledger still balanced', async ({ request }) => {
    const admin = await createAdmin(request);
    await loans.apply(request, admin, { amount: 20000, termMonths: 12 });

    const reset = await request.post('/api/qa/reset', { headers: authHeader(admin.token) });
    expect(reset.status()).toBe(200);
    expect(await getBalanceCents(request, admin)).toBe(10_000_000);
    expect(await loans.overview(request, admin)).toMatchObject({ available: '50000.00', activeLoan: null });
    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(admin.token) })).json();
    expect(history.transactions).toEqual([]);

    const report = await checkLedgerIntegrity([admin.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
  });
});
