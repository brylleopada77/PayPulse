import { test, expect, type APIRequestContext } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import { authHeader, createFundedUser, createUser, transfer, type TestUser } from '../helpers/api';

// Real-time notifications: Socket.IO, authenticated with the API's JWT, one room per user.
// Events are pushed from PostgreSQL LISTEN/NOTIFY, i.e. only after the money movement committed.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
type LiveEvent = { transactionId: number; type: string; direction: string; amount: string; kind: string; message: string; balance: string; unreadCount: number };

const sockets: Socket[] = [];
test.afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));

/** A connected socket for this user, plus every event it receives. */
async function live(user: TestUser) {
  const socket = io(BASE_URL, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  const events: LiveEvent[] = [];
  socket.on('transaction', (e: LiveEvent) => events.push(e));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, events };
}
const waitFor = async (events: LiveEvent[], match: (e: LiveEvent) => boolean) => {
  await expect.poll(() => events.find(match), { timeout: 5000 }).toBeTruthy();
  return events.find(match)!;
};
const payBill = (request: APIRequestContext, user: TestUser, amount: number) =>
  request.post('/api/v1/bills/pay', {
    data: { billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount, mpin: user.mpin },
    headers: authHeader(user.token),
  });

test.describe('Real-time notifications (Socket.IO)', () => {
  test('a connection without a valid token is refused', async () => {
    for (const token of [undefined, 'not-a-jwt']) {
      const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
      expect(error.message).toBe('UNAUTHORIZED');
    }
  });

  test('the receiver gets "Received ₱500.00 from Account …" with the new balance and unread count', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const bob = await createUser(request);
    const bobLive = await live(bob);

    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 500 });

    const event = await waitFor(bobLive.events, (e) => e.type === 'TRANSFER');
    expect(event).toMatchObject({
      direction: 'CREDIT',
      kind: 'money-in',
      amount: '500.00',
      message: `Received ₱500.00 from Account ${alice.accountNumber}`,
      balance: '500.00',
    });
    expect(event.unreadCount).toBeGreaterThan(0);
  });

  test('events only reach their owner (no one else is told)', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const bob = await createUser(request);
    const carol = await createUser(request);
    const bobLive = await live(bob);
    const carolLive = await live(carol);

    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 25 });
    await waitFor(bobLive.events, (e) => e.type === 'TRANSFER');
    await new Promise((r) => setTimeout(r, 500));
    expect(carolLive.events).toEqual([]);
  });

  test('paying a bill: the payment and a "🎉 Earned ₱5.00 Cashback!" event', async ({ request }) => {
    const alice = await createFundedUser(request, 2000);
    const aliceLive = await live(alice);
    expect((await payBill(request, alice, 1000)).status()).toBe(201);

    const bill = await waitFor(aliceLive.events, (e) => e.type === 'BILL_PAYMENT');
    expect(bill).toMatchObject({ direction: 'DEBIT', kind: 'money-out', message: 'Bill Payment - Meralco: ₱1,000.00' });
    const cashback = await waitFor(aliceLive.events, (e) => e.type === 'CASHBACK');
    expect(cashback).toMatchObject({ direction: 'CREDIT', kind: 'cashback', message: '🎉 Earned ₱5.00 Cashback!', balance: '1005.00' });
  });

  test('a refused payment sends nothing (only committed money movements are announced)', async ({ request }) => {
    const alice = await createFundedUser(request, 10);
    const bob = await createUser(request);
    const bobLive = await live(bob);
    const aliceLive = await live(alice);

    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 11 })).status()).toBe(422);
    await new Promise((r) => setTimeout(r, 800));
    expect(bobLive.events).toEqual([]);
    expect(aliceLive.events).toEqual([]);
  });
});
