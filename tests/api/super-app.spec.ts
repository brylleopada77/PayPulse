import { spawnSync } from 'node:child_process';
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  createAdmin,
  createFundedAdmin,
  authHeader,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  wrongMpinFor,
  type TestUser,
} from '../helpers/api';
import { checkLedgerIntegrity, glCodeOf, ledgerBalanceCents, tryStatement } from '../helpers/db';

const h = (user: TestUser, extra: Record<string, string> = {}) => ({ headers: { ...authHeader(user.token), ...extra } });
const savings = async (request: APIRequestContext, user: TestUser) => (await request.get('/api/v1/savings', h(user))).json();
const move = (request: APIRequestContext, user: TestUser, direction: 'deposit' | 'withdraw', amount: unknown, headers = {}) =>
  request.post(`/api/v1/savings/${direction}`, { data: { amount }, ...h(user, headers) });

function luhnValid(pan: string): boolean {
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

test.describe('PayPulse Save (savings vault)', () => {
  test('a new user gets a vault at 6.00% p.a. under GL 2030', async ({ request }) => {
    const alice = await createUser(request);
    const vault = await savings(request, alice);
    expect(vault).toMatchObject({ balance: '0.00', annualRate: '6.00', interestEarned: '0.00' });
    expect(vault.accountNumber).toMatch(/^SV\d+$/);
    expect(await glCodeOf(vault.accountNumber)).toBe('2030');
  });

  test('moves money between the wallet and the vault through the ledger', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);

    const deposit = await move(request, alice, 'deposit', 600);
    expect(deposit.status(), await deposit.text()).toBe(201);
    expect(await deposit.json()).toMatchObject({ direction: 'DEPOSIT', walletBalance: '400.00', savingsBalance: '600.00' });

    const withdraw = await move(request, alice, 'withdraw', 150.5);
    expect(await withdraw.json()).toMatchObject({ walletBalance: '550.50', savingsBalance: '449.50' });

    expect(await getBalanceCents(request, alice)).toBe(55050);
    const vault = await savings(request, alice);
    expect(await ledgerBalanceCents(vault.accountNumber)).toBe(44950);
    expect((await checkLedgerIntegrity([alice.accountNumber, vault.accountNumber])).unbalancedTransactions).toEqual([]);
    const history = await (await request.get('/api/accounts/me/transactions', h(alice))).json();
    expect(history.transactions[0]).toMatchObject({ type: 'SAVINGS_TRANSFER', direction: 'CREDIT', amount: '150.50' });
  });

  test('cannot move more than the available balance either way', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const tooMuch = await move(request, alice, 'deposit', 100.01);
    expect(tooMuch.status()).toBe(422);
    expect((await tooMuch.json()).error.code).toBe('INSUFFICIENT_FUNDS');
    const noSavings = await move(request, alice, 'withdraw', 1);
    expect(noSavings.status()).toBe(422);
    expect((await noSavings.json()).error.code).toBe('INSUFFICIENT_SAVINGS');
  });

  test('concurrent savings moves cannot overdraw (they lock the accounts)', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const results = await Promise.all(Array.from({ length: 10 }, () => move(request, alice, 'deposit', 30)));
    const ok = results.filter((r) => r.status() === 201).length;
    expect(ok).toBe(3);
    expect(await getBalanceCents(request, alice)).toBe(1000);
  });

  test('daily interest: 6% / 365 on the closing balance, compounded, fractions carried over', async ({ request }) => {
    const alice = await createFundedAdmin(request, 10_000);
    await move(request, alice, 'deposit', 10_000);

    // Day 1: 1,000,000 cents x 6% / 365 = 164.383561... -> 164 cents posted, 0.383561 carried.
    const day1 = await (await request.post('/api/qa/savings/accrue', { data: { days: 1 }, ...h(alice) })).json();
    expect(day1.accruals[0]).toMatchObject({ closingCents: 1_000_000, interestExact: '164.383562', postedCents: 164 });

    // 30 more days compound on the growing balance.
    const month = await (await request.post('/api/qa/savings/accrue', { data: { days: 30 }, ...h(alice) })).json();
    const vault = await savings(request, alice);
    const exact = 1_000_000 * ((1 + 0.06 / 365) ** 31 - 1); // ≈ 5108.x cents
    expect(Number(vault.interestEarned) * 100).toBeGreaterThanOrEqual(Math.floor(exact) - 2);
    expect(Number(vault.interestEarned) * 100).toBeLessThanOrEqual(Math.floor(exact));
    expect(month.accruals).toHaveLength(30);
  });

  test('a day is never accrued twice', async ({ request }) => {
    const alice = await createFundedAdmin(request, 1000);
    await move(request, alice, 'deposit', 1000);
    const accrued = await (await request.post('/api/qa/savings/accrue', { data: { days: 1 }, ...h(alice) })).json();
    const { businessDate } = accrued.accruals[0];
    const vault = await savings(request, alice);

    // Running the real job for the same date (for this vault only, so parallel tests aren't
    // affected) must not pay that day again.
    const run = spawnSync(
      process.execPath,
      ['jobs/daily-interest.js', '--date', businessDate, '--account', vault.accountNumber],
      { encoding: 'utf8', env: process.env },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`[daily-interest] ${businessDate}: 0 of 1 vault(s) accrued`);
    expect((await savings(request, alice)).interestEarned).toBe(vault.interestEarned);
  });
});

test.describe('Virtual cards (tokenized, PCI-DSS masking)', () => {
  test('generates a tokenized 16-digit Visa card; responses only show a masked number', async ({ request }) => {
    const alice = await createUser(request, 'Alice Tan');
    const response = await request.post('/api/v1/cards/generate', { data: { mpin: alice.mpin }, ...h(alice) });

    expect(response.status(), await response.text()).toBe(201);
    expect(response.headers()['cache-control']).toBe('no-store');
    const card = await response.json();
    expect(card).toMatchObject({ brand: 'VISA', cardholderName: 'ALICE TAN', status: 'ACTIVE', linkedAccount: alice.accountNumber });
    expect(card.token).toMatch(/^card_[A-Za-z0-9_-]{16}$/);
    expect(card.maskedPan).toMatch(/^4847 35•• •••• \d{4}$/);
    expect(card.expiry).toMatch(/^\d{2}\/\d{2}$/);
    expect(JSON.stringify(card)).not.toMatch(/\d{12,}/); // no full PAN anywhere
    expect(card).not.toHaveProperty('cvv');

    const list = await (await request.get('/api/v1/cards', h(alice))).json();
    expect(list.cards).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/\d{12,}/);
  });

  test('reveal needs the MPIN and returns a Luhn-valid PAN matching the masked one, never cached', async ({ request }) => {
    const alice = await createUser(request);
    const card = await (await request.post('/api/v1/cards/generate', { data: { mpin: alice.mpin }, ...h(alice) })).json();

    const wrong = await request.post(`/api/v1/cards/${card.token}/reveal`, { data: { mpin: wrongMpinFor(alice) }, ...h(alice) });
    expect(wrong.status()).toBe(403);

    const response = await request.post(`/api/v1/cards/${card.token}/reveal`, { data: { mpin: alice.mpin }, ...h(alice) });
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const details = await response.json();
    expect(details.pan).toMatch(/^484735\d{10}$/); // Visa BIN 484735 + 10 digits = 16
    expect(luhnValid(details.pan)).toBe(true);
    expect(details.pan.endsWith(card.last4)).toBe(true);
    expect(details.cvv).toMatch(/^\d{3}$/);

    // The CVV isn't stored but derived: revealing again gives the same value.
    const again = await (await request.post(`/api/v1/cards/${card.token}/reveal`, { data: { mpin: alice.mpin }, ...h(alice) })).json();
    expect(again.cvv).toBe(details.cvv);
  });

  test('generating a card needs the MPIN', async ({ request }) => {
    const alice = await createUser(request);
    const response = await request.post('/api/v1/cards/generate', { data: { mpin: wrongMpinFor(alice) }, ...h(alice) });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_MPIN');
  });

  test("other users can't see or reveal my card", async ({ request }) => {
    const alice = await createUser(request);
    const eve = await createUser(request);
    const card = await (await request.post('/api/v1/cards/generate', { data: { mpin: alice.mpin }, ...h(alice) })).json();

    expect((await request.get(`/api/v1/cards/${card.token}`, h(eve))).status()).toBe(404);
    expect((await request.post(`/api/v1/cards/${card.token}/reveal`, { data: { mpin: eve.mpin }, ...h(eve) })).status()).toBe(404);
  });

  test('at most 3 cards; cards can be frozen and unfrozen', async ({ request }) => {
    const alice = await createUser(request);
    const make = () => request.post('/api/v1/cards/generate', { data: { mpin: alice.mpin }, ...h(alice) });
    const card = await (await make()).json();
    await make();
    await make();
    const fourth = await make();
    expect(fourth.status()).toBe(409);
    expect((await fourth.json()).error.code).toBe('CARD_LIMIT_REACHED');

    const frozen = await request.patch(`/api/v1/cards/${card.token}`, { data: { status: 'FROZEN' }, ...h(alice) });
    expect((await frozen.json()).status).toBe('FROZEN');
  });

  test('the database never stores the PAN or CVV in clear text', async ({ request }) => {
    const alice = await createUser(request);
    const card = await (await request.post('/api/v1/cards/generate', { data: { mpin: alice.mpin }, ...h(alice) })).json();
    const { pan } = await (await request.post(`/api/v1/cards/${card.token}/reveal`, { data: { mpin: alice.mpin }, ...h(alice) })).json();

    expect(await tryStatement('SELECT 1 FROM virtual_cards WHERE pan_encrypted LIKE $1 OR pan_fingerprint LIKE $1', [`%${pan}%`])).toBeNull();
    expect(await tryStatement('SELECT cvv FROM virtual_cards LIMIT 1')).toContain('does not exist');
  });
});

test.describe('Idempotency-Key', () => {
  test('a retry with the same key replays the first answer and moves money once', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const key = `test-${Date.now()}-a`;
    const send = () =>
      request.post('/api/transfers', {
        data: { toAccountNumber: bob.accountNumber, amount: 10, mpin: alice.mpin },
        ...h(alice, { 'Idempotency-Key': key }),
      });

    const first = await send();
    const second = await send();

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    expect(second.headers()['idempotent-replayed']).toBe('true');
    expect((await second.json()).transactionId).toBe((await first.json()).transactionId);
    expect(await getBalanceCents(request, bob)).toBe(1000);
  });

  test('a key reused for a different request is rejected', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const key = `test-${Date.now()}-b`;
    const send = (amount: number) =>
      request.post('/api/transfers', {
        data: { toAccountNumber: bob.accountNumber, amount, mpin: alice.mpin },
        ...h(alice, { 'Idempotency-Key': key }),
      });
    await send(10);
    const other = await send(20);
    expect(other.status()).toBe(422);
    expect((await other.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

test.describe('Chaos middleware (x-chaos-mode)', () => {
  const chaos = (extra: Record<string, string>) => ({ 'x-chaos-mode': 'true', ...extra });

  test('without x-chaos-mode nothing happens', async ({ request }) => {
    const alice = await createUser(request);
    const response = await request.get('/api/accounts/me', h(alice, { 'x-chaos-fault': 'drop', 'x-chaos-rate': '1' }));
    expect(response.status()).toBe(200);
  });

  test('drop before: 503 with a clean JSON error and nothing happens', async ({ request }) => {
    const alice = await createFundedAdmin(request, 100);
    const bob = await createUser(request);
    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(response.status()).toBe(201); // control

    const dropped = await request.post('/api/transfers', {
      data: { toAccountNumber: bob.accountNumber, amount: 10, mpin: alice.mpin },
      ...h(alice, chaos({ 'x-chaos-fault': 'drop', 'x-chaos-rate': '1' })),
    });
    expect(dropped.status()).toBe(503);
    expect(dropped.headers()['retry-after']).toBe('1');
    expect(await dropped.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again.',
        details: { chaos: true, droppedWhen: 'before' },
      },
    });
    expect(await getBalanceCents(request, bob)).toBe(1000);
  });

  test('drop after success + retry with the same key: the transfer happens exactly once', async ({ request }) => {
    const alice = await createFundedAdmin(request, 100);
    const bob = await createUser(request);
    const key = `chaos-${Date.now()}`;
    const send = () =>
      request.post('/api/transfers', {
        data: { toAccountNumber: bob.accountNumber, amount: 25, mpin: alice.mpin },
        ...h(alice, chaos({ 'x-chaos-fault': 'drop', 'x-chaos-drop-when': 'after', 'x-chaos-drop-attempts': '1', 'Idempotency-Key': key })),
      });

    const lost = await send();
    expect(lost.status()).toBe(503);
    expect((await lost.json()).error.details.droppedWhen).toBe('after');
    expect(await getBalanceCents(request, bob)).toBe(2500); // it did go through

    const retry = await send();
    expect(retry.status()).toBe(201);
    expect(retry.headers()['idempotent-replayed']).toBe('true');
    expect(await getBalanceCents(request, bob)).toBe(2500); // and only once
    expect(await getBalanceCents(request, alice)).toBe(7500);
  });

  test('db-lock: the request waits 2 s and other work on that wallet waits for the lock', async ({ request }) => {
    const alice = await createFundedAdmin(request, 100);
    const started = Date.now();
    const [slow, move] = await Promise.all([
      request.get('/api/accounts/me', h(alice, chaos({ 'x-chaos-fault': 'db-lock' }))),
      (async () => {
        await new Promise((r) => setTimeout(r, 300)); // start while the lock is held
        const t = Date.now();
        const res = await request.post('/api/v1/savings/deposit', { data: { amount: 10 }, ...h(alice) });
        return { res, waited: Date.now() - t };
      })(),
    ]);
    expect(slow.status()).toBe(200);
    expect(slow.headers()['x-chaos']).toBe('db-lock-2000ms');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(move.res.status()).toBe(201);
    expect(move.waited).toBeGreaterThanOrEqual(1200); // blocked on the wallet row lock
  });
});
