import { createHmac, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';

export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-webhook-secret';

export interface TestUser {
  email: string;
  password: string;
  fullName: string;
  accountNumber: string;
  token: string;
}

export function uniqueEmail(prefix = 'qa'): string {
  return `${prefix}.${randomUUID()}@paypulse.test`;
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Register a brand-new user, log in, and return their details. */
export async function createUser(request: APIRequestContext, name = 'QA User'): Promise<TestUser> {
  const email = uniqueEmail();
  const password = 'Sup3rSecret!';

  const register = await request.post('/api/auth/register', {
    data: { email, password, fullName: name },
  });
  expect(register.status(), await register.text()).toBe(201);
  const { account } = await register.json();

  const login = await request.post('/api/auth/login', { data: { email, password } });
  expect(login.status(), await login.text()).toBe(200);
  const { token } = await login.json();

  return { email, password, fullName: name, accountNumber: account.accountNumber, token };
}

/** Send a correctly signed payment webhook. Returns the raw response. */
export async function sendPaymentWebhook(
  request: APIRequestContext,
  payload: { paymentId?: string; accountNumber: string; amount: number | string; status: string },
  secret = WEBHOOK_SECRET,
) {
  const body = JSON.stringify({ ...payload, paymentId: payload.paymentId ?? `pay_${randomUUID()}` });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return request.post('/api/webhooks/payments', {
    data: body,
    headers: { 'X-PayPulse-Signature': signature },
  });
}

/** Top up a wallet through the payment webhook (the only way money enters the system). */
export async function fundAccount(request: APIRequestContext, accountNumber: string, amount: number) {
  const response = await sendPaymentWebhook(request, { accountNumber, amount, status: 'SUCCESS' });
  expect(response.status(), await response.text()).toBe(200);
}

export async function createFundedUser(request: APIRequestContext, amount: number, name?: string) {
  const user = await createUser(request, name);
  await fundAccount(request, user.accountNumber, amount);
  return user;
}

/** Current balance in cents for the given user. */
export async function getBalanceCents(request: APIRequestContext, user: TestUser): Promise<number> {
  const response = await request.get('/api/accounts/me', { headers: authHeader(user.token) });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).balanceCents;
}

export function transfer(
  request: APIRequestContext,
  from: TestUser,
  data: { toAccountNumber: unknown; amount: unknown; description?: string },
) {
  return request.post('/api/transfers', { data, headers: authHeader(from.token) });
}
