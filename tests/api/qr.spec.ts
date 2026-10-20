import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createUser, type TestUser } from '../helpers/api';

const myQr = async (request: APIRequestContext, user: TestUser, amount?: string) =>
  (await request.get(`/api/qr/me${amount ? `?amount=${amount}` : ''}`, { headers: authHeader(user.token) })).json();

const decode = (request: APIRequestContext, user: TestUser, payload: unknown) =>
  request.post('/api/qr/decode', { data: { payload }, headers: authHeader(user.token) });

/** Recompute the CRC-16/CCITT-FALSE of an edited payload (to build "valid but foreign" QR codes). */
function withCrc(bodyWithout63Value: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(bodyWithout63Value, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return bodyWithout63Value + crc.toString(16).toUpperCase().padStart(4, '0');
}

test.describe('Receive via QR (QR Ph)', () => {
  test('returns a QR Ph payload and an SVG for my account', async ({ request }) => {
    const alice = await createUser(request, 'Alice Tan');
    const qr = await myQr(request, alice);

    expect(qr.accountNumber).toBe(alice.accountNumber);
    expect(qr.payload).toMatch(/^000201010211/); // format 01, static QR
    expect(qr.payload).toContain('com.p2pqrpay');
    expect(qr.payload).toContain(alice.accountNumber);
    expect(qr.payload).toContain('5303608'); // currency PHP
    expect(qr.payload).toContain('5802PH');
    expect(qr.payload).toMatch(/6304[0-9A-F]{4}$/);
    expect(qr.svg).toContain('<svg');
  });

  test('a QR for a fixed amount is a dynamic QR with tag 54', async ({ request }) => {
    const alice = await createUser(request);
    const qr = await myQr(request, alice, '250');

    expect(qr.amount).toBe('250.00');
    expect(qr.payload).toMatch(/^000201010212/);
    expect(qr.payload).toContain('5406250.00');
  });
});

test.describe('Scan QR', () => {
  test("decoding someone's QR gives their account, short name and amount", async ({ request }) => {
    const alice = await createUser(request, 'Alice Tan');
    const bob = await createUser(request, 'Bob Cruz');
    const { payload } = await myQr(request, bob, '99.50');

    const response = await decode(request, alice, payload);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      format: 'QR_PH',
      accountNumber: bob.accountNumber,
      receiverName: 'Bob C.',
      amount: '99.50',
      isOwnAccount: false,
    });
  });

  test('a plain account number also works (manual entry)', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);

    const body = await (await decode(request, alice, bob.accountNumber.toLowerCase())).json();

    expect(body).toMatchObject({ format: 'ACCOUNT_NUMBER', accountNumber: bob.accountNumber, amount: null });
  });

  test('your own QR is flagged', async ({ request }) => {
    const alice = await createUser(request);
    const { payload } = await myQr(request, alice);
    expect((await (await decode(request, alice, payload)).json()).isOwnAccount).toBe(true);
  });

  test('an edited or damaged QR fails the checksum', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);
    const { payload } = await myQr(request, bob, '10');
    const tampered = payload.replace('540510.00', '540590.00'); // ₱10 -> ₱90, same length

    const response = await decode(request, alice, tampered);

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('QR_CHECKSUM_MISMATCH');
  });

  test("another bank's QR Ph code is not supported", async ({ request }) => {
    const alice = await createUser(request);
    const { payload } = await myQr(request, alice);
    const foreign = withCrc(payload.slice(0, -4).replace('PAYPPHM2XXX', 'BNORPHMMXXX'));

    const response = await decode(request, alice, foreign);

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('QR_NOT_SUPPORTED');
  });

  for (const payload of ['', 'hello', '0002', 12345]) {
    test(`rejects junk input: ${JSON.stringify(payload)}`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await decode(request, alice, payload);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_QR');
    });
  }

  test('a valid QR for an account that does not exist returns 404', async ({ request }) => {
    const alice = await createUser(request);
    const { payload } = await myQr(request, alice);
    const ghost = withCrc(payload.slice(0, -4).replace(alice.accountNumber, 'PP9999999999'));

    const response = await decode(request, alice, ghost);

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('RECEIVER_NOT_FOUND');
  });
});
