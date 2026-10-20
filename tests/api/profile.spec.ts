import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedUser, createUser, transfer, wrongMpinFor, type TestUser } from '../helpers/api';

// My Profile: KYC level (sets the daily send limit), linked accounts, Change MPIN,
// security preferences (SMS 2FA on every transfer) and support tickets.

const get = async (request: APIRequestContext, user: TestUser) =>
  (await request.get('/api/v1/profile', { headers: authHeader(user.token) })).json();
const post = (request: APIRequestContext, user: TestUser, path: string, data: Record<string, unknown>) =>
  request.post(path, { data, headers: authHeader(user.token) });
const KYC = { idType: 'PHILSYS', idNumber: '1234-5678-9012', birthDate: '1995-06-15', selfieConfirmed: true };
const payBill = (request: APIRequestContext, user: TestUser, amount: number) =>
  post(request, user, '/api/v1/bills/pay', {
    billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount, mpin: user.mpin,
  });

test.describe('Profile: KYC level and daily limit', () => {
  test('a new account is Level 1 (Basic) with a ₱50,000 daily limit', async ({ request }) => {
    const alice = await createUser(request);
    const profile = await get(request, alice);
    expect(profile.kyc).toMatchObject({ level: 1, label: 'Level 1 (Basic)', verified: false, dailyLimit: '50000.00', idNumber: null });
    expect(profile.kyc.tiers.map((t: { label: string; dailyLimit: string }) => [t.label, t.dailyLimit])).toEqual([
      ['Level 1 (Basic)', '50000.00'],
      ['Level 2 (Fully Verified)', '100000.00'],
    ]);
    expect(profile).toMatchObject({ security: { smsTwoFactor: false, biometricLogin: false }, linkedAccounts: [], supportTickets: [] });
    expect((await (await request.get('/api/accounts/me', { headers: authHeader(alice.token) })).json()).kycLevel).toBe(1);
  });

  test('verifying an ID makes the account Level 2 and the server enforces ₱100,000 a day', async ({ request }) => {
    const alice = await createFundedUser(request, 120_000);
    const verified = await post(request, alice, '/api/v1/profile/kyc', KYC);
    expect(verified.status()).toBe(200);
    expect(await verified.json()).toMatchObject({
      level: 2, label: 'Level 2 (Fully Verified)', verified: true, dailyLimit: '100000.00',
      idType: 'PhilSys National ID', idNumber: '•••• 9012',
    });
    const limits = await (await request.get('/api/transfers/limits', { headers: authHeader(alice.token) })).json();
    expect(limits.daily).toMatchObject({ kycLevel: 2, limit: '100000.00' });

    expect((await payBill(request, alice, 50_000)).status()).toBe(201);
    expect((await payBill(request, alice, 49_000)).status()).toBe(201); // over ₱50,000 today: fine at Level 2
    const over = await payBill(request, alice, 1000.01);
    expect(over.status()).toBe(400);
    expect((await over.json()).error).toMatchObject({
      code: 'DAILY_LIMIT_EXCEEDED',
      message: 'Daily transaction limit of ₱100,000 exceeded.',
      details: { dailyLimit: '100000.00', sentToday: '99000.00' },
    });
  });

  test('a Level 1 account is still stopped at ₱50,000', async ({ request }) => {
    const bob = await createFundedUser(request, 60_000);
    expect((await payBill(request, bob, 50_000)).status()).toBe(201);
    const over = await payBill(request, bob, 100);
    expect(over.status()).toBe(400);
    expect((await over.json()).error.message).toBe('Daily transaction limit of ₱50,000 exceeded.');
  });

  for (const [label, data, code] of [
    ['an unknown ID type', { ...KYC, idType: 'LIBRARY_CARD' }, 'INVALID_ID_TYPE'],
    ['a too-short ID number', { ...KYC, idNumber: '123' }, 'INVALID_ID_NUMBER'],
    ['an impossible date', { ...KYC, birthDate: '1995-02-30' }, 'INVALID_BIRTH_DATE'],
    ['a minor', { ...KYC, birthDate: `${new Date().getFullYear() - 16}-01-01` }, 'UNDERAGE'],
    ['no selfie', { ...KYC, selfieConfirmed: false }, 'SELFIE_REQUIRED'],
  ] as const) {
    test(`KYC rejects ${label} (400 ${code})`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await post(request, alice, '/api/v1/profile/kyc', data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect((await get(request, alice)).kyc.level).toBe(1);
    });
  }

  test('verifying twice: 409 ALREADY_VERIFIED', async ({ request }) => {
    const alice = await createUser(request);
    await post(request, alice, '/api/v1/profile/kyc', KYC);
    const again = await post(request, alice, '/api/v1/profile/kyc', KYC);
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('ALREADY_VERIFIED');
  });
});

test.describe('Profile: linked bank accounts and cards', () => {
  const link = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    post(request, user, '/api/v1/profile/linked-accounts', { holderName: 'Alice Tan', mpin: user.mpin, ...data });

  test('links a bank account and a Visa; only the last 4 digits are kept', async ({ request }) => {
    const alice = await createUser(request);
    const bank = await link(request, alice, { kind: 'BANK', bankCode: 'BDO', accountNumber: '0012 3456 7890' });
    expect(bank.status()).toBe(201);
    expect(await bank.json()).toMatchObject({ kind: 'BANK', institution: 'BDO', name: 'BDO Unibank', maskedNumber: '•••• 7890' });

    const card = await link(request, alice, { kind: 'CARD', cardNumber: '4111 1111 1111 1111', expiry: '12/39' });
    expect(card.status()).toBe(201);
    expect(await card.json()).toMatchObject({ kind: 'CARD', institution: 'Visa', maskedNumber: '•••• 1111', expiry: '12/39' });

    const profile = await get(request, alice);
    expect(profile.linkedAccounts).toHaveLength(2);
    expect(JSON.stringify(profile)).not.toContain('4111111111111111');
    expect(JSON.stringify(profile)).not.toContain('001234567890');
  });

  for (const [label, data, code] of [
    ['an unknown bank', { kind: 'BANK', bankCode: 'ACME', accountNumber: '0012345678' }, 'INVALID_BANK'],
    ['a short bank account number', { kind: 'BANK', bankCode: 'BPI', accountNumber: '12345' }, 'INVALID_ACCOUNT_NUMBER'],
    ['a card that fails the Luhn check', { kind: 'CARD', cardNumber: '4111111111111112', expiry: '12/39' }, 'INVALID_CARD_NUMBER'],
    ['a non-Visa/Mastercard card', { kind: 'CARD', cardNumber: '6011111111111117', expiry: '12/39' }, 'UNSUPPORTED_CARD'],
    ['an expired card', { kind: 'CARD', cardNumber: '5555555555554444', expiry: '01/20' }, 'CARD_EXPIRED'],
  ] as const) {
    test(`rejects ${label} (400 ${code})`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await link(request, alice, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    });
  }

  test('needs the MPIN; duplicates and more than 5 are refused; remove works only for your own', async ({ request }) => {
    const alice = await createUser(request);
    const mallory = await createUser(request);
    const wrong = await link(request, alice, { kind: 'BANK', bankCode: 'BPI', accountNumber: '1234567890', mpin: wrongMpinFor(alice) });
    expect(wrong.status()).toBe(403);
    expect((await get(request, alice)).linkedAccounts).toEqual([]);

    for (const n of [1, 2, 3, 4, 5]) {
      expect((await link(request, alice, { kind: 'BANK', bankCode: 'BPI', accountNumber: `123456789${n}` })).status()).toBe(201);
    }
    const dup = await link(request, alice, { kind: 'BANK', bankCode: 'BPI', accountNumber: '1234567891' });
    expect(dup.status()).toBe(409);
    const sixth = await link(request, alice, { kind: 'BANK', bankCode: 'BDO', accountNumber: '9999999999' });
    expect((await sixth.json()).error.code).toBe('TOO_MANY_LINKED_ACCOUNTS');

    const [first] = (await get(request, alice)).linkedAccounts;
    const theirs = await request.delete(`/api/v1/profile/linked-accounts/${first.id}`, { headers: authHeader(mallory.token) });
    expect(theirs.status()).toBe(404);
    const mine = await request.delete(`/api/v1/profile/linked-accounts/${first.id}`, { headers: authHeader(alice.token) });
    expect(mine.status()).toBe(204);
    expect((await get(request, alice)).linkedAccounts).toHaveLength(4);
  });
});

test.describe('Profile: Change MPIN', () => {
  const change = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    post(request, user, '/api/accounts/me/mpin/change', { currentMpin: user.mpin, ...data });

  test('old MPIN -> new MPIN twice; transfers then need the new one', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const newMpin = alice.mpin === '583920' ? '583921' : '583920';

    const response = await change(request, alice, { newMpin, confirmMpin: newMpin });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ message: 'Your MPIN has been changed', mpinExpiresInSeconds: 300 });

    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 })).status()).toBe(403);
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1, mpin: newMpin })).status()).toBe(201);
  });

  for (const [label, data, status, code] of [
    ['the wrong current MPIN', { currentMpin: 'WRONG', newMpin: '583920', confirmMpin: '583920' }, 403, 'INVALID_MPIN'],
    ['a new MPIN that is not 6 digits', { newMpin: '58392', confirmMpin: '58392' }, 400, 'INVALID_NEW_MPIN'],
    ['a confirmation that does not match', { newMpin: '583920', confirmMpin: '583929' }, 400, 'MPIN_MISMATCH'],
    ['a repeated digit', { newMpin: '777777', confirmMpin: '777777' }, 400, 'WEAK_MPIN'],
    ['a straight run', { newMpin: '123456', confirmMpin: '123456' }, 400, 'WEAK_MPIN'],
    ['a falling run', { newMpin: '987654', confirmMpin: '987654' }, 400, 'WEAK_MPIN'],
  ] as const) {
    test(`rejects ${label} (${status} ${code})`, async ({ request }) => {
      const alice = await createUser(request);
      const body = data.currentMpin === 'WRONG' ? { ...data, currentMpin: wrongMpinFor(alice) } : data;
      const response = await change(request, alice, body);
      expect(response.status()).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    });
  }

  test('the new MPIN must differ from the current one', async ({ request }) => {
    const alice = await createUser(request);
    const response = await change(request, alice, { newMpin: alice.mpin, confirmMpin: alice.mpin });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toMatch(/MPIN_SAME_AS_OLD|WEAK_MPIN/);
  });
});

test.describe('Profile: security preferences', () => {
  const patch = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
    request.patch('/api/v1/profile/security', { data, headers: authHeader(user.token) });

  test('SMS 2FA on: even a ₱10 Send needs a code; turning it off needs the MPIN', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    expect(await (await patch(request, alice, { smsTwoFactor: true })).json()).toEqual({ smsTwoFactor: true, biometricLogin: false });

    const small = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(small.status()).toBe(202);
    expect(await small.json()).toMatchObject({ otpRequired: true });

    const noMpin = await patch(request, alice, { smsTwoFactor: false });
    expect(noMpin.status()).toBe(400);
    expect((await noMpin.json()).error.code).toBe('MPIN_REQUIRED');
    expect((await patch(request, alice, { smsTwoFactor: false, mpin: alice.mpin })).status()).toBe(200);
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 })).status()).toBe(201);
  });

  test('biometric login is saved as a preference', async ({ request }) => {
    const alice = await createUser(request);
    expect(await (await patch(request, alice, { biometricLogin: true })).json()).toEqual({ smsTwoFactor: false, biometricLogin: true });
    expect((await get(request, alice)).security.biometricLogin).toBe(true);
  });
});

test.describe('Profile: support tickets', () => {
  test('creates a ticket with a PP-TKT number and lists it', async ({ request }) => {
    const alice = await createUser(request);
    const response = await post(request, alice, '/api/v1/profile/support/tickets', {
      category: 'BILLS', subject: 'Cashback missing', message: 'I paid Meralco but did not get my cashback.',
    });
    expect(response.status()).toBe(201);
    const ticket = await response.json();
    expect(ticket).toMatchObject({ category: 'BILLS', subject: 'Cashback missing', status: 'OPEN' });
    expect(ticket.ticketNumber).toMatch(/^PP-TKT-\d{6}$/);
    expect((await get(request, alice)).supportTickets[0].ticketNumber).toBe(ticket.ticketNumber);
  });

  for (const [label, data, code] of [
    ['an unknown topic', { category: 'FOOD', subject: 'Hello there', message: 'Something went wrong here.' }, 'INVALID_CATEGORY'],
    ['a too-short subject', { category: 'OTHER', subject: 'Hi', message: 'Something went wrong here.' }, 'INVALID_SUBJECT'],
    ['a too-short message', { category: 'OTHER', subject: 'Hello there', message: 'Help' }, 'INVALID_MESSAGE'],
  ] as const) {
    test(`rejects ${label} (400 ${code})`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await post(request, alice, '/api/v1/profile/support/tickets', data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    });
  }
});
