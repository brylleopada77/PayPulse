import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  authHeader,
  bankTransfer,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  type TestUser,
} from '../helpers/api';
import { ageOutgoingTransactions } from '../helpers/db';

const DAILY_LIMIT_MESSAGE = 'Daily transaction limit of ₱50,000 exceeded.';
const BDO = { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz' };

/** Finish a transfer that may need an OTP (above ₱1,000): repeats the call with the code. */
async function completeWithOtp(first: APIResponse, repeat: (otp: { otpChallengeId: string; otp: string }) => Promise<APIResponse>) {
  if (first.status() !== 202) return first;
  const { challengeId, demoCode } = await first.json();
  return repeat({ otpChallengeId: challengeId, otp: demoCode });
}

async function send(request: APIRequestContext, from: TestUser, to: TestUser, amount: number) {
  const data = { toAccountNumber: to.accountNumber, amount };
  return completeWithOtp(await transfer(request, from, data), (otp) => transfer(request, from, { ...data, ...otp }));
}

async function sendToBank(request: APIRequestContext, from: TestUser, amount: number) {
  const data = { ...BDO, amount };
  return completeWithOtp(await bankTransfer(request, from, data), (otp) => bankTransfer(request, from, { ...data, ...otp }));
}

async function limits(request: APIRequestContext, user: TestUser) {
  return (await request.get('/api/transfers/limits', { headers: authHeader(user.token) })).json();
}

test.describe('Daily transfer limit (₱50,000)', () => {
  test('starts with the full ₱50,000 available', async ({ request }) => {
    const alice = await createUser(request);
    expect(await limits(request, alice)).toMatchObject({
      daily: { limit: '50000.00', sentToday: '0.00', remaining: '50000.00' },
      rateLimit: { maxTransfers: 3, windowSeconds: 10, transfersInWindow: 0 },
    });
  });

  test('exactly ₱50,000 in one transfer is allowed', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);

    const response = await send(request, alice, bob, 50_000);

    expect(response.status(), await response.text()).toBe(201);
    expect((await limits(request, alice)).daily).toMatchObject({ sentToday: '50000.00', remaining: '0.00' });
  });

  test('₱50,000.01 is rejected with 400 and a clean JSON error, before any OTP is sent', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 50_000.01 });

    expect(response.status()).toBe(400);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({
      error: {
        code: 'DAILY_LIMIT_EXCEEDED',
        message: DAILY_LIMIT_MESSAGE,
        details: {
          dailyLimit: '50000.00',
          sentToday: '0.00',
          remainingToday: '50000.00',
          requested: '50000.01',
          resetsAt: expect.any(String),
        },
      },
    });
    expect(await getBalanceCents(request, alice)).toBe(6_000_000);
  });

  test('the limit is cumulative: ₱30,000 + ₱20,000 is allowed, one more centavo is not', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);

    expect((await send(request, alice, bob, 30_000)).status()).toBe(201);
    expect((await send(request, alice, bob, 20_000)).status()).toBe(201);
    const extra = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 0.01 });

    expect(extra.status()).toBe(400);
    const { error } = await extra.json();
    expect(error.message).toBe(DAILY_LIMIT_MESSAGE);
    expect(error.details).toMatchObject({ sentToday: '50000.00', remainingToday: '0.00' });
    expect(await getBalanceCents(request, bob)).toBe(5_000_000);
  });

  test('bank transfers count by amount; the ₱15 fee does not use up the limit', async ({ request }) => {
    const alice = await createFundedUser(request, 60_000);
    const bob = await createUser(request);

    expect((await send(request, alice, bob, 49_000)).status()).toBe(201);
    expect((await sendToBank(request, alice, 1_000)).status()).toBe(201); // 1,000 + ₱15 fee

    expect((await limits(request, alice)).daily).toMatchObject({ sentToday: '50000.00', remaining: '0.00' });
    const over = await sendToBank(request, alice, 1);
    expect(over.status()).toBe(400);
    expect((await over.json()).error.code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  test('money you receive does not count towards your limit', async ({ request }) => {
    const alice = await createFundedUser(request, 40_000);
    const bob = await createFundedUser(request, 20_000);

    expect((await send(request, alice, bob, 30_000)).status()).toBe(201);

    // Bob received ₱30,000 today but has sent nothing: the full ₱50,000 is still available.
    expect((await send(request, bob, alice, 50_000)).status()).toBe(201);
  });

  test("yesterday's transfers do not count", async ({ request }) => {
    const alice = await createFundedUser(request, 90_000);
    const bob = await createUser(request);
    expect((await send(request, alice, bob, 45_000)).status()).toBe(201);

    await ageOutgoingTransactions(alice.accountNumber, '1 day');

    expect((await limits(request, alice)).daily.sentToday).toBe('0.00');
    expect((await send(request, alice, bob, 45_000)).status()).toBe(201);
  });

  test('the limit is checked again on the OTP step', async ({ request }) => {
    const alice = await createFundedUser(request, 70_000);
    const bob = await createUser(request);
    const data = { toAccountNumber: bob.accountNumber, amount: 30_000 };

    // A: OTP requested while ₱0 has been sent -> allowed for now.
    const pending = await transfer(request, alice, data);
    expect(pending.status()).toBe(202);
    const { challengeId, demoCode } = await pending.json();

    // B: another ₱30,000 completes first.
    expect((await send(request, alice, bob, 30_000)).status()).toBe(201);

    // A finishes: 30,000 + 30,000 > 50,000.
    const finish = await transfer(request, alice, { ...data, otpChallengeId: challengeId, otp: demoCode });
    expect(finish.status()).toBe(400);
    expect((await finish.json()).error.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(await getBalanceCents(request, alice)).toBe(4_000_000);
  });
});

test.describe('Anti-spam: at most 3 transfers in 10 seconds', () => {
  test('the 4th transfer within 10 seconds is blocked with 429', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);

    for (let i = 1; i <= 3; i++) {
      expect((await send(request, alice, bob, 5)).status(), `transfer ${i}`).toBe(201);
    }
    const fourth = await send(request, alice, bob, 5);

    expect(fourth.status()).toBe(429);
    const retryAfter = Number(fourth.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(10);
    expect(await fourth.json()).toEqual({
      error: {
        code: 'TOO_MANY_TRANSFERS',
        message: expect.stringMatching(/^Too many transfers\. You can make at most 3 transfers every 10 seconds\./),
        details: { maxTransfers: 3, windowSeconds: 10, retryAfterSeconds: retryAfter },
      },
    });
    expect(await getBalanceCents(request, alice)).toBe(8500);
  });

  test('transfers are allowed again once the 10 seconds have passed', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    for (let i = 0; i < 3; i++) await send(request, alice, bob, 5);
    expect((await send(request, alice, bob, 5)).status()).toBe(429);

    await ageOutgoingTransactions(alice.accountNumber, '11 seconds');

    expect((await send(request, alice, bob, 5)).status()).toBe(201);
  });

  test('Express Send and Bank Transfer share the same counter', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const bob = await createUser(request);

    expect((await send(request, alice, bob, 10)).status()).toBe(201);
    expect((await sendToBank(request, alice, 10)).status()).toBe(201);
    expect((await send(request, alice, bob, 10)).status()).toBe(201);

    const fourth = await sendToBank(request, alice, 10);
    expect(fourth.status()).toBe(429);
    expect((await fourth.json()).error.code).toBe('TOO_MANY_TRANSFERS');
  });

  test('failed transfers do not count', async ({ request }) => {
    const alice = await createFundedUser(request, 20);
    const bob = await createUser(request);

    for (let i = 0; i < 4; i++) {
      expect((await send(request, alice, bob, 500)).status()).toBe(422); // insufficient funds
    }
    expect((await send(request, alice, bob, 5)).status()).toBe(201);
  });

  test('receiving many transfers does not block you from sending', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const carol = await createFundedUser(request, 100);
    const bob = await createFundedUser(request, 100);

    for (let i = 0; i < 2; i++) await send(request, alice, bob, 1);
    for (let i = 0; i < 2; i++) await send(request, carol, bob, 1);

    expect((await send(request, bob, alice, 1)).status()).toBe(201);
  });

  test('the limits page shows how many transfers are in the window', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request);
    await send(request, alice, bob, 1);
    await send(request, alice, bob, 1);

    expect((await limits(request, alice)).rateLimit.transfersInWindow).toBe(2);
  });
});

test.describe('Clean JSON errors', () => {
  test('unknown routes return a JSON 404', async ({ request }) => {
    const response = await request.get('/api/does-not-exist');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'No route for GET /api/does-not-exist' },
    });
  });

  test('malformed JSON returns 400 INVALID_JSON', async ({ request }) => {
    const alice = await createUser(request);
    const response = await request.post('/api/transfers', {
      data: '{"amount": 10,',
      headers: { ...authHeader(alice.token), 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  });

  test('a body over 100 kB returns 413 PAYLOAD_TOO_LARGE', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      data: { email: 'a@b.co', password: 'x'.repeat(150_000) },
    });
    expect(response.status()).toBe(413);
    expect((await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('a missing token returns 401 in the same shape', async ({ request }) => {
    const response = await request.post('/api/transfers', { data: { toAccountNumber: 'PP1', amount: 1 } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  });

  test('errors never leak extra fields: only code, message and optional details', async ({ request }) => {
    const alice = await createFundedUser(request, 10);
    const bob = await createUser(request);
    for (const response of [
      await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 'abc' }),
      await transfer(request, alice, { toAccountNumber: 'PP0000000000', amount: 1 }),
      await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1, mpin: undefined }),
      await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 50 }),
    ]) {
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).every((key) => ['code', 'message', 'details'].includes(key))).toBe(true);
      expect(body.error.code).toMatch(/^[A-Z_]+$/);
      expect(typeof body.error.message).toBe('string');
    }
  });
});
