import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createUser, getBalanceCents, sendPaymentWebhook } from '../helpers/api';

test.describe('Payment webhook', () => {
  test('SUCCESS callback credits the wallet', async ({ request }) => {
    const user = await createUser(request);

    const response = await sendPaymentWebhook(request, {
      accountNumber: user.accountNumber,
      amount: 250,
      status: 'SUCCESS',
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, status: 'SUCCESS', credited: true });
    expect(await getBalanceCents(request, user)).toBe(25000);
  });

  test('repeated callbacks for the same payment credit only once', async ({ request }) => {
    const user = await createUser(request);
    const paymentId = `pay_${randomUUID()}`;
    const payload = { paymentId, accountNumber: user.accountNumber, amount: 100, status: 'SUCCESS' };

    const responses = await Promise.all([1, 2, 3].map(() => sendPaymentWebhook(request, payload)));

    responses.forEach((r) => expect(r.status()).toBe(200));
    const credited = (await Promise.all(responses.map((r) => r.json()))).filter((b) => b.credited);
    expect(credited).toHaveLength(1);
    expect(await getBalanceCents(request, user)).toBe(10000);
  });

  test('PENDING then SUCCESS credits once the payment completes', async ({ request }) => {
    const user = await createUser(request);
    const paymentId = `pay_${randomUUID()}`;
    const base = { paymentId, accountNumber: user.accountNumber, amount: 60 };

    const pending = await sendPaymentWebhook(request, { ...base, status: 'PENDING' });
    expect((await pending.json()).credited).toBe(false);
    expect(await getBalanceCents(request, user)).toBe(0);

    const success = await sendPaymentWebhook(request, { ...base, status: 'SUCCESS' });
    expect((await success.json()).credited).toBe(true);
    expect(await getBalanceCents(request, user)).toBe(6000);
  });

  test('FAILED callback does not credit the wallet', async ({ request }) => {
    const user = await createUser(request);

    const response = await sendPaymentWebhook(request, {
      accountNumber: user.accountNumber,
      amount: 100,
      status: 'FAILED',
    });

    expect(response.status()).toBe(200);
    expect((await response.json()).credited).toBe(false);
    expect(await getBalanceCents(request, user)).toBe(0);
  });

  test('rejects a callback signed with the wrong secret', async ({ request }) => {
    const user = await createUser(request);

    const response = await sendPaymentWebhook(
      request,
      { accountNumber: user.accountNumber, amount: 100, status: 'SUCCESS' },
      'attacker-secret',
    );

    expect(response.status()).toBe(401);
    expect(await getBalanceCents(request, user)).toBe(0);
  });

  test('rejects a callback without a signature', async ({ request }) => {
    const response = await request.post('/api/webhooks/payments', {
      data: { paymentId: 'pay_x', accountNumber: 'PP1000000001', amount: 1, status: 'SUCCESS' },
    });
    expect(response.status()).toBe(401);
  });

  test('rejects an unknown status', async ({ request }) => {
    const user = await createUser(request);
    const response = await sendPaymentWebhook(request, {
      accountNumber: user.accountNumber,
      amount: 10,
      status: 'MAYBE',
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_STATUS');
  });

  test('rejects an unknown account', async ({ request }) => {
    const response = await sendPaymentWebhook(request, {
      accountNumber: 'PP0000000000',
      amount: 10,
      status: 'SUCCESS',
    });

    expect(response.status()).toBe(404);
  });
});
