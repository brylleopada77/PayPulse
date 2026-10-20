import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createFundedUser, createUser, transfer, type TestUser } from '../helpers/api';

// Notifications: announcements (updates, features, upcoming events) for everyone, personal
// activity (money received, cashback, loan due), and read state stored per user.

type Notification = { id: string; category: string; title: string; read: boolean; action: { target: string } | null };
const list = async (request: APIRequestContext, user: TestUser) =>
  (await request.get('/api/v1/notifications', { headers: authHeader(user.token) })).json();
const markRead = (request: APIRequestContext, user: TestUser, data: Record<string, unknown>) =>
  request.post('/api/v1/notifications/read', { data, headers: authHeader(user.token) });

test.describe('Notifications', () => {
  test('a new customer sees unread updates, features and upcoming events', async ({ request }) => {
    const alice = await createUser(request);
    const body = await list(request, alice);
    const categories = new Set(body.items.map((n: Notification) => n.category));

    expect(categories).toEqual(new Set(['UPDATE', 'FEATURE', 'EVENT']));
    expect(body.items.every((n: Notification) => n.read === false)).toBe(true);
    expect(body.unreadCount).toBe(body.items.length);
    expect(body.items.map((n: Notification) => n.title)).toContain('Pay Bills is here');
    const event = body.items.find((n: Notification & { eventDate: string }) => n.category === 'EVENT');
    expect(event.eventDate).toBeTruthy();
    // Newest first
    const dates = body.items.map((n: { date: string }) => new Date(n.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  test('money received shows up as Activity with a receipt link', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const bob = await createUser(request, 'Bob Cruz');
    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 25 });

    const body = await list(request, bob);
    const activity = body.items.filter((n: Notification) => n.category === 'ACTIVITY');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ title: 'You received ₱25.00', read: false, action: { target: 'receipt' } });
    expect(body.unreadByCategory.ACTIVITY).toBe(1);
  });

  test('read state: one item, then all; it is per user', async ({ request }) => {
    const alice = await createUser(request);
    const bob = await createUser(request);
    const before = await list(request, alice);
    const first = before.items[0].id;

    const one = await markRead(request, alice, { ids: [first] });
    expect(one.status()).toBe(200);
    expect((await one.json()).unreadCount).toBe(before.unreadCount - 1);
    expect((await list(request, alice)).items.find((n: Notification) => n.id === first).read).toBe(true);
    expect((await list(request, bob)).items.find((n: Notification) => n.id === first).read).toBe(false);

    const all = await markRead(request, alice, { all: true });
    expect(await all.json()).toMatchObject({ unreadCount: 0 });
    expect((await list(request, alice)).items.every((n: Notification) => n.read)).toBe(true);
  });

  test('marking read twice is harmless', async ({ request }) => {
    const alice = await createUser(request);
    const { items } = await list(request, alice);
    await markRead(request, alice, { ids: [items[0].id] });
    expect((await markRead(request, alice, { ids: [items[0].id] })).status()).toBe(200);
  });

  for (const [label, data] of [
    ['an empty body', {}],
    ['an empty list', { ids: [] }],
    ['non-string ids', { ids: [1, 2] }],
  ] as const) {
    test(`rejects ${label} (400 INVALID_NOTIFICATIONS)`, async ({ request }) => {
      const alice = await createUser(request);
      const response = await markRead(request, alice, data);
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_NOTIFICATIONS');
    });
  }

  test('needs a login', async ({ request }) => {
    expect((await request.get('/api/v1/notifications')).status()).toBe(401);
  });
});
