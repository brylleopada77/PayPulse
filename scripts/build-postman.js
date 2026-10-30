#!/usr/bin/env node
// Builds the Postman collection + environments in postman/ from src/docs/openapi.js:
//   postman/PayPulse.postman_collection.json      every documented operation, in a runnable order
//   postman/PayPulse-local.postman_environment.json / PayPulse-live.postman_environment.json
//
// The requests chain: Setup registers / logs in and funds the wallet, and each request saves what the
// next ones need (token, MPIN, transactionId, card token, loan id...) into the environment. A
// collection-level script logs in again when the token is old, fetches a fresh MPIN when a body uses
// {{mpin}}, and spaces money requests out (anti-spam rule: 3 transfers / 10 s), so the whole
// collection runs top to bottom in the Postman Collection Runner or with newman (npm run postman:test).
//
// Usage: node scripts/build-postman.js [--check]   (--check: fail when the committed files are stale)
'use strict';

const fs = require('fs');
const path = require('path');
const spec = require('../src/docs/openapi');

const OUT = path.join(__dirname, '..', 'postman');
const LIVE_URL = 'https://paypulse-4cqi.onrender.com';

/** Script lines from a function body, so the scripts below stay readable (and lintable) JS. */
const code = (fn) => {
  const src = fn.toString();
  const lines = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n').trim().split('\n');
};

/* eslint-disable no-undef -- the functions below run in the Postman sandbox (pm) */

// Runs before every request: log in when needed, fresh MPIN for bodies that use {{mpin}}, pace money moves.
const COLLECTION_PRE_REQUEST = code(() => {
  const env = pm.environment;
  const OUTGOING = /^\/api\/(transfers(\/bank)?|v1\/bills\/pay|v1\/load\/purchase|v1\/cards\/[^/]+\/payments)$/;
  const isPublic = pm.request.auth && pm.request.auth.type === 'noauth';
  const raw = (pm.request.body && pm.request.body.raw) || '';
  const send = (req) => new Promise((resolve, reject) => pm.sendRequest(req, (err, res) => (err ? reject(err) : resolve(res))));
  const post = (p, body) => send({
    url: env.get('baseUrl') + p,
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Authorization', value: `Bearer ${env.get('token')}` }],
    body: { mode: 'raw', raw: JSON.stringify(body) },
  });

  (async () => {
    if (isPublic || !env.get('email')) return;
    if (!env.get('token') || Number(env.get('tokenExpiresAt') || 0) < Date.now()) {
      const res = await post('/api/auth/login', { email: env.get('email'), password: env.get('password') });
      if (res.code !== 200) throw new Error(`Auto-login failed (${res.code}): check email / password in the environment`);
      env.set('token', res.json().token);
      env.set('tokenExpiresAt', String(Date.now() + 55 * 60 * 1000));
    }
    // the MPIN is valid 5 minutes: get a new one (with the password) when it is missing or about to expire
    if (raw.includes('{{mpin}}') && Number(env.get('mpinExpiresAt') || 0) < Date.now() + 30000) {
      const res = await post('/api/accounts/me/mpin/reset', { password: env.get('password') });
      if (res.code !== 200) throw new Error(`MPIN reset failed (${res.code})`);
      env.set('mpin', res.json().mpin);
      env.set('mpinExpiresAt', String(Date.now() + res.json().mpinExpiresInSeconds * 1000));
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // AML velocity rule: more than 5 outgoing payments in 60 s puts the account on hold
    if (OUTGOING.test(pm.request.url.getPath())) {
      const recent = JSON.parse(env.get('outgoingAt') || '[]').filter((t) => t > Date.now() - 61000);
      if (recent.length >= 5) {
        console.log(`AML velocity rule: waiting ${Math.ceil((recent[0] + 61000 - Date.now()) / 1000)} s`);
        await sleep(recent[0] + 61000 - Date.now());
      }
    }
    // anti-spam: at most 3 money moves per 10 seconds
    if (pm.request.headers.has('Idempotency-Key')) {
      const wait = Number(env.get('lastMoneyAt') || 0) + 3500 - Date.now();
      if (wait > 0) await sleep(wait);
      env.set('lastMoneyAt', String(Date.now()));
    }
  })();
});

// Runs after every request: remember outgoing payments (AML pacing); every error has the documented shape.
const COLLECTION_TEST = code(() => {
  const OUTGOING = /^\/api\/(transfers(\/bank)?|v1\/bills\/pay|v1\/load\/purchase|v1\/cards\/[^/]+\/payments)$/;
  if (pm.response.code === 201 && OUTGOING.test(pm.request.url.getPath()) && pm.response.headers.get('Idempotent-Replayed') !== 'true') {
    const recent = JSON.parse(pm.environment.get('outgoingAt') || '[]').filter((t) => t > Date.now() - 61000);
    pm.environment.set('outgoingAt', JSON.stringify([...recent, Date.now()]));
  }

  if (pm.response.code >= 400 && pm.response.code !== 404 && pm.response.headers.get('Content-Type')?.includes('json')) {
    pm.test('Error body: { error: { code, message } }', () => {
      const { error } = pm.response.json();
      pm.expect(error.code).to.be.a('string');
      pm.expect(error.message).to.be.a('string');
    });
  }
});

/* eslint-enable no-undef */

// ---------- request builders ----------

const ADMIN = 'ADMIN'; // expect: 2xx for an ADMIN account, 403 otherwise

/**
 * Test lines: the expected status (a list, or ADMIN), `save` = { envVar: 'path.in.body' } on success,
 * plus extra lines.
 */
function tests({ status, save = {}, extra = [] }) {
  const lines = [];
  if (Array.isArray(status)) {
    lines.push(`pm.test('Status ${status.join(' or ')}', () => pm.expect(pm.response.code).to.be.oneOf([${status.join(', ')}]));`);
  } else if (status && status.admin) {
    lines.push(
      "const isAdmin = pm.environment.get('role') === 'ADMIN';",
      `pm.test(isAdmin ? 'Status ${status.admin} (admin)' : 'Status 403 (admin only)', () => pm.expect(pm.response.code).to.eql(isAdmin ? ${status.admin} : 403));`,
    );
  }
  const entries = Object.entries(save);
  if (entries.length) {
    lines.push('if (pm.response.code < 300) {', '  const body = pm.response.json();');
    for (const [name, expr] of entries) {
      lines.push(`  if (body.${expr.replace(/\./g, '?.')} !== undefined) pm.environment.set('${name}', String(body.${expr.replace(/\./g, '?.')}));`);
    }
    lines.push('}');
  }
  return [...lines, ...extra];
}

let count = 0;
const covered = new Set();

/**
 * One request. `op` is the documented operation ("POST /api/transfers"); `url` the path with
 * {{variables}} (default: op's path). The name, description and auth come from the OpenAPI document.
 */
function req(op, { name, url, query = [], body, headers = [], pre = [], status, save, extra, idempotencyKey, noAuth = false } = {}) {
  const [method, specPath] = op.split(' ');
  const doc = spec.paths[specPath]?.[method.toLowerCase()];
  if (!doc) throw new Error(`Not in the OpenAPI document: ${op}`);
  covered.add(op);
  count += 1;
  const isPublic = noAuth || (Array.isArray(doc.security) && doc.security.length === 0);
  const money = doc.parameters.some((p) => p.$ref === '#/components/parameters/IdempotencyKey');
  const rawPath = (url || specPath);
  const header = [
    ...(body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : []),
    ...(money ? [{ key: 'Idempotency-Key', value: idempotencyKey || '{{$guid}}', description: 'A retry with the same key replays the first answer' }] : []),
    ...headers,
  ];
  return {
    name: name || doc.summary,
    event: [
      ...(pre.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
      { listen: 'test', script: { type: 'text/javascript', exec: tests({ status, save, extra }) } },
    ],
    request: {
      ...(isPublic ? { auth: { type: 'noauth' } } : {}),
      method,
      header,
      ...(body !== undefined ? { body: { mode: 'raw', raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
      url: {
        raw: `{{baseUrl}}${rawPath}${query.length ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`,
        host: ['{{baseUrl}}'],
        path: rawPath.split('/').filter(Boolean),
        ...(query.length ? { query: query.map(([key, value]) => ({ key, value })) } : {}),
      },
      description: [doc.description, method !== 'GET' && money ? '**Moves money.** Sent with a fresh `Idempotency-Key`.' : '']
        .filter(Boolean).join('\n\n') || undefined,
    },
  };
}

const folder = (name, description, item) => ({ name, description, item });
const skipUnless = (condition, why) => [`if (!(${condition})) { console.log('Skipped: ${why}'); pm.execution.skipRequest(); }`];

// ---------- the collection ----------

const MPIN = '{{mpin}}';

const item = [
  folder('0. Setup', 'Run first. Registers a recipient (and you, when the environment has no email), logs in and adds ₱20,000 play money to your wallet.', [
    req('POST /api/auth/register', {
      name: 'Register the recipient (Bob)',
      pre: ["pm.environment.set('recipientEmail', `bob.${Date.now()}@paypulse.test`);"],
      body: { email: '{{recipientEmail}}', password: 'QaPassw0rd!', fullName: 'Bob Recipient' },
      status: [201],
      save: { recipientAccount: 'account.accountNumber' },
    }),
    req('POST /api/auth/register', {
      name: 'Register me (only when the environment has no email)',
      pre: [
        ...skipUnless("!pm.environment.get('email')", 'the environment already has an email: logging in with it'),
        "pm.environment.set('newEmail', `me.${Date.now()}@paypulse.test`);",
      ],
      body: { email: '{{newEmail}}', password: 'QaPassw0rd!', fullName: 'Postman Tester' },
      status: [201],
      extra: [
        'if (pm.response.code === 201) {',
        "  pm.environment.set('email', pm.environment.get('newEmail'));",
        "  pm.environment.set('password', 'QaPassw0rd!');",
        "  pm.environment.set('mpin', pm.response.json().mpin);",
        "  pm.environment.set('mpinExpiresAt', String(Date.now() + pm.response.json().mpinExpiresInSeconds * 1000));",
        '}',
      ],
    }),
    req('POST /api/auth/login', {
      name: 'Log in (saves the token)',
      body: { email: '{{email}}', password: '{{password}}' },
      status: [200],
      save: { token: 'token' },
      extra: [
        "pm.environment.set('tokenExpiresAt', String(Date.now() + 55 * 60 * 1000));",
        "pm.test('JWT returned', () => pm.expect(pm.response.json().token).to.match(/^ey/));",
      ],
    }),
    req('GET /api/accounts/me', {
      name: 'My account (saves accountNumber and role)',
      status: [200],
      save: { accountNumber: 'accountNumber', role: 'role' },
    }),
    req('POST /api/webhooks/payments', {
      name: 'Fund my wallet: signed payment webhook (needs webhookSecret)',
      pre: [
        ...skipUnless("pm.environment.get('webhookSecret')", 'no webhookSecret in the environment'),
        "const body = JSON.stringify({ paymentId: `postman-${Date.now()}`, accountNumber: pm.environment.get('accountNumber'), amount: 20000, status: 'SUCCESS' });",
        'pm.request.body.raw = body;',
        "pm.request.headers.upsert({ key: 'X-PayPulse-Signature', value: require('crypto-js').HmacSHA256(body, pm.environment.get('webhookSecret')).toString() });",
      ],
      body: '{ "set by the pre-request script": true }',
      status: [200],
      extra: ["pm.test('Credited', () => pm.expect(pm.response.json().received).to.eql(true));"],
    }),
    req('POST /api/payments/mock-checkout', {
      name: 'Fund my wallet: Add money (ADMIN accounts)',
      pre: skipUnless("pm.environment.get('role') === 'ADMIN' && !pm.environment.get('webhookSecret')", 'not an ADMIN account (or the webhook already funded the wallet)'),
      body: { amount: 20000, outcome: 'approve' },
      status: [201],
    }),
  ]),

  folder('1. System', '', [
    req('GET /health', { status: [200], extra: ["pm.test('Database up', () => pm.expect(pm.response.json().database).to.eql('up'));"] }),
    req('GET /api/config', { status: [200] }),
  ]),

  folder('2. Accounts', '', [
    req('GET /api/accounts/me', {
      status: [200],
      save: { balanceBefore: 'balanceCents' },
      extra: ["pm.test('Balance is a peso string', () => pm.expect(pm.response.json().balance).to.match(/^\\d+\\.\\d{2}$/));"],
    }),
    req('GET /api/accounts/me/compliance', { status: [200] }),
    req('PUT /api/accounts/me/mobile', {
      pre: ["pm.environment.set('mobileNumber', '0917' + String(Date.now()).slice(-7));"],
      body: { mobileNumber: '{{mobileNumber}}' },
      status: [200, 409],
    }),
    req('POST /api/accounts/me/mpin/reset', {
      body: { password: '{{password}}' },
      status: [200],
      save: { mpin: 'mpin' },
      extra: ["if (pm.response.code === 200) pm.environment.set('mpinExpiresAt', String(Date.now() + pm.response.json().mpinExpiresInSeconds * 1000));"],
    }),
    req('POST /api/accounts/me/mpin/change', {
      pre: [
        '// a random 6-digit MPIN the server accepts: no repeated neighbours, not a straight run, not the current one',
        'let next;',
        'do {',
        "  next = '';",
        '  while (next.length < 6) {',
        '    const d = String(Math.floor(Math.random() * 10));',
        '    if (d !== next.slice(-1)) next += d;',
        '  }',
        '} while ([1, -1].some((s) => [...next].slice(1).every((d, i) => d - next[i] === s)) || next === pm.environment.get(\'mpin\'));',
        "pm.environment.set('newMpin', next);",
      ],
      body: { currentMpin: MPIN, newMpin: '{{newMpin}}', confirmMpin: '{{newMpin}}' },
      status: [200],
      extra: [
        'if (pm.response.code === 200) {',
        "  pm.environment.set('mpin', pm.environment.get('newMpin'));",
        "  pm.environment.set('mpinExpiresAt', String(Date.now() + pm.response.json().mpinExpiresInSeconds * 1000));",
        '}',
      ],
    }),
  ]),

  folder('3. Transfers', 'Express Send (PayPulse to PayPulse), OTP for amounts above ₱1,000, idempotent retries, Bank Transfer (InstaPay / PESONet).', [
    req('GET /api/transfers/limits', { status: [200] }),
    req('POST /api/transfers', {
      name: 'Express Send ₱250 (saves transactionId)',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 250, description: 'Lunch', mpin: MPIN },
      status: [201],
      save: { transactionId: 'transactionId' },
      extra: ["pm.test('Reference REF-YYYYMMDD-NNNN', () => pm.expect(pm.response.json().reference).to.match(/^REF-\\d{8}-\\d+$/));"],
    }),
    req('POST /api/transfers', {
      name: 'Express Send ₱1,500: answers 202 with an OTP challenge',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 1500, description: 'Rent share', mpin: MPIN },
      status: [202],
      save: { otpChallengeId: 'challengeId', otp: 'demoCode' },
      extra: ["pm.test('OTP required', () => pm.expect(pm.response.json().otpRequired).to.eql(true));"],
    }),
    req('POST /api/transfers', {
      name: 'Express Send ₱1,500: confirm with the OTP',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 1500, description: 'Rent share', mpin: MPIN, otpChallengeId: '{{otpChallengeId}}', otp: '{{otp}}' },
      status: [201],
    }),
    req('POST /api/transfers', {
      name: 'Idempotency: send ₱100 with a fixed key',
      pre: ["pm.environment.set('idemKey', pm.variables.replaceIn('{{$guid}}'));"],
      idempotencyKey: '{{idemKey}}',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 100, description: 'Idempotency check', mpin: MPIN },
      status: [201],
      save: { idemTransactionId: 'transactionId' },
    }),
    req('POST /api/transfers', {
      name: 'Idempotency: retry with the same key (replayed, no second debit)',
      idempotencyKey: '{{idemKey}}',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 100, description: 'Idempotency check', mpin: MPIN },
      status: [201],
      extra: [
        "pm.test('Idempotent-Replayed: true', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true'));",
        "pm.test('Same transaction as the first call', () => pm.expect(String(pm.response.json().transactionId)).to.eql(pm.environment.get('idemTransactionId')));",
      ],
    }),
    req('GET /api/transfers/banks', { status: [200] }),
    req('POST /api/transfers/bank', {
      name: 'Bank Transfer ₱500 via InstaPay (saves bankTransactionId)',
      body: { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz', amount: 500, rail: 'INSTAPAY', description: 'Rent', mpin: MPIN },
      status: [201],
      save: { bankTransactionId: 'transactionId' },
    }),
    req('POST /api/transfers/bank', {
      name: 'Bank Transfer ₱300 via PESONet (queued until the cut-off)',
      body: { bankCode: 'BPI', accountNumber: '9876543210', accountName: 'Maria Santos', amount: 300, rail: 'PESONET', mpin: MPIN },
      status: [201],
    }),
    req('GET /api/transfers/pesonet', { status: [200] }),
    req('GET /api/transfers/bank/{transactionId}/iso20022', {
      url: '/api/transfers/bank/{{bankTransactionId}}/iso20022',
      status: [200],
      extra: ["pm.test('pacs.008', () => pm.expect(JSON.stringify(pm.response.json())).to.include('pacs.008'));"],
    }),
  ]),

  folder('4. History, receipts and ISO 20022', '', [
    req('GET /api/accounts/me/transactions', {
      query: [['limit', '5']],
      status: [200],
      extra: ["pm.test('At most 5 rows', () => pm.expect(pm.response.json().transactions.length).to.be.at.most(5));"],
    }),
    req('GET /api/accounts/me/transactions/{id}/receipt', { url: '/api/accounts/me/transactions/{{transactionId}}/receipt', status: [200] }),
    req('GET /api/v1/transactions/{id}/iso20022', {
      name: 'ISO 20022 pacs.008 of the Express Send (JSON)',
      url: '/api/v1/transactions/{{transactionId}}/iso20022',
      status: [200],
      extra: [
        "pm.test('pacs.008.001.08', () => pm.expect(pm.response.json().messageType).to.eql('pacs.008.001.08'));",
        "pm.test('XML included', () => pm.expect(pm.response.json().xml).to.include('<Document'));",
      ],
    }),
  ]),

  folder('5. Bills', '', [
    req('GET /api/v1/bills', { status: [200] }),
    req('POST /api/v1/bills/pay', {
      body: { billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount: 500, mpin: MPIN },
      status: [201],
      save: { billTransactionId: 'transactionId' },
    }),
  ]),

  folder('6. Load', '', [
    req('GET /api/v1/load', { status: [200] }),
    req('GET /api/v1/load/detect', {
      query: [['mobile', '09171234567']],
      status: [200],
      extra: ["pm.test('Globe', () => pm.expect(JSON.stringify(pm.response.json())).to.include('GLOBE'));"],
    }),
    req('POST /api/v1/load/purchase', {
      name: 'Buy load: Globe ₱100 regular',
      body: { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'REGULAR', amount: 100, mpin: MPIN },
      status: [201],
      save: { loadTransactionId: 'transactionId' },
    }),
  ]),

  folder('7. Savings', 'PayPulse Save vault (6.00% p.a.).', [
    req('GET /api/v1/savings', { status: [200] }),
    req('POST /api/v1/savings/deposit', { body: { amount: 1000 }, status: [201] }),
    req('POST /api/v1/savings/withdraw', { body: { amount: 200 }, status: [201] }),
  ]),

  folder('8. Loans', 'One open loan at a time: on a second run "Apply" answers 409 and the open loan is used.', [
    req('POST /api/v1/loans/quote', { body: { amount: 5000, termMonths: 3 }, status: [200] }),
    req('POST /api/v1/loans', { body: { amount: 5000, termMonths: 3, mpin: MPIN }, status: [201, 409] }),
    req('GET /api/v1/loans', {
      status: [200],
      extra: [
        'const loan = pm.response.json().activeLoan || pm.response.json().loan || pm.response.json().openLoan;',
        "if (loan) pm.environment.set('loanId', String(loan.id ?? loan.loanId));",
        "pm.test('An open loan', () => pm.expect(loan).to.be.an('object'));",
      ],
    }),
    req('POST /api/v1/loans/{id}/repay', { url: '/api/v1/loans/{{loanId}}/repay', body: { amount: 500, mpin: MPIN }, status: [201] }),
  ]),

  folder('9. Cards', 'Virtual Visa: issue, view, reveal, pay, lock (payment refused), unlock.', [
    req('POST /api/v1/cards/generate', { body: { mpin: MPIN }, status: [201, 409], save: { cardToken: 'token' } }),
    req('GET /api/v1/cards', {
      status: [200],
      extra: [
        'const cards = pm.response.json().cards;',
        "if (!pm.environment.get('cardToken') && cards.length) pm.environment.set('cardToken', cards[0].token);",
        "pm.test('PAN masked', () => cards.forEach((c) => pm.expect(JSON.stringify(c)).not.to.match(/\\d{16}/)));",
      ],
    }),
    req('GET /api/v1/cards/{token}', { url: '/api/v1/cards/{{cardToken}}', status: [200] }),
    req('POST /api/v1/cards/{token}/reveal', { url: '/api/v1/cards/{{cardToken}}/reveal', body: { mpin: MPIN }, status: [200] }),
    req('POST /api/v1/cards/{token}/payments', {
      name: 'Online purchase ₱150',
      url: '/api/v1/cards/{{cardToken}}/payments',
      body: { amount: 150, merchant: 'Lazada', mpin: MPIN },
      status: [201],
    }),
    req('PATCH /api/v1/cards/{token}', { name: 'Lock the card (FROZEN)', url: '/api/v1/cards/{{cardToken}}', body: { status: 'FROZEN' }, status: [200] }),
    req('POST /api/v1/cards/{token}/payments', {
      name: 'Purchase with a locked card: 403 CARD_FROZEN',
      url: '/api/v1/cards/{{cardToken}}/payments',
      body: { amount: 150, merchant: 'Lazada', mpin: MPIN },
      status: [403],
      extra: ["pm.test('CARD_FROZEN', () => pm.expect(pm.response.json().error.code).to.eql('CARD_FROZEN'));"],
    }),
    req('PATCH /api/v1/cards/{token}', { name: 'Unlock the card (ACTIVE, needs the MPIN)', url: '/api/v1/cards/{{cardToken}}', body: { status: 'ACTIVE', mpin: MPIN }, status: [200] }),
  ]),

  folder('10. QR', '', [
    req('GET /api/qr/me', { query: [['amount', '150']], status: [200] }),
    req('POST /api/qr/decode', {
      name: 'Decode the recipient\'s account number',
      body: { payload: '{{recipientAccount}}' },
      status: [200],
      extra: ["pm.test('Recipient found', () => pm.expect(pm.response.json().accountNumber).to.eql(pm.environment.get('recipientAccount')));"],
    }),
  ]),

  folder('11. Profile', '', [
    req('GET /api/v1/profile', { status: [200] }),
    req('POST /api/v1/profile/kyc', {
      name: 'Upgrade to KYC Level 2 (409 when already verified)',
      body: { idType: 'PHILSYS', idNumber: 'PSN1234567890', birthDate: '1995-06-15', selfieConfirmed: true },
      status: [200, 409],
    }),
    req('POST /api/v1/profile/linked-accounts', {
      body: { kind: 'BANK', bankCode: 'BDO', accountNumber: '001234567890', holderName: 'Postman Tester', mpin: MPIN },
      status: [201],
      save: { linkedAccountId: 'id' },
    }),
    req('DELETE /api/v1/profile/linked-accounts/{id}', { url: '/api/v1/profile/linked-accounts/{{linkedAccountId}}', status: [204] }),
    req('PATCH /api/v1/profile/security', { body: { smsTwoFactor: false, biometricLogin: true, mpin: MPIN }, status: [200] }),
    req('POST /api/v1/profile/support/tickets', {
      body: { category: 'TRANSFER', subject: 'Postman test ticket', message: 'Opened from the Postman collection.' },
      status: [201],
    }),
  ]),

  folder('12. Notifications', '', [
    req('GET /api/v1/notifications', { status: [200] }),
    req('POST /api/v1/notifications/read', {
      body: { all: true },
      status: [200],
      extra: ["pm.test('Nothing unread', () => pm.expect(pm.response.json().unreadCount).to.eql(0));"],
    }),
  ]),

  folder('13. Cash-in (over the counter)', 'A 12-digit code to pay in cash at a partner (7-Eleven, Cebuana, SM, Mercury Drug...). With webhookSecret set, the partner webhook pays it and the wallet is credited.', [
    req('GET /api/v1/cash-in/otc/partners', {
      status: [200],
      extra: ["pm.test('19 partners', () => pm.expect(pm.response.json().partners).to.have.lengthOf(19));"],
    }),
    req('POST /api/v1/cash-in/otc', {
      name: 'Generate a code: Cebuana Lhuillier ₱1,000 (1% fee: pay ₱1,010)',
      pre: ["pm.environment.unset('otcPaid');"],
      body: { partnerCode: 'CEBUANA', amount: 1000 },
      status: [201, 409],
      save: { otcReference: 'reference', otcTotal: 'totalToPay' },
      extra: ["if (pm.response.code === 201) pm.test('12-digit code, ₱1,010 to pay', () => { pm.expect(pm.response.json().reference).to.match(/^\\d{12}$/); pm.expect(pm.response.json().totalToPay).to.eql('1010.00'); });"],
    }),
    req('GET /api/v1/cash-in/otc', { status: [200] }),
    req('GET /api/v1/cash-in/otc/{reference}', {
      url: '/api/v1/cash-in/otc/{{otcReference}}',
      pre: skipUnless("pm.environment.get('otcReference')", 'no cash-in code yet'),
      status: [200],
    }),
    req('POST /api/webhooks/otc', {
      name: 'The counter pays it: signed partner webhook (needs webhookSecret)',
      noAuth: true,
      pre: [
        ...skipUnless("pm.environment.get('webhookSecret') && pm.environment.get('otcReference')", 'no webhookSecret (or no code) in the environment'),
        "const body = JSON.stringify({ reference: pm.environment.get('otcReference'), amountPaid: pm.environment.get('otcTotal'), partnerTxnId: 'postman-' + Date.now() });",
        'pm.request.body.raw = body;',
        "pm.request.headers.upsert({ key: 'X-PayPulse-Signature', value: require('crypto-js').HmacSHA256(body, pm.environment.get('webhookSecret')).toString() });",
      ],
      body: '{ "set by the pre-request script": true }',
      status: [200],
      extra: ["pm.test('Paid', () => pm.expect(pm.response.json().status).to.eql('PAID'));", "pm.environment.set('otcPaid', 'true');"],
    }),
  ]),

  folder('14. Top-ups (ADMIN)', 'Adding money is admin-only: a customer account gets 403.', [
    req('GET /api/payments/limits', { status: { admin: 200 } }),
  ]),

  folder('15. QA Sandbox (ADMIN)', 'QA_SANDBOX servers only; admin-only (a customer gets 403). "Reset" is last: it sets your wallet to ₱100,000 and hides your history.', [
    req('GET /api/qa/state', { status: { admin: 200 } }),
    req('PUT /api/qa/settings', { name: 'Turn every QA switch off', body: { slowNetwork: false, failNextTransaction: false, frozen: false }, status: { admin: 200 } }),
    req('POST /api/qa/pesonet/run-cutoff', { status: { admin: 200 } }),
    req('POST /api/qa/otc/{reference}/pay', {
      name: 'Act as the counter: pay my cash-in code',
      url: '/api/qa/otc/{{otcReference}}/pay',
      pre: skipUnless("pm.environment.get('otcReference') && !pm.environment.get('otcPaid')", 'no unpaid cash-in code (folder 13)'),
      status: { admin: 200 },
    }),
    req('POST /api/qa/compliance/clear', { status: { admin: 200 } }),
    req('POST /api/qa/savings/accrue', { body: { days: 1 }, status: { admin: 200 } }),
    req('POST /api/qa/reset', {
      name: 'Reset my QA account (skipped unless runQaReset = true)',
      pre: skipUnless("pm.environment.get('runQaReset') === 'true'", 'set runQaReset = true in the environment to run it'),
      status: { admin: 200 },
    }),
  ]),

  folder('16. Negative cases', 'Requests that must be refused. Nothing is moved.', [
    req('GET /api/accounts/me', {
      name: 'No token: 401',
      noAuth: true,
      status: [401],
    }),
    req('POST /api/transfers', {
      name: 'Negative amount: 400 INVALID_AMOUNT',
      body: { toAccountNumber: '{{recipientAccount}}', amount: -5, mpin: MPIN },
      status: [400],
      extra: ["pm.test('INVALID_AMOUNT', () => pm.expect(pm.response.json().error.code).to.eql('INVALID_AMOUNT'));"],
    }),
    req('POST /api/transfers', {
      name: 'Unknown recipient: 404',
      body: { toAccountNumber: 'PP9999999999', amount: 10, mpin: MPIN },
      status: [404],
    }),
    req('POST /api/transfers', {
      name: 'Wrong MPIN: refused',
      body: { toAccountNumber: '{{recipientAccount}}', amount: 10, mpin: '000000' },
      status: [400, 401, 403],
    }),
    req('POST /api/transfers', {
      name: 'Wrong OTP: refused',
      pre: ["pm.environment.set('badOtpChallenge', pm.variables.replaceIn('{{$guid}}'));"],
      body: { toAccountNumber: '{{recipientAccount}}', amount: 1500, mpin: MPIN, otpChallengeId: '{{badOtpChallenge}}', otp: '000000' },
      status: [403],
    }),
    req('GET /api/v1/transactions/{id}/iso20022', { name: 'ISO 20022 of a transaction that is not mine: 404', url: '/api/v1/transactions/999999999/iso20022', status: [404] }),
  ]),

  folder('17. Auth (password reset)', 'Run last: sets the same password again, so the environment keeps working.', [
    req('POST /api/auth/password/forgot', {
      body: { email: '{{email}}' },
      status: [200],
      save: { resetId: 'resetId', resetCode: 'demoCode' },
    }),
    req('POST /api/auth/password/reset', {
      body: { resetId: '{{resetId}}', code: '{{resetCode}}', newPassword: '{{password}}' },
      status: [200],
    }),
  ]),
];

const collection = {
  info: {
    name: 'PayPulse API',
    description: [
      'Every PayPulse REST endpoint (generated from `src/docs/openapi.js` by `npm run postman:build`). Interactive docs: /api-docs.',
      '',
      '**Start:** pick the **PayPulse (live)** or **PayPulse (local)** environment, then run the collection (Runner) or start with the **0. Setup** folder.',
      '',
      '- Empty `email`: Setup registers a new customer for you. Fill in your own `email` / `password` (an ADMIN account on the live server) to use that account.',
      '- Requests save what the next ones need (`token`, `mpin`, `transactionId`, `cardToken`, `loanId`...).',
      '- A collection script logs in again when needed, gets a fresh MPIN (valid 5 minutes) and spaces money requests 3.5 s apart (anti-spam: 3 per 10 s).',
      '- Play money only.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: COLLECTION_PRE_REQUEST } },
    { listen: 'test', script: { type: 'text/javascript', exec: COLLECTION_TEST } },
  ],
  item,
};

// every documented operation is in the collection
const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
const missing = documented.filter((op) => !covered.has(op));
if (missing.length) {
  console.error(`Operations missing from the Postman collection:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const variable = (key, value, type = 'default') => ({ key, value, type, enabled: true });
const environment = (name, baseUrl, extra = []) => ({
  name,
  values: [
    variable('baseUrl', baseUrl),
    variable('email', ''),
    variable('password', '', 'secret'),
    ...extra,
    variable('runQaReset', 'false'),
  ],
  _postman_variable_scope: 'environment',
});

const files = {
  'PayPulse.postman_collection.json': collection,
  'PayPulse-live.postman_environment.json': environment('PayPulse (live)', LIVE_URL),
  // the local .env.example webhook secret: Setup funds a new customer through the signed webhook
  'PayPulse-local.postman_environment.json': environment('PayPulse (local)', 'http://localhost:3000', [variable('webhookSecret', 'dev-webhook-secret', 'secret')]),
};

const check = process.argv.includes('--check');
fs.mkdirSync(OUT, { recursive: true });
let stale = false;
for (const [file, content] of Object.entries(files)) {
  const target = path.join(OUT, file);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== text) {
      console.error(`Stale: postman/${file} (run npm run postman:build)`);
      stale = true;
    }
  } else {
    fs.writeFileSync(target, text);
  }
}
if (stale) process.exit(1);
console.log(`${check ? 'Up to date' : 'Wrote'}: postman/ (${count} requests covering ${covered.size}/${documented.length} operations)`);
