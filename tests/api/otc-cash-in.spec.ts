import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { WEBHOOK_SECRET, authHeader, createAdmin, createUser, getBalanceCents, type TestUser } from '../helpers/api';
import { checkLedgerIntegrity, tryStatement } from '../helpers/db';

// Over-the-counter cash-in: a 12-digit code (Luhn check digit) valid 24 hours, paid in cash at a
// partner (amount + the partner's counter fee). The partner's signed webhook credits the wallet the
// amount exactly once (DEPOSIT from SYS-EXTERNAL-FUNDING); the counter fee never enters the ledger.

const createCode = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
  request.post('/api/v1/cash-in/otc', { data, headers: authHeader(user.token) });

/** The partner confirms payment (signed like the payment webhook). */
function counterPays(request: APIRequestContext, data: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(data);
  return request.post('/api/webhooks/otc', {
    data: body,
    headers: { 'X-PayPulse-Signature': createHmac('sha256', secret).update(body).digest('hex'), 'Content-Type': 'application/json' },
  });
}

const luhnOk = (ref: string) => {
  let sum = 0;
  [...ref].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2 === 1) n *= 2;
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
};

test.describe('OTC cash-in: partners and fees', () => {
  test('19 partners in 4 categories, each with a fee rule, a label and a logo or badge', async ({ request }) => {
    const alice = await createUser(request);
    const body = await (await request.get('/api/v1/cash-in/otc/partners', { headers: authHeader(alice.token) })).json();
    expect(Object.keys(body.categories)).toEqual(['PAWNSHOP', 'STORE', 'MALL', 'PHARMACY']);
    expect(body.partners).toHaveLength(19);
    expect(body).toMatchObject({ minAmount: '100.00', maxAmount: '50000.00', validHours: 24 });
    const byCode = Object.fromEntries(body.partners.map((p: { code: string }) => [p.code, p]));
    expect(byCode.CEBUANA).toMatchObject({ name: 'Cebuana Lhuillier', category: 'PAWNSHOP', feeLabel: '1% fee', logo: '/img/otc/cebuana.png' });
    expect(byCode['7ELEVEN']).toMatchObject({ category: 'STORE', feeLabel: '₱15 fee' });
    expect(byCode.BAYAD.feeLabel).toBe('Free');
    expect(byCode.ROBINSONS.feeLabel).toBe('Free');
    expect(byCode.RDPAWNSHOP).toMatchObject({ logo: null, badge: { initials: 'RD' } });
    // current logos from Wikipedia (Alfamart's red and yellow wordmark, not the old blue icon)
    expect(byCode.UNCLEJOHNS.logo).toBe('/img/otc/unclejohns.png');
    expect(byCode.TAMBUNTING.logo).toBe('/img/otc/tambunting.png');
    expect(byCode.ALFAMART.logo).toBe('/img/otc/alfamart.png');
    for (const p of body.partners) {
      if (!p.logo) continue;
      const img = await request.get(p.logo);
      expect(img.status(), p.logo).toBe(200);
      expect(img.headers()['content-type'], p.logo).toMatch(/^image\//);
    }
  });

  for (const [partnerCode, amount, fee, total] of [
    ['CEBUANA', '1000', '10.00', '1010.00'], // 1%
    ['CEBUANA', '1234.56', '12.35', '1246.91'], // 1%, rounded to the centavo
    ['7ELEVEN', '500', '15.00', '515.00'], // flat ₱15
    ['BAYAD', '2000', '0.00', '2000.00'], // free
  ] as const) {
    test(`${partnerCode} ₱${amount}: fee ₱${fee}, pay ₱${total} at the counter`, async ({ request }) => {
      const alice = await createUser(request);
      const res = await createCode(request, alice, { partnerCode, amount });
      expect(res.status()).toBe(201);
      expect(await res.json()).toMatchObject({ fee, totalToPay: total, status: 'PENDING', partner: { code: partnerCode } });
    });
  }
});

test.describe('OTC cash-in: payment codes', () => {
  test('a 12-digit Luhn code, shown in groups of 4, valid 24 hours, in my list and readable by reference', async ({ request }) => {
    const alice = await createUser(request);
    const before = Date.now();
    const code = await (await createCode(request, alice, { partnerCode: '7eleven', amount: 500 })).json();
    expect(code.reference).toMatch(/^[1-9]\d{11}$/);
    expect(luhnOk(code.reference)).toBe(true);
    expect(code.displayReference).toBe(code.reference.replace(/(\d{4})(?=\d)/g, '$1 '));
    const hours = (new Date(code.expiresAt).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);

    const list = await (await request.get('/api/v1/cash-in/otc', { headers: authHeader(alice.token) })).json();
    expect(list.codes[0]).toMatchObject({ reference: code.reference, status: 'PENDING' });
    const one = await request.get(`/api/v1/cash-in/otc/${code.displayReference.replaceAll(' ', '-')}`, { headers: authHeader(alice.token) });
    expect(await one.json()).toMatchObject({ reference: code.reference });
  });

  test('validation: unknown partner, below ₱100, above ₱50,000, bad amount', async ({ request }) => {
    const alice = await createUser(request);
    for (const [data, status, errorCode] of [
      [{ partnerCode: 'NOPE', amount: 500 }, 400, 'INVALID_PARTNER'],
      [{ partnerCode: 'SM', amount: 99.99 }, 400, 'AMOUNT_OUT_OF_RANGE'],
      [{ partnerCode: 'SM', amount: 50_000.01 }, 400, 'AMOUNT_OUT_OF_RANGE'],
      [{ partnerCode: 'SM', amount: 'abc' }, 400, 'INVALID_AMOUNT'],
    ] as const) {
      const res = await createCode(request, alice, data);
      expect(res.status(), JSON.stringify(data)).toBe(status);
      expect((await res.json()).error.code).toBe(errorCode);
    }
    expect((await createCode(request, alice, { partnerCode: 'SM', amount: 50_000 })).status()).toBe(201);
  });

  test('at most 5 unpaid codes at a time (409), also under parallel requests', async ({ request }) => {
    const alice = await createUser(request);
    const results = await Promise.all(Array.from({ length: 8 }, () => createCode(request, alice, { partnerCode: 'SM', amount: 100 })));
    const statuses = results.map((r) => r.status()).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    const rejected = results.find((r) => r.status() === 409)!;
    expect((await rejected.json()).error.code).toBe('TOO_MANY_PENDING_CODES');
  });

  test("I can't read someone else's code; no token: 401", async ({ request }) => {
    const [alice, bob] = [await createUser(request), await createUser(request)];
    const code = await (await createCode(request, alice, { partnerCode: 'SM', amount: 100 })).json();
    expect((await request.get(`/api/v1/cash-in/otc/${code.reference}`, { headers: authHeader(bob.token) })).status()).toBe(404);
    expect((await request.get('/api/v1/cash-in/otc/partners')).status()).toBe(401);
  });
});

test.describe('OTC cash-in: the counter pays (signed webhook)', () => {
  test('pays amount + fee: wallet +amount once, a DEPOSIT, a cash-in receipt, the fee stays outside the ledger', async ({ request }) => {
    const alice = await createUser(request, 'Alice Tan');
    const code = await (await createCode(request, alice, { partnerCode: 'CEBUANA', amount: 1000 })).json();

    const paid = await counterPays(request, { reference: code.reference, amountPaid: '1010.00', partnerTxnId: 'CL-7731' });
    expect(paid.status()).toBe(200);
    expect(await paid.json()).toMatchObject({ received: true, status: 'PAID', credited: true, duplicate: false, amount: '1000.00' });
    expect(await getBalanceCents(request, alice)).toBe(100_000);

    // the partner retries: no second credit
    const again = await counterPays(request, { reference: code.reference, amountPaid: '1010.00' });
    expect(await again.json()).toMatchObject({ status: 'PAID', credited: false, duplicate: true });
    expect(await getBalanceCents(request, alice)).toBe(100_000);

    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    expect(history.transactions[0]).toMatchObject({ type: 'DEPOSIT', description: `Cash in at Cebuana Lhuillier (${code.displayReference})` });
    const receipt = await (await request.get(`/api/accounts/me/transactions/${history.transactions[0].transactionId}/receipt`, { headers: authHeader(alice.token) })).json();
    expect(receipt).toMatchObject({
      title: 'Cash-in Successful', amount: '1000.00', fee: '0.00', total: '1000.00',
      sender: { name: 'Cebuana Lhuillier (over the counter)', account: code.displayReference },
      otc: { partnerCode: 'CEBUANA', reference: code.reference, counterFee: '10.00' },
    });
    const mine = await (await request.get(`/api/v1/cash-in/otc/${code.reference}`, { headers: authHeader(alice.token) })).json();
    expect(mine).toMatchObject({ status: 'PAID' });
    expect(mine.paidAt).toBeTruthy();
    expect((await checkLedgerIntegrity([alice.accountNumber])).unbalancedTransactions).toEqual([]);
  });

  test('parallel confirmations of one code credit it once', async ({ request }) => {
    const alice = await createUser(request);
    const code = await (await createCode(request, alice, { partnerCode: 'BAYAD', amount: 300 })).json();
    const results = await Promise.all(Array.from({ length: 6 }, () => counterPays(request, { reference: code.reference, amountPaid: 300 })));
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.credited)).toHaveLength(1);
    expect(await getBalanceCents(request, alice)).toBe(30_000);
  });

  test('wrong amount 409, expired 410, unknown 404, bad reference 400, bad signature 401: no money moves', async ({ request }) => {
    const alice = await createUser(request);
    const code = await (await createCode(request, alice, { partnerCode: '7ELEVEN', amount: 500 })).json();

    const short = await counterPays(request, { reference: code.reference, amountPaid: '500.00' }); // forgot the ₱15 fee
    expect(short.status()).toBe(409);
    expect(await short.json()).toMatchObject({ error: { code: 'AMOUNT_MISMATCH', details: { totalToPay: '515.00', amountPaid: '500.00' } } });

    const forged = await counterPays(request, { reference: code.reference, amountPaid: '515.00' }, 'not-the-secret');
    expect(forged.status()).toBe(401);

    const bad = await counterPays(request, { reference: '123456789012', amountPaid: '515.00' }); // fails the Luhn check
    expect((await bad.json()).error.code).toBe('INVALID_REFERENCE');
    const unknownRef = '79927398713'.padStart(11, '0');
    let sum = 0;
    [...unknownRef].reverse().forEach((d, i) => { let n = Number(d); if (i % 2 === 0) n *= 2; sum += n > 9 ? n - 9 : n; });
    const unknown = await counterPays(request, { reference: unknownRef + ((10 - (sum % 10)) % 10), amountPaid: '515.00' });
    expect(unknown.status()).toBe(404);

    expect(await tryStatement(`UPDATE otc_cash_in_codes SET expires_at = now() - interval '1 minute' WHERE reference = $1`, [code.reference])).toBeNull();
    const late = await counterPays(request, { reference: code.reference, amountPaid: '515.00' });
    expect(late.status()).toBe(410);
    expect((await late.json()).error.code).toBe('CODE_EXPIRED');
    const mine = await (await request.get(`/api/v1/cash-in/otc/${code.reference}`, { headers: authHeader(alice.token) })).json();
    expect(mine.status).toBe('EXPIRED');
    expect(await getBalanceCents(request, alice)).toBe(0);
  });

  test('QA sandbox (admin): pay my own code as the counter', async ({ request }) => {
    const admin = await createAdmin(request);
    const code = await (await createCode(request, admin, { partnerCode: 'WATSONS', amount: 250 })).json();
    const before = await getBalanceCents(request, admin);
    const res = await request.post(`/api/qa/otc/${code.reference}/pay`, { headers: authHeader(admin.token) });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'PAID', credited: true });
    expect(await getBalanceCents(request, admin)).toBe(before + 25_000);
  });
});
