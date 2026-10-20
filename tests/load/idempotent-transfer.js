/**
 * k6 idempotency test: the SAME transfer (same Idempotency-Key) arrives many times.
 *
 *   scenario "burst":   10 virtual users send it at the same instant (a double-tap / client retry race)
 *   scenario "retries": 20 more sends after the first one finished (a client retrying a lost answer)
 *
 * Exactly ONE transfer may happen. Every other answer must be a replay of the first one
 * (201 + "Idempotent-Replayed: true") or "409 IDEMPOTENCY_IN_PROGRESS" while it is still running.
 * Unlike race-transfer.js (which shows the intentional race bug: no key, separate requests), this
 * proves that clients which DO send an Idempotency-Key can never pay twice.
 *
 * Run with Docker:  docker compose run --rm k6 run /scripts/idempotent-transfer.js
 * Run locally:      k6 run -e BASE_URL=http://localhost:3000 tests/load/idempotent-transfer.js
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { summaryFor } from './summary.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'dev-webhook-secret';
const STARTING_BALANCE_CENTS = 10000;
const TRANSFER_AMOUNT = 30;

const executedTransfers = new Counter('executed_transfers'); // a 201 that is NOT a replay
const replayedResponses = new Counter('replayed_responses');
const inProgressConflicts = new Counter('in_progress_conflicts');
const extraMoneyMovedCents = new Counter('extra_money_moved_cents');

export const options = {
  scenarios: {
    burst: { executor: 'per-vu-iterations', vus: 10, iterations: 1, maxDuration: '30s' },
    retries: { executor: 'shared-iterations', vus: 2, iterations: 20, startTime: '3s', maxDuration: '30s' },
  },
  thresholds: {
    // The whole point: one key, one transfer.
    executed_transfers: ['count==1'],
    extra_money_moved_cents: ['count==0'],
    // Every answer is a clean 201 (first or replay) or 409 (still in progress), never a 5xx.
    checks: ['rate==1'],
  },
};

const json = { headers: { 'Content-Type': 'application/json' } };
const auth = (token, extra = {}) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra } });

function createUser(name) {
  const email = `k6.${Date.now()}.${Math.random().toString(36).slice(2)}@paypulse.test`;
  const password = 'Sup3rSecret!';
  const reg = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({ email, password, fullName: name }), json);
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.body}`);
  const login = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email, password }), json);
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.body}`);
  return { accountNumber: reg.json('account.accountNumber'), token: login.json('token'), mpin: reg.json('mpin') };
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

const balanceCents = (user) => http.get(`${BASE_URL}/api/accounts/me`, auth(user.token)).json('balanceCents');

export function setup() {
  const sender = createUser('k6 Idempotent Sender');
  const receiver = createUser('k6 Idempotent Receiver');
  fund(sender.accountNumber, STARTING_BALANCE_CENTS);
  return { sender, receiver, key: `k6-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

export default function ({ sender, receiver, key }) {
  const res = http.post(
    `${BASE_URL}/api/transfers`,
    JSON.stringify({ toAccountNumber: receiver.accountNumber, amount: TRANSFER_AMOUNT, mpin: sender.mpin }),
    auth(sender.token, { 'Idempotency-Key': key }),
  );
  const replayed = res.headers['Idempotent-Replayed'] === 'true';

  check(res, {
    'status is 201 (first or replay) or 409 (in progress)': (r) => r.status === 201 || r.status === 409,
    'a 409 is IDEMPOTENCY_IN_PROGRESS': (r) => r.status !== 409 || r.json('error.code') === 'IDEMPOTENCY_IN_PROGRESS',
  });
  if (res.status === 201 && !replayed) executedTransfers.add(1);
  if (res.status === 201 && replayed) replayedResponses.add(1);
  if (res.status === 409) inProgressConflicts.add(1);
}

export function teardown({ sender, receiver }) {
  const senderBalance = balanceCents(sender);
  const receiverBalance = balanceCents(receiver);
  console.log(
    `sender=${senderBalance / 100} receiver=${receiverBalance / 100} (expected 70 / 30: one transfer of ${TRANSFER_AMOUNT})`,
  );
  extraMoneyMovedCents.add(Math.max(0, receiverBalance - TRANSFER_AMOUNT * 100));
  extraMoneyMovedCents.add(Math.max(0, STARTING_BALANCE_CENTS - TRANSFER_AMOUNT * 100 - senderBalance));
}

// HTML + JSON report in reports/ (also written when thresholds fail).
export const handleSummary = summaryFor('k6-idempotency', 'Idempotency: one Idempotency-Key, 30 sends, exactly one transfer');
