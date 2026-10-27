import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { authHeader, bankTransfer, createFundedUser, createUser, getBalanceCents, transfer, type TestUser } from '../helpers/api';
import { ageOutgoingTransactions, checkLedgerIntegrity } from '../helpers/db';

// Row-level locking (src/services/walletLock.js): every payment out of a wallet locks the wallet row
// (SELECT ... FOR UPDATE) before it reads the balance, the limits and the AML counters, and posts its
// ledger entries in the same transaction. Simultaneous requests from one wallet therefore run one
// after the other: they can never spend more than the balance, nor slip past the anti-spam rule.
// (This was the intentional race-condition bug, now fixed: QA_NOTES.md.)

const PARALLEL_REQUESTS = 10;

/** Fire `n` copies of a request at the same moment, like a user hammering the button. */
const burst = (n: number, send: () => Promise<APIResponse>) => Promise.all(Array.from({ length: n }, send));

async function summarize(responses: APIResponse[]) {
  const statuses = responses.map((r) => r.status());
  const codes = await Promise.all(responses.map(async (r) => (r.status() >= 400 ? (await r.json()).error.code : 'OK')));
  console.log(`Statuses: ${statuses.join(', ')}  codes: ${[...new Set(codes)].join(', ')}`);
  return { statuses, codes, succeeded: statuses.filter((s) => s === 201).length };
}

async function expectLedgerConsistent(accountNumbers: string[]) {
  const report = await checkLedgerIntegrity(accountNumbers);
  expect(report.negativeAccounts, 'overdrawn wallets').toEqual([]);
  expect(report.ok, 'ledger integrity').toBe(true);
}

function payBill(request: APIRequestContext, user: TestUser, amount: number) {
  return request.post('/api/v1/bills/pay', {
    data: { billerCode: 'MERALCO', accountNumber: '1234567890', accountName: user.fullName, amount, mpin: user.mpin },
    headers: authHeader(user.token),
  });
}

function buyLoad(request: APIRequestContext, user: TestUser, amount: number) {
  return request.post('/api/v1/load/purchase', {
    data: { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount, mpin: user.mpin },
    headers: authHeader(user.token),
  });
}

test.describe('Concurrency: row-level locking on the payer wallet', () => {
  test('10 identical ₱60 transfers from ₱100: exactly 1 succeeds, 9 fail with INSUFFICIENT_FUNDS', async ({ request }) => {
    const sender = await createFundedUser(request, 100, 'Double Clicker');
    const receiver = await createUser(request, 'Lucky Receiver');

    const { statuses, codes, succeeded } = await summarize(
      await burst(PARALLEL_REQUESTS, () => transfer(request, sender, { toAccountNumber: receiver.accountNumber, amount: 60 })),
    );

    expect(succeeded, 'exactly one transfer fits the balance').toBe(1);
    expect(statuses.filter((s) => s === 422)).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(codes.filter((c) => c === 'INSUFFICIENT_FUNDS')).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(await getBalanceCents(request, sender)).toBe(4_000);
    expect(await getBalanceCents(request, receiver)).toBe(6_000);
    await expectLedgerConsistent([sender.accountNumber, receiver.accountNumber]);
  });

  test('10 simultaneous ₱30 transfers from ₱100 never overdraw the wallet', async ({ request }) => {
    const sender = await createFundedUser(request, 100, 'Double Clicker');
    const receiver = await createUser(request, 'Lucky Receiver');

    const { statuses, succeeded } = await summarize(
      await burst(PARALLEL_REQUESTS, () => transfer(request, sender, { toAccountNumber: receiver.accountNumber, amount: 30 })),
    );

    // 3 fit the balance (and the anti-spam rule); the rest: 422 insufficient funds or 429 anti-spam
    expect(succeeded).toBe(3);
    expect(statuses.every((s) => [201, 422, 429].includes(s)), statuses.join(',')).toBe(true);
    expect(await getBalanceCents(request, sender)).toBe(1_000);
    expect(await getBalanceCents(request, sender) + (await getBalanceCents(request, receiver)), 'money conserved').toBe(10_000);
    await expectLedgerConsistent([sender.accountNumber, receiver.accountNumber]);
  });

  test('a burst cannot slip past the anti-spam rule (3 transfers per 10 seconds)', async ({ request }) => {
    const sender = await createFundedUser(request, 1_000, 'Spammer');
    const receiver = await createUser(request, 'Receiver');

    const { codes, succeeded } = await summarize(
      await burst(PARALLEL_REQUESTS, () => transfer(request, sender, { toAccountNumber: receiver.accountNumber, amount: 10 })),
    );

    expect(succeeded, 'at most 3 transfers in 10 seconds, even when they arrive together').toBe(3);
    expect(codes.filter((c) => c === 'TOO_MANY_TRANSFERS')).toHaveLength(PARALLEL_REQUESTS - 3);
    expect(await getBalanceCents(request, sender)).toBe(97_000);
  });

  test('AML velocity is re-checked under the lock: a burst opens the alert and holds the account', async ({ request }) => {
    const sender = await createFundedUser(request, 1_000, 'Fast Sender');
    const receiver = await createUser(request, 'Receiver');
    const send = () => transfer(request, sender, { toAccountNumber: receiver.accountNumber, amount: 10 });

    // 4 transfers in the last minute (3, then out of the 10-second anti-spam window, 1 more)
    for (let i = 0; i < 3; i += 1) expect((await send()).status()).toBe(201);
    await ageOutgoingTransactions(sender.accountNumber, '15 seconds');
    expect((await send()).status()).toBe(201);

    // Two at once: both pass the middleware's AML screen (4 so far), but under the wallet lock the
    // second one sees the 5th transfer committed and is held (VELOCITY: more than 5 in a minute).
    const pair = await burst(2, send);
    const { statuses, codes } = await summarize(pair);
    expect([...statuses].sort(), 'only one of the pair fits the velocity rule').toEqual([201, 403]);
    expect(codes).toContain('TRANSACTION_HELD_FOR_REVIEW');

    // The alert of a payment held inside the (rolled back) transaction is still opened afterwards,
    // and the held answer points to it.
    const heldBody = await pair.find((r) => r.status() === 403)!.json();
    const compliance = await (await request.get('/api/accounts/me/compliance', { headers: authHeader(sender.token) })).json();
    expect(compliance.amlStatus).toBe('UNDER_REVIEW');
    const alert = compliance.alerts.find((a: { alertId: number }) => a.alertId === heldBody.error.details.alertId);
    expect(alert, `alert ${heldBody.error.details.alertId} opened`).toMatchObject({ rule: 'VELOCITY', status: 'OPEN' });
    expect(await getBalanceCents(request, sender)).toBe(95_000);
    await expectLedgerConsistent([sender.accountNumber, receiver.accountNumber]);
  });

  test('Bank Transfer: 10 simultaneous ₱50 + ₱15 fee from ₱100: exactly 1 succeeds', async ({ request }) => {
    const sender = await createFundedUser(request, 100, 'Bank Sender');

    const { codes, succeeded } = await summarize(
      await burst(PARALLEL_REQUESTS, () =>
        bankTransfer(request, sender, { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz', amount: 50 }),
      ),
    );

    expect(succeeded).toBe(1);
    expect(codes.filter((c) => c === 'INSUFFICIENT_FUNDS')).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(await getBalanceCents(request, sender)).toBe(3_500);
    await expectLedgerConsistent([sender.accountNumber]);
  });

  test('Pay Bills: 10 simultaneous ₱70 bills from ₱100: exactly 1 is paid', async ({ request }) => {
    const payer = await createFundedUser(request, 100, 'Bill Payer');

    const { codes, succeeded } = await summarize(await burst(PARALLEL_REQUESTS, () => payBill(request, payer, 70)));

    expect(succeeded).toBe(1);
    expect(codes.filter((c) => c === 'INSUFFICIENT_FUNDS')).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(await getBalanceCents(request, payer)).toBe(3_000); // 100 - 70 (no cashback below a ₱100 bill)
    await expectLedgerConsistent([payer.accountNumber]);
  });

  test('Buy Load: 10 simultaneous ₱100 loads from ₱150: exactly 1 is bought', async ({ request }) => {
    const buyer = await createFundedUser(request, 150, 'Load Buyer');

    const { codes, succeeded } = await summarize(await burst(PARALLEL_REQUESTS, () => buyLoad(request, buyer, 100)));

    expect(succeeded).toBe(1);
    expect(codes.filter((c) => c === 'INSUFFICIENT_FUNDS')).toHaveLength(PARALLEL_REQUESTS - 1);
    expect(await getBalanceCents(request, buyer)).toBe(5_500); // 150 - 100 + 5 cashback
    await expectLedgerConsistent([buyer.accountNumber]);
  });
});
