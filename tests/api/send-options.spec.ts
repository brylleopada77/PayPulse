import { test, expect } from '@playwright/test';
import {
  authHeader,
  bankTransfer,
  createFundedUser,
  createUser,
  getBalanceCents,
  setMobile,
  transfer,
  uniqueEmail,
  uniqueMobile,
  wrongMpinFor,
} from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';

const BDO = { bankCode: 'BDO', accountNumber: '0012-3456-7890', accountName: 'Juan Dela Cruz' };

test.describe('Express Send by mobile number', () => {
  test('registration accepts an optional mobile number in any common format', async ({ request }) => {
    const mobile = uniqueMobile();
    const response = await request.post('/api/auth/register', {
      data: { email: uniqueEmail(), password: 'Sup3rSecret!', fullName: 'Mobile User', mobileNumber: `+63 ${mobile.slice(1)}` },
    });
    expect(response.status(), await response.text()).toBe(201);
    expect((await response.json()).user.mobileNumber).toBe(mobile);
  });

  test('a mobile number can belong to only one account', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);
    const mobile = await setMobile(request, alice);

    const response = await request.put('/api/accounts/me/mobile', {
      data: { mobileNumber: mobile },
      headers: authHeader(bob.token),
    });

    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('MOBILE_TAKEN');
  });

  test('rejects an invalid mobile number', async ({ request }) => {
    const alice = await createUser(request);
    const response = await request.put('/api/accounts/me/mobile', {
      data: { mobileNumber: '12345' },
      headers: authHeader(alice.token),
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_MOBILE_NUMBER');
  });

  test('sends money to a mobile number for free', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const bob = await createUser(request, 'Bob Santos');
    const mobile = await setMobile(request, bob);

    const response = await transfer(request, alice, { toMobileNumber: mobile, amount: 120 });

    expect(response.status(), await response.text()).toBe(201);
    expect(await response.json()).toMatchObject({
      method: 'EXPRESS',
      to: bob.accountNumber,
      receiverName: 'Bob S.',
      amountCents: 12000,
      feeCents: 0,
      totalDeductedCents: 12000,
    });
    expect(await getBalanceCents(request, alice)).toBe(38000);
    expect(await getBalanceCents(request, bob)).toBe(12000);
  });

  test('an unknown mobile number is rejected', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const response = await transfer(request, alice, { toMobileNumber: uniqueMobile(), amount: 10 });

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('RECEIVER_NOT_FOUND');
    expect(await getBalanceCents(request, alice)).toBe(10000);
  });
});

test.describe('Bank Transfer (₱15 fee)', () => {
  test('lists the banks and the fee', async ({ request }) => {
    const alice = await createUser(request);
    const response = await request.get('/api/transfers/banks', { headers: authHeader(alice.token) });
    const body = await response.json();

    expect(body.feeCents).toBe(1500);
    expect(body.banks.map((b: { name: string }) => b.name)).toEqual(['GCash', 'Maya', 'BDO', 'BPI', 'Metrobank']);
  });

  test('deducts amount + ₱15 fee and records "Bank Transfer to BDO"', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);

    const response = await bankTransfer(request, alice, { ...BDO, amount: 500 });

    expect(response.status(), await response.text()).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      method: 'BANK',
      bank: { code: 'BDO', name: 'BDO' },
      accountNumber: '••••7890',
      accountName: 'Juan Dela Cruz',
      amountCents: 50000,
      feeCents: 1500,
      totalDeductedCents: 51500,
      balanceAfter: '485.00',
    });
    expect(result.reference).toMatch(/^REF-\d{8}-\d{4,}$/);
    expect(result.bankReference).toMatch(/^BT-[0-9A-F]{10}$/);
    expect(await getBalanceCents(request, alice)).toBe(48500);

    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    expect(history.transactions[0]).toMatchObject({
      type: 'BANK_TRANSFER',
      direction: 'DEBIT',
      description: 'Bank Transfer to BDO',
      amountCents: 51500,
      reference: result.reference,
      bankTransfer: { bank: 'BDO', accountNumber: '••••7890', amount: '500.00', fee: '15.00', bankReference: result.bankReference },
    });
  });

  test('the ledger stays balanced: settlement gets the amount, fee income gets ₱15', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    expect((await bankTransfer(request, alice, { ...BDO, amount: 200 })).status()).toBe(201);

    const report = await checkLedgerIntegrity([alice.accountNumber, 'SYS-BANK-SETTLEMENT', 'SYS-FEE-INCOME']);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.mismatchedAccounts).toEqual([]);
  });

  test('GCash and Maya use the recipient mobile number', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);

    const ok = await bankTransfer(request, alice, {
      bankCode: 'GCASH',
      accountNumber: '+639171234567',
      accountName: 'Ana Reyes',
      amount: 100,
    });
    expect(ok.status(), await ok.text()).toBe(201);
    expect((await ok.json()).accountNumber).toBe('••••4567');

    const bad = await bankTransfer(request, alice, {
      bankCode: 'MAYA',
      accountNumber: '0012345678',
      accountName: 'Ana Reyes',
      amount: 100,
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('INVALID_BANK_ACCOUNT');
  });

  test('the fee counts towards the balance check', async ({ request }) => {
    const alice = await createFundedUser(request, 100);

    const tooMuch = await bankTransfer(request, alice, { ...BDO, amount: 90 }); // 90 + 15 = 105 > 100
    expect(tooMuch.status()).toBe(422);
    expect((await tooMuch.json()).error.message).toContain('105.00');
    expect(await getBalanceCents(request, alice)).toBe(10000);

    const exact = await bankTransfer(request, alice, { ...BDO, amount: 85 }); // 85 + 15 = 100
    expect(exact.status()).toBe(201);
    expect(await getBalanceCents(request, alice)).toBe(0);
  });

  const invalidInputs = [
    ['bankCode', 'CHASE', 'INVALID_BANK'],
    ['accountNumber', '12345', 'INVALID_BANK_ACCOUNT'],
    ['accountNumber', 'abcdefghijkl', 'INVALID_BANK_ACCOUNT'],
    ['accountName', ' ', 'INVALID_ACCOUNT_NAME'],
  ] as const;

  for (const [field, value, code] of invalidInputs) {
    test(`rejects invalid ${field}: ${JSON.stringify(value)}`, async ({ request }) => {
      const alice = await createFundedUser(request, 1000);
      const response = await bankTransfer(request, alice, { ...BDO, [field]: value, amount: 100 });
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect(await getBalanceCents(request, alice)).toBe(100000);
    });
  }

  test('needs the MPIN', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const response = await bankTransfer(request, alice, { ...BDO, amount: 100, mpin: wrongMpinFor(alice) });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_MPIN');
    expect(await getBalanceCents(request, alice)).toBe(100000);
  });

  test('above ₱1,000 needs an OTP that is bound to the bank account', async ({ request }) => {
    const alice = await createFundedUser(request, 5000);

    const first = await bankTransfer(request, alice, { ...BDO, amount: 1500 });
    expect(first.status()).toBe(202);
    const { challengeId, demoCode } = await first.json();
    expect(await getBalanceCents(request, alice)).toBe(500000);

    const otherAccount = await bankTransfer(request, alice, {
      ...BDO,
      accountNumber: '9999999999',
      amount: 1500,
      otpChallengeId: challengeId,
      otp: demoCode,
    });
    expect(otherAccount.status()).toBe(403);
    expect((await otherAccount.json()).error.code).toBe('OTP_MISMATCH');

    const done = await bankTransfer(request, alice, { ...BDO, amount: 1500, otpChallengeId: challengeId, otp: demoCode });
    expect(done.status(), await done.text()).toBe(201);
    expect(await getBalanceCents(request, alice)).toBe(500000 - 151500);
  });
});
