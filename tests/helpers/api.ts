import { createHmac, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { makeAdmin } from './db';

export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-webhook-secret';

export interface TestUser {
  email: string;
  password: string;
  fullName: string;
  accountNumber: string;
  token: string;
  /** The random MPIN returned once at registration. */
  mpin: string;
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
  const { account, mpin } = await register.json();

  const login = await request.post('/api/auth/login', { data: { email, password } });
  expect(login.status(), await login.text()).toBe(200);
  const { token } = await login.json();

  return { email, password, fullName: name, accountNumber: account.accountNumber, token, mpin };
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
    // Content-Type set here too: the body is a pre-serialised string (for the signature).
    headers: { 'X-PayPulse-Signature': signature, 'Content-Type': 'application/json' },
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

export interface TransferData {
  toAccountNumber?: unknown;
  toMobileNumber?: unknown;
  amount: unknown;
  description?: string;
  mpin?: unknown;
  otpChallengeId?: unknown;
  otp?: unknown;
}

/** POST /api/transfers. Sends the sender's own MPIN unless the test passes its own `mpin`. */
export function transfer(request: APIRequestContext, from: TestUser, data: TransferData) {
  return request.post('/api/transfers', {
    data: { mpin: from.mpin, ...data },
    headers: authHeader(from.token),
  });
}

/** A well-formed MPIN that is guaranteed to be wrong for this user. */
export function wrongMpinFor(user: TestUser): string {
  return user.mpin === '000000' ? '111111' : '000000';
}

/** A random mobile number in 09XXXXXXXXX format. */
export function uniqueMobile(): string {
  return `09${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

/** Give a user a mobile number so others can Express Send to it. */
export async function setMobile(request: APIRequestContext, user: TestUser, mobileNumber = uniqueMobile()) {
  const response = await request.put('/api/accounts/me/mobile', {
    data: { mobileNumber },
    headers: authHeader(user.token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).mobileNumber as string;
}

export interface BankTransferData {
  bankCode: unknown;
  accountNumber: unknown;
  accountName: unknown;
  amount: unknown;
  /** 'INSTAPAY' (default) or 'PESONET' */
  rail?: unknown;
  description?: string;
  mpin?: unknown;
  otpChallengeId?: unknown;
  otp?: unknown;
}

/** POST /api/transfers/bank. Sends the sender's own MPIN unless the test passes its own `mpin`. */
export function bankTransfer(request: APIRequestContext, from: TestUser, data: BankTransferData) {
  return request.post('/api/transfers/bank', {
    data: { mpin: from.mpin, ...data },
    headers: authHeader(from.token),
  });
}

/** A new ADMIN user (can use Add money, the QA sandbox and chaos headers). */
export async function createAdmin(request: APIRequestContext, name = 'QA Admin'): Promise<TestUser> {
  const user = await createUser(request, name);
  await makeAdmin(user.email);
  return user;
}

/** A new ADMIN user with a funded wallet. */
export async function createFundedAdmin(request: APIRequestContext, amount: number, name?: string): Promise<TestUser> {
  const user = await createFundedUser(request, amount, name);
  await makeAdmin(user.email);
  return user;
}
