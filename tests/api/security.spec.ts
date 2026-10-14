import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  authHeader,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  wrongMpinFor,
  type TestUser,
} from '../helpers/api';
import { clearMpin, expireMpin, expireOtpChallenge } from '../helpers/db';

/** Start a transfer above ₱1,000 and return the OTP challenge from the 202 response. */
async function requestOtp(request: APIRequestContext, from: TestUser, to: TestUser, amount: number) {
  const response = await transfer(request, from, { toAccountNumber: to.accountNumber, amount });
  expect(response.status(), await response.text()).toBe(202);
  return response.json();
}

test.describe('MPIN', () => {
  test('a wrong MPIN is rejected and no money moves', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: wrongMpinFor(alice) });

    expect(response.status()).toBe(403);
    expect((await response.json()).error).toEqual({ code: 'INVALID_MPIN', message: 'Invalid MPIN' });
    expect(await getBalanceCents(request, alice)).toBe(10000);
    expect(await getBalanceCents(request, bob)).toBe(0);
  });

  test('a missing MPIN is rejected', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: undefined });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('MPIN_REQUIRED');
    expect(await getBalanceCents(request, alice)).toBe(10000);
  });

  for (const mpin of ['12345', '1234567', 'abcdef', 123456, ' 12345']) {
    test(`a badly formatted MPIN is rejected: ${JSON.stringify(mpin)}`, async ({ request }) => {
      const alice = await createFundedUser(request, 100);
      const bob = await createUser(request);

      const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin });

      expect(response.status()).toBe(403);
      expect((await response.json()).error.code).toBe('INVALID_MPIN');
    });
  }

  test('5 wrong MPINs in a row lock transfers, even with the right MPIN', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const send = (mpin?: string) => transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin });

    for (let i = 1; i <= 4; i++) {
      expect((await send(wrongMpinFor(alice))).status(), `attempt ${i}`).toBe(403);
    }
    const fifth = await send(wrongMpinFor(alice));
    expect(fifth.status()).toBe(423);
    expect((await fifth.json()).error.code).toBe('MPIN_LOCKED');

    const correct = await send(alice.mpin);
    expect(correct.status()).toBe(423);
    expect(await getBalanceCents(request, alice)).toBe(10000);
  });

  test('a correct MPIN resets the failed-attempt counter', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const send = (mpin?: string) => transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1, mpin });

    for (let i = 0; i < 4; i++) expect((await send(wrongMpinFor(alice))).status()).toBe(403);
    expect((await send(alice.mpin)).status()).toBe(201);
    for (let i = 0; i < 4; i++) expect((await send(wrongMpinFor(alice))).status()).toBe(403);
  });
});

test.describe('OTP for transfers above ₱1,000', () => {
  test('exactly ₱1,000 does not need an OTP', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1000 });

    expect(response.status()).toBe(201);
    expect(await getBalanceCents(request, bob)).toBe(100000);
  });

  test('above ₱1,000 returns an OTP challenge and moves no money yet', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);

    const challenge = await requestOtp(request, alice, bob, 1000.01);

    expect(challenge).toMatchObject({ otpRequired: true, expiresInSeconds: 30 });
    expect(challenge.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(challenge.demoCode).toMatch(/^\d{6}$/);
    expect(await getBalanceCents(request, alice)).toBe(200000);
    expect(await getBalanceCents(request, bob)).toBe(0);
  });

  test('the correct OTP completes the transfer', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1500);

    const response = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 1500,
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(response.status(), await response.text()).toBe(201);
    expect(await getBalanceCents(request, alice)).toBe(50000);
    expect(await getBalanceCents(request, bob)).toBe(150000);
  });

  test('a wrong OTP is rejected but the right one still works within 3 attempts', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);
    const wrongCode = demoCode === '000000' ? '111111' : '000000';
    const send = (otp: string) =>
      transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1200, otpChallengeId: challengeId, otp });

    const wrong = await send(wrongCode);
    expect(wrong.status()).toBe(403);
    expect((await wrong.json()).error).toEqual({ code: 'INVALID_OTP', message: 'Invalid OTP. 2 attempts left.' });
    expect(await getBalanceCents(request, alice)).toBe(200000);

    expect((await send(demoCode)).status()).toBe(201);
  });

  test('3 wrong OTPs burn the code', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);
    const wrongCode = demoCode === '000000' ? '111111' : '000000';
    const send = (otp: string) =>
      transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1200, otpChallengeId: challengeId, otp });

    expect((await send(wrongCode)).status()).toBe(403);
    expect((await send(wrongCode)).status()).toBe(403);
    const third = await send(wrongCode);
    expect(third.status()).toBe(429);
    expect((await third.json()).error.code).toBe('OTP_ATTEMPTS_EXCEEDED');

    expect((await send(demoCode)).status()).toBe(429);
    expect(await getBalanceCents(request, alice)).toBe(200000);
  });

  test('an OTP can only be used once', async ({ request }) => {
    const alice = await createFundedUser(request, 5000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1100);
    const send = () =>
      transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1100, otpChallengeId: challengeId, otp: demoCode });

    expect((await send()).status()).toBe(201);
    const replay = await send();
    expect(replay.status()).toBe(409);
    expect((await replay.json()).error.code).toBe('OTP_ALREADY_USED');
    expect(await getBalanceCents(request, bob)).toBe(110000);
  });

  test('an expired OTP is rejected', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);
    await expireOtpChallenge(challengeId);

    const response = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 1200,
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(response.status()).toBe(410);
    expect((await response.json()).error.code).toBe('OTP_EXPIRED');
    expect(await getBalanceCents(request, alice)).toBe(200000);
  });

  test('an OTP only works for the exact recipient and amount it was issued for', async ({ request }) => {
    const alice = await createFundedUser(request, 5000);
    const bob = await createUser(request);
    const mallory = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);

    const otherAmount = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 4000,
      otpChallengeId: challengeId,
      otp: demoCode,
    });
    const otherReceiver = await transfer(request, alice, {
      toAccountNumber: mallory.accountNumber,
      amount: 1200,
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(otherAmount.status()).toBe(403);
    expect((await otherAmount.json()).error.code).toBe('OTP_MISMATCH');
    expect(otherReceiver.status()).toBe(403);
    expect(await getBalanceCents(request, alice)).toBe(500000);
  });

  test("another user's OTP challenge cannot be used", async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const eve = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);

    const response = await transfer(request, eve, {
      toAccountNumber: bob.accountNumber,
      amount: 1200,
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_OTP_CHALLENGE');
    expect(await getBalanceCents(request, eve)).toBe(200000);
  });

  test('the MPIN is checked again when the OTP is submitted', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1200);

    const response = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 1200,
      mpin: wrongMpinFor(alice),
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_MPIN');
  });

  test('no OTP is sent when the balance is too low', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1500 });

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('INSUFFICIENT_FUNDS');
  });
});

test.describe('Random MPIN and "Forgot MPIN"', () => {
  const resetMpin = (request: APIRequestContext, user: TestUser, password: string) =>
    request.post('/api/accounts/me/mpin/reset', { data: { password }, headers: authHeader(user.token) });

  test('every new user gets their own random 6-digit MPIN', async ({ request }) => {
    const users = await Promise.all(Array.from({ length: 5 }, () => createUser(request)));
    const mpins = users.map((u) => u.mpin);

    for (const mpin of mpins) expect(mpin).toMatch(/^\d{6}$/);
    expect(new Set(mpins).size, `MPINs should differ: ${mpins.join(', ')}`).toBe(mpins.length);
  });

  test("one user's MPIN does not work for another user", async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    test.skip(alice.mpin === bob.mpin, '1-in-a-million MPIN collision');

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: bob.mpin });

    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_MPIN');
  });

  test('"Forgot MPIN" with the right password gives a new MPIN; the old one stops working', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    const reset = await resetMpin(request, alice, alice.password);
    expect(reset.status(), await reset.text()).toBe(200);
    const { mpin: newMpin } = await reset.json();
    expect(newMpin).toMatch(/^\d{6}$/);
    test.skip(newMpin === alice.mpin, '1-in-a-million: the new MPIN equals the old one');

    const withOld = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(withOld.status()).toBe(403);

    const withNew = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: newMpin });
    expect(withNew.status()).toBe(201);
  });

  test('"Forgot MPIN" with a wrong password is rejected (session stays valid)', async ({ request }) => {
    const alice = await createUser(request);

    const reset = await resetMpin(request, alice, 'not-my-password');

    expect(reset.status()).toBe(403);
    expect((await reset.json()).error.code).toBe('INVALID_PASSWORD');
    expect(await getBalanceCents(request, alice)).toBe(0); // still logged in
  });

  test('"Forgot MPIN" unlocks a locked MPIN', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    for (let i = 0; i < 5; i++) {
      await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: wrongMpinFor(alice) });
    }

    const { mpin } = await (await resetMpin(request, alice, alice.password)).json();
    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin });

    expect(response.status()).toBe(201);
  });

  test('older accounts without an MPIN are told to set one up', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await clearMpin(alice.email);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });

    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('MPIN_NOT_SET');
  });
});

test.describe('MPIN expiry (5 minutes after it is issued)', () => {
  const resetMpin = (request: APIRequestContext, user: TestUser) =>
    request.post('/api/accounts/me/mpin/reset', { data: { password: user.password }, headers: authHeader(user.token) });

  test('sign-up and the balance endpoint report a 5-minute MPIN lifetime', async ({ request }) => {
    const email = `qa.${Date.now()}.${Math.random().toString(36).slice(2)}@paypulse.test`;
    const register = await request.post('/api/auth/register', {
      data: { email, password: 'Sup3rSecret!', fullName: 'Timer' },
    });
    expect((await register.json()).mpinExpiresInSeconds).toBe(300);

    const user = await createUser(request);
    const me = await (await request.get('/api/accounts/me', { headers: authHeader(user.token) })).json();
    expect(me.hasMpin).toBe(true);
    expect(me.mpinExpiresInSeconds).toBeGreaterThan(290);
    expect(me.mpinExpiresInSeconds).toBeLessThanOrEqual(300);
  });

  test('an expired MPIN is rejected, even if correct, and no money moves', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await expireMpin(alice.email);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });

    expect(response.status()).toBe(410);
    expect((await response.json()).error.code).toBe('MPIN_EXPIRED');
    expect(await getBalanceCents(request, alice)).toBe(10000);
    const me = await (await request.get('/api/accounts/me', { headers: authHeader(alice.token) })).json();
    expect(me.mpinExpiresInSeconds).toBe(0);
  });

  test('guesses against an expired MPIN do not count towards the lock', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await expireMpin(alice.email);

    for (let i = 0; i < 6; i++) {
      const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin: wrongMpinFor(alice) });
      expect(response.status()).toBe(410);
    }
  });

  test('getting a new MPIN after expiry works for another 5 minutes', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await expireMpin(alice.email);

    const reset = await resetMpin(request, alice);
    expect(reset.status()).toBe(200);
    const { mpin, mpinExpiresInSeconds } = await reset.json();
    expect(mpinExpiresInSeconds).toBe(300);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10, mpin });
    expect(response.status()).toBe(201);
  });

  test('an MPIN that expires before the OTP step blocks the large transfer', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const bob = await createUser(request);
    const { challengeId, demoCode } = await requestOtp(request, alice, bob, 1500);
    await expireMpin(alice.email);

    const response = await transfer(request, alice, {
      toAccountNumber: bob.accountNumber,
      amount: 1500,
      otpChallengeId: challengeId,
      otp: demoCode,
    });

    expect(response.status()).toBe(410);
    expect((await response.json()).error.code).toBe('MPIN_EXPIRED');
    expect(await getBalanceCents(request, alice)).toBe(200000);
  });
});
