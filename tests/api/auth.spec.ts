import { test, expect } from '@playwright/test';
import { authHeader, createUser, uniqueEmail } from '../helpers/api';

test.describe('User accounts', () => {
  test('registers a new user with an empty wallet', async ({ request }) => {
    const email = uniqueEmail();
    const response = await request.post('/api/auth/register', {
      data: { email, password: 'Sup3rSecret!', fullName: 'Juan Dela Cruz' },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.user.email).toBe(email);
    expect(body.account.accountNumber).toMatch(/^PP\d{10}$/);
    expect(body.user).not.toHaveProperty('password_hash');
  });

  test('rejects a duplicate email', async ({ request }) => {
    const user = await createUser(request);
    const response = await request.post('/api/auth/register', {
      data: { email: user.email, password: 'Another1Pass', fullName: 'Copy Cat' },
    });

    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('EMAIL_TAKEN');
  });

  test('rejects invalid registration data', async ({ request }) => {
    const cases = [
      { data: { email: 'not-an-email', password: 'Sup3rSecret!', fullName: 'A' }, code: 'INVALID_EMAIL' },
      { data: { email: uniqueEmail(), password: 'short', fullName: 'A' }, code: 'INVALID_PASSWORD' },
      { data: { email: uniqueEmail(), password: 'Sup3rSecret!', fullName: '  ' }, code: 'INVALID_NAME' },
    ];

    for (const { data, code } of cases) {
      const response = await request.post('/api/auth/register', { data });
      expect(response.status(), code).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    }
  });

  test('logs in and returns a bearer token', async ({ request }) => {
    const user = await createUser(request);
    const response = await request.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.tokenType).toBe('Bearer');
    expect(body.token.split('.')).toHaveLength(3);
  });

  test('rejects a wrong password', async ({ request }) => {
    const user = await createUser(request);
    const response = await request.post('/api/auth/login', {
      data: { email: user.email, password: 'WrongPassword1' },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('new users start with a zero balance', async ({ request }) => {
    const user = await createUser(request, 'Maria Clara');
    const response = await request.get('/api/accounts/me', { headers: authHeader(user.token) });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      accountNumber: user.accountNumber,
      accountHolder: 'Maria Clara',
      currency: 'PHP',
      balance: '0.00',
      balanceCents: 0,
    });
  });

  test('balance endpoint requires a valid token', async ({ request }) => {
    const noToken = await request.get('/api/accounts/me');
    expect(noToken.status()).toBe(401);

    const badToken = await request.get('/api/accounts/me', { headers: authHeader('not.a.jwt') });
    expect(badToken.status()).toBe(401);
  });
});
