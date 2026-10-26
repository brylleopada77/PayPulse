#!/usr/bin/env node
// Seed the QA test accounts on a running PayPulse server (QA_SANDBOX=true). Safe to run more than once.
//   qa.admin@paypulse.test  ADMIN, wallet ₱100,000 (QA reset): chaos tools, top-ups
//   qa.alice@paypulse.test  CUSTOMER
//   qa.bob@paypulse.test    CUSTOMER
// The suites still register their own isolated users per test; these fixed accounts are for
// k6 runs, manual exploratory testing and demos against a fresh database.
// Usage: npm run db:seed        Env: BASE_URL (default http://localhost:3000), SEED_PASSWORD
require('dotenv').config({ quiet: true });
const { pool } = require('../src/db/pool');
const roleService = require('../src/services/roleService');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD || 'QaPassw0rd!';
const ACCOUNTS = [
  { email: 'qa.admin@paypulse.test', fullName: 'QA Admin', role: 'ADMIN' },
  { email: 'qa.alice@paypulse.test', fullName: 'Alice Santos', role: 'CUSTOMER' },
  { email: 'qa.bob@paypulse.test', fullName: 'Bob Reyes', role: 'CUSTOMER' },
];

async function post(path, body, token) {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  for (const account of ACCOUNTS) {
    const registered = await post('/api/auth/register', { email: account.email, password: PASSWORD, fullName: account.fullName });
    if (registered.status !== 201 && registered.status !== 409) {
      throw new Error(`register ${account.email}: ${registered.status} ${JSON.stringify(registered.data)}`);
    }
    await roleService.setRole(account.email, account.role);
    const login = await post('/api/auth/login', { email: account.email, password: PASSWORD });
    if (login.status !== 200) throw new Error(`login ${account.email}: ${login.status}`);

    let note = registered.status === 201 ? 'created' : 'already existed';
    if (account.role === 'ADMIN') {
      const reset = await post('/api/qa/reset', {}, login.data.token);
      if (reset.status !== 200) throw new Error(`QA reset ${account.email}: ${reset.status} (is QA_SANDBOX=true?)`);
      note += ', wallet reset to ₱100,000';
    }
    console.log(`${account.email.padEnd(24)} ${account.role.padEnd(8)} ${note}`);
  }
})()
  .catch((err) => {
    console.error('seed-qa failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
