/**
 * k6 concurrency test: 10 virtual users send the SAME transfer at the same moment (no Idempotency-Key,
 * so they are 10 separate payments, like a user hammering "Send").
 *
 * The sender starts with ₱100.00 and each transfer is ₱60.00: only ONE fits. With the row lock on the
 * sender's wallet (src/services/walletLock.js) exactly 1 request succeeds (201) and the other 9 are
 * refused with 422 INSUFFICIENT_FUNDS; the sender ends at ₱40.00 and never below zero. The
 * thresholds fail the run on any double spend, overdraft, created money or unexpected answer.
 * (Before the lock this was the intentional race bug: 2 to 10 transfers went through. QA_NOTES.md.)
 *
 * The ledger invariants (debits = credits, cash = balances + fees + reserves, no overdrawn wallet)
 * are checked right after the run:  npm run test:concurrency  (k6 + scripts/assert-ledger.js)
 *
 * Run with Docker:  docker compose run --rm k6
 * Run locally:      k6 run -e BASE_URL=http://localhost:3000 tests/load/concurrency-test.js
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { summaryFor } from './summary.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'dev-webhook-secret';
const PARALLEL_REQUESTS = 10;
const STARTING_BALANCE_CENTS = 10000; // ₱100.00
const TRANSFER_AMOUNT = 60; // ₱60.00: only one fits

const successfulTransfers = new Counter('successful_transfers');
const insufficientFunds = new Counter('insufficient_funds_rejections');
const extraTransfers = new Counter('double_spent_transfers');
const moneyCreatedCents = new Counter('money_created_cents');
const overdrawnCents = new Counter('overdrawn_cents');
const balanceMismatchCents = new Counter('balance_mismatch_cents');

export const options = {
  scenarios: {
    simultaneous_send: {
      executor: 'per-vu-iterations',
      vus: PARALLEL_REQUESTS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Exactly one transfer succeeds, the other nine are refused for insufficient funds.
    successful_transfers: ['count==1'],
    insufficient_funds_rejections: [`count==${PARALLEL_REQUESTS - 1}`],
    // No double spend, no overdraft, no money from nowhere, and the sender ends at exactly ₱40.00.
    double_spent_transfers: ['count==0'],
    overdrawn_cents: ['count==0'],
    money_created_cents: ['count==0'],
    balance_mismatch_cents: ['count==0'],
    // Every request gets a clean answer (201 or 422 INSUFFICIENT_FUNDS), never a 5xx.
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
    JSON.stringify({ toAccountNumber: receiver.accountNumber, amount: TRANSFER_AMOUNT, mpin: sender.mpin }),
    auth(sender.token),
  );

  const refused = res.status === 422 && res.json('error.code') === 'INSUFFICIENT_FUNDS';
  check(res, { 'status is 201 or 422 INSUFFICIENT_FUNDS': (r) => r.status === 201 || refused });
  if (res.status === 201) successfulTransfers.add(1);
  if (refused) insufficientFunds.add(1);
}

// Runs once after all VUs finish: verify the money.
export function teardown({ sender, receiver }) {
  const senderBalance = balanceCents(sender);
  const receiverBalance = balanceCents(receiver);
  const total = senderBalance + receiverBalance;
  const receivedTransfers = receiverBalance / (TRANSFER_AMOUNT * 100);
  const expectedSender = STARTING_BALANCE_CENTS - TRANSFER_AMOUNT * 100;

  console.log(`sender=${senderBalance / 100} (expected ${expectedSender / 100}) receiver=${receiverBalance / 100} total=${total / 100} (expected 100)`);

  extraTransfers.add(Math.max(0, receivedTransfers - 1));
  overdrawnCents.add(Math.max(0, -senderBalance));
  moneyCreatedCents.add(Math.max(0, total - STARTING_BALANCE_CENTS));
  balanceMismatchCents.add(Math.abs(senderBalance - expectedSender));
}

// HTML + JSON report in reports/ (also written when thresholds fail).
export const handleSummary = summaryFor('k6-concurrency', 'Concurrency: 10 identical ₱60 transfers from ₱100 (row lock: exactly 1 succeeds)');
