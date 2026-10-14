import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, createUser, uniqueEmail } from '../helpers/api';
import { expirePasswordReset } from '../helpers/db';

const NEW_PASSWORD = 'Brand-New-Pass-123';

function forgot(request: APIRequestContext, email: string) {
  return request.post('/api/auth/password/forgot', { data: { email } });
}

async function requestCode(request: APIRequestContext, email: string) {
  const response = await forgot(request, email);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

function reset(request: APIRequestContext, data: { resetId: unknown; code: unknown; newPassword: unknown }) {
  return request.post('/api/auth/password/reset', { data });
}

function login(request: APIRequestContext, email: string, password: string) {
  return request.post('/api/auth/login', { data: { email, password } });
}

const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

test.describe('Forgot password', () => {
  test('a reset code lets the user set a new password; the old one stops working', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode, expiresInSeconds } = await requestCode(request, user.email);
    expect(demoCode).toMatch(/^\d{6}$/);
    expect(expiresInSeconds).toBe(600);

    const response = await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD });

    expect(response.status(), await response.text()).toBe(200);
    expect((await login(request, user.email, user.password)).status()).toBe(401);
    expect((await login(request, user.email, NEW_PASSWORD)).status()).toBe(200);
  });

  test('the email is matched case-insensitively', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode } = await requestCode(request, user.email.toUpperCase());

    expect((await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD })).status()).toBe(200);
    expect((await login(request, user.email, NEW_PASSWORD)).status()).toBe(200);
  });

  test('changing the password signs out existing sessions', async ({ request }) => {
    const user = await createUser(request);
    expect((await request.get('/api/accounts/me', { headers: authHeader(user.token) })).status()).toBe(200);

    // JWT issue times are whole seconds; make sure the change happens in a later second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { resetId, demoCode } = await requestCode(request, user.email);
    await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD });

    const oldSession = await request.get('/api/accounts/me', { headers: authHeader(user.token) });
    expect(oldSession.status()).toBe(401);
    expect((await oldSession.json()).error.message).toBe('Your password was changed. Please log in again.');

    const { token } = await (await login(request, user.email, NEW_PASSWORD)).json();
    expect((await request.get('/api/accounts/me', { headers: authHeader(token) })).status()).toBe(200);
  });

  test('unknown emails get exactly the same answer (no account probing)', async ({ request }) => {
    const known = await createUser(request);
    const knownBody = await requestCode(request, known.email);
    const unknownBody = await requestCode(request, uniqueEmail('nobody'));

    expect(Object.keys(unknownBody).sort()).toEqual(Object.keys(knownBody).sort());
    expect(unknownBody.message).toBe(knownBody.message);
    expect(unknownBody.expiresInSeconds).toBe(knownBody.expiresInSeconds);

    // Even "completing" the reset looks the same, but no account is created or changed.
    const done = await reset(request, { resetId: unknownBody.resetId, code: unknownBody.demoCode, newPassword: NEW_PASSWORD });
    expect(done.status()).toBe(200);
  });

  test('a wrong code is rejected; 3 wrong codes burn it', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode } = await requestCode(request, user.email);
    const attempt = (code: string) => reset(request, { resetId, code, newPassword: NEW_PASSWORD });

    const first = await attempt(wrongCodeFor(demoCode));
    expect(first.status()).toBe(403);
    expect((await first.json()).error).toEqual({
      code: 'INVALID_RESET_CODE',
      message: 'Invalid or expired code. 2 attempts left.',
    });
    expect((await attempt(wrongCodeFor(demoCode))).status()).toBe(403);
    const third = await attempt(wrongCodeFor(demoCode));
    expect(third.status()).toBe(429);
    expect((await third.json()).error.code).toBe('RESET_ATTEMPTS_EXCEEDED');

    expect((await attempt(demoCode)).status()).toBe(429);
    expect((await login(request, user.email, user.password)).status()).toBe(200);
  });

  test('an expired code is rejected', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode } = await requestCode(request, user.email);
    await expirePasswordReset(resetId);

    const response = await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD });

    expect(response.status()).toBe(410);
    expect((await response.json()).error.code).toBe('RESET_CODE_EXPIRED');
    expect((await login(request, user.email, user.password)).status()).toBe(200);
  });

  test('a code can only be used once', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode } = await requestCode(request, user.email);

    expect((await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD })).status()).toBe(200);
    const replay = await reset(request, { resetId, code: demoCode, newPassword: 'Another-Pass-456' });

    expect(replay.status()).toBe(403);
    expect((await replay.json()).error.code).toBe('INVALID_RESET_CODE');
    expect((await login(request, user.email, NEW_PASSWORD)).status()).toBe(200);
  });

  test('the new password must be at least 8 characters', async ({ request }) => {
    const user = await createUser(request);
    const { resetId, demoCode } = await requestCode(request, user.email);

    const response = await reset(request, { resetId, code: demoCode, newPassword: 'short' });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_PASSWORD');
    // The code was not used up by the invalid request.
    expect((await reset(request, { resetId, code: demoCode, newPassword: NEW_PASSWORD })).status()).toBe(200);
  });

  test('a made-up reset id is rejected', async ({ request }) => {
    const response = await reset(request, { resetId: 'not-a-real-id', code: '123456', newPassword: NEW_PASSWORD });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('INVALID_RESET_CODE');
  });

  test('an empty email is rejected', async ({ request }) => {
    const response = await forgot(request, '');
    expect(response.status()).toBe(400);
  });
});
