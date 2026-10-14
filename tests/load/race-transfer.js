/**
 * k6 concurrency test: 10 virtual users send the same transfer at the same moment.
 *
 * Sender starts with 100.00 and each transfer is 30.00, so at most 3 may succeed and the
 * total money of sender + receiver must stay 100.00. The thresholds fail the run when the
 * race-condition bug lets money be created.
 *
 * Run with Docker:  docker compose run --rm k6
 * Run locally:      k6 run -e BASE_URL=http://localhost:3000 tests/load/race-transfer.js
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'dev-webhook-secret';
const PARALLEL_REQUESTS = 10;
const STARTING_BALANCE_CENTS = 10000;
const TRANSFER_AMOUNT = 30;

const successfulTransfers = new Counter('successful_transfers');
const moneyCreatedCents = new Counter('money_created_cents');
const overspentTransfers = new Counter('overspent_transfers');

export const options = {
  scenarios: {
    double_click: {
      executor: 'per-vu-iterations',
      vus: PARALLEL_REQUESTS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Money must never appear from nowhere.
    money_created_cents: ['count==0'],
    // No more transfers may succeed than the balance allows.
    overspent_transfers: ['count==0'],
    // Every request must get a clean answer (201 or 422), never a 5xx.
    checks: ['rate==1'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };
const auth = (token) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });

function createUser(name) {
  const email = `k6.${Date.now()}.${Math.random().toString(36).slice(2)}@paypulse.test`;
  const password = 'Sup3rSecret!';
  const reg = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({ email, password, fullName: name }), json);
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.body}`);
  const login = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email, password }), json);
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.body}`);
  return { accountNumber: reg.json('account.accountNumber'), token: login.json('token') };
}

function fund(accountNumber, amountCents) {
  const body = JSON.stringify({
    paymentId: `k6_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    accountNumber,
    amount: (amountCents / 100).toFixed(2),
    status: 'SUCCESS',
  });
  const signature = crypto.hmac('sha256', WEBHOOK_SECRET, body, 'hex');
  const res = http.post(`${BASE_URL}/api/webhooks/payments`, body, {
    headers: { 'Content-Type': 'application/json', 'X-PayPulse-Signature': signature },
  });
  if (res.status !== 200) throw new Error(`funding failed: ${res.status} ${res.body}`);
}

function balanceCents(user) {
  return http.get(`${BASE_URL}/api/accounts/me`, auth(user.token)).json('balanceCents');
}

// Runs once before the VUs start.
export function setup() {
  const sender = createUser('k6 Sender');
  const receiver = createUser('k6 Receiver');
  fund(sender.accountNumber, STARTING_BALANCE_CENTS);
  return { sender, receiver };
}

// Each of the 10 VUs runs this exactly once, at the same time.
export default function ({ sender, receiver }) {
  const res = http.post(
    `${BASE_URL}/api/transfers`,
    JSON.stringify({ toAccountNumber: receiver.accountNumber, amount: TRANSFER_AMOUNT }),
    auth(sender.token),
  );

  check(res, { 'status is 201 or 422': (r) => r.status === 201 || r.status === 422 });
  if (res.status === 201) successfulTransfers.add(1);
}

// Runs once after all VUs finish: verify money is conserved.
export function teardown({ sender, receiver }) {
  const senderBalance = balanceCents(sender);
  const receiverBalance = balanceCents(receiver);
  const total = senderBalance + receiverBalance;
  const receivedTransfers = receiverBalance / (TRANSFER_AMOUNT * 100);
  const maxAllowed = Math.floor(STARTING_BALANCE_CENTS / (TRANSFER_AMOUNT * 100));

  console.log(`sender=${senderBalance / 100} receiver=${receiverBalance / 100} total=${total / 100} (expected 100)`);

  moneyCreatedCents.add(Math.max(0, total - STARTING_BALANCE_CENTS));
  overspentTransfers.add(Math.max(0, receivedTransfers - maxAllowed));
}
