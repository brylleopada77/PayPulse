// OpenAPI 3.0 description of the PayPulse REST API, served as interactive Swagger UI at /api-docs
// (raw document: /api-docs/openapi.json). Every route in src/routes must appear here:
// tests/api/openapi.spec.ts fails when a route is added or removed without updating this file.

// ---------- small builders (keep each operation to a few lines) ----------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example && { example }) } });
const ok = (description, schema = { type: 'object' }, example) => ({ description, content: json(schema, example) });
const err = (name) => ({ $ref: `#/components/responses/${name}` });
const body = (properties, required = [], example) => ({
  required: true,
  content: json({ type: 'object', required, properties }, example),
});
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const pathParam = (name, description, schema = { type: 'string' }) => ({ name, in: 'path', required: true, description, schema });
const query = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });

const MPIN = str('6-digit MPIN (valid 5 minutes; get a new one with POST /api/accounts/me/mpin/reset)', { pattern: '^\\d{6}$', example: '123456' });
const AMOUNT = num('Amount in PHP, at most 2 decimals', { example: 250 });
const IDEMPOTENCY = { $ref: '#/components/parameters/IdempotencyKey' };

/**
 * One operation, authenticated by default. `money` adds the Idempotency-Key header; with
 * 'guarded' also the guard errors (AML 403, frozen 423, limits 429), with 'frozen' only 423.
 */
function op(tag, summary, { description, auth = true, money = false, params = [], requestBody, responses = {} } = {}) {
  return {
    tags: [tag],
    summary,
    ...(description && { description }),
    ...(auth ? {} : { security: [] }),
    parameters: [...(money ? [IDEMPOTENCY] : []), ...params],
    ...(requestBody && { requestBody }),
    responses: {
      ...responses,
      400: err('BadRequest'),
      ...(auth && { 401: err('Unauthorized') }),
      ...(money === 'guarded' && { 403: err('Forbidden'), 429: err('TooManyRequests') }),
      ...((money === 'guarded' || money === 'frozen') && { 423: err('Locked') }),
    },
  };
}

const QA_ONLY = 'Available only when the server runs with `QA_SANDBOX=true`; ADMIN accounts only. Affects the caller\'s own account.';

// ---------- the document ----------

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'PayPulse API',
    version: '1.0.0',
    description: [
      'PayPulse is a demo e-wallet built for QA practice: a PostgreSQL **double-entry ledger** (balances are computed from immutable entries), MPIN + OTP security, AML rules, daily limits, ISO 20022 messaging and a QA sandbox. **Play money only.**',
      '',
      '**Try it:** `POST /api/auth/register` (the answer contains your one-time **MPIN**), then `POST /api/auth/login`, press **Authorize** and paste the `token`.',
      '',
      '**Money-moving requests** accept an `Idempotency-Key` header: a retry with the same key replays the first answer instead of moving money twice. Amounts above ₱1,000 answer **202** with an OTP challenge; repeat the request with `otpChallengeId` + `otp` (the demo returns the code as `demoCode`).',
      '',
      'Every error has the same shape: `{ "error": { "code", "message", "details"? } }`; tests assert on `code`.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'System', description: 'Health and public configuration' },
    { name: 'Auth', description: 'Register, log in, reset a password' },
    { name: 'Accounts', description: 'My wallet, history, receipts, MPIN' },
    { name: 'Transfers', description: 'Express Send (PayPulse to PayPulse) and Bank Transfer (InstaPay / PESONet)' },
    { name: 'Bills', description: 'Pay Bills with ₱5 cashback' },
    { name: 'Load', description: 'Buy prepaid load with ₱5 cashback' },
    { name: 'Savings', description: 'PayPulse Save vault (6.00% p.a.)' },
    { name: 'Loans', description: 'Instant Loan (₱50,000 credit line)' },
    { name: 'Cards', description: 'Virtual Visa cards (tokenized, PCI-style masking)' },
    { name: 'QR', description: 'QR Ph receive and decode' },
    { name: 'Transactions', description: 'ISO 20022 Message Inspector' },
    { name: 'Profile', description: 'KYC, linked accounts, security preferences, support' },
    { name: 'Notifications', description: 'Notification center' },
    { name: 'Top-ups', description: 'Add money (mock card checkout, admins) and the provider webhook' },
    { name: 'QA Sandbox', description: QA_ONLY },
  ],
  paths: {
    // ----- System -----
    '/health': {
      get: op('System', 'Health check (app + database)', {
        auth: false,
        responses: { 200: ok('Healthy', { type: 'object' }, { status: 'ok', database: 'up' }), 503: ok('Database down') },
      }),
    },
    '/api/config': {
      get: op('System', 'Public feature flags for the web UI', {
        auth: false,
        responses: { 200: ok('Flags', { type: 'object' }, { features: { mockPayments: true, qaSandbox: true } }) },
      }),
    },

    // ----- Auth -----
    '/api/auth/register': {
      post: op('Auth', 'Create an account (returns the one-time MPIN)', {
        auth: false,
        requestBody: body(
          { email: str('Email', { format: 'email' }), password: str('At least 8 characters', { format: 'password' }), fullName: str('Full name') },
          ['email', 'password', 'fullName'],
          { email: 'juan@example.com', password: 'Sup3rSecret!', fullName: 'Juan Dela Cruz' },
        ),
        responses: { 201: ok('Account created', ref('Registration')), 409: err('Conflict') },
      }),
    },
    '/api/auth/login': {
      post: op('Auth', 'Log in and get a JWT (valid 1 hour)', {
        auth: false,
        requestBody: body({ email: str('Email'), password: str('Password', { format: 'password' }) }, ['email', 'password'],
          { email: 'juan@example.com', password: 'Sup3rSecret!' }),
        responses: { 200: ok('Logged in', ref('Login')), 401: err('Unauthorized'), 423: err('Locked') },
      }),
    },
    '/api/auth/password/forgot': {
      post: op('Auth', 'Start a password reset (same answer for unknown emails)', {
        auth: false,
        requestBody: body({ email: str('Email') }, ['email']),
        responses: { 200: ok('Reset started: { message, resetId, expiresInSeconds, demoCode }') },
      }),
    },
    '/api/auth/password/reset': {
      post: op('Auth', 'Finish a password reset with the emailed code', {
        auth: false,
        requestBody: body({ resetId: str('From /password/forgot'), code: str('6-digit code'), newPassword: str('New password') }, ['resetId', 'code', 'newPassword']),
        responses: { 200: ok('Password changed') },
      }),
    },

    // ----- Accounts -----
    '/api/accounts/me': {
      get: op('Accounts', 'My wallet: balance (from the ledger), KYC level, MPIN status', { responses: { 200: ok('My account', ref('Account')) } }),
    },
    '/api/accounts/me/transactions': {
      get: op('Accounts', 'My transaction history (newest first, paged)', {
        params: [
          query('limit', '1-100 (default 20)', { type: 'integer', minimum: 1, maximum: 100 }),
          query('before', 'transactionId to page from (nextBefore of the previous page)', { type: 'integer' }),
          query('direction', 'IN or OUT', { type: 'string', enum: ['IN', 'OUT'] }),
        ],
        responses: { 200: ok('History', ref('History')) },
      }),
    },
    '/api/accounts/me/transactions/{id}/receipt': {
      get: op('Accounts', 'Receipt of one of my transactions', {
        params: [pathParam('id', 'transactionId', { type: 'integer' })],
        responses: { 200: ok('Receipt'), 404: err('NotFound') },
      }),
    },
    '/api/accounts/me/compliance': {
      get: op('Accounts', 'My AML status (CLEAR / UNDER_REVIEW), the rules and my alerts', { responses: { 200: ok('Compliance status') } }),
    },
    '/api/accounts/me/mobile': {
      put: op('Accounts', 'Add or change my mobile number (for Express Send by mobile)', {
        requestBody: body({ mobileNumber: str('09XXXXXXXXX', { example: '09171234567' }) }, ['mobileNumber']),
        responses: { 200: ok('{ mobileNumber }'), 409: err('Conflict') },
      }),
    },
    '/api/accounts/me/mpin/reset': {
      post: op('Accounts', 'Get a new MPIN (needs the password)', {
        requestBody: body({ password: str('My password', { format: 'password' }) }, ['password']),
        responses: { 200: ok('{ mpin, mpinExpiresInSeconds }') },
      }),
    },
    '/api/accounts/me/mpin/change': {
      post: op('Accounts', 'Change my MPIN', {
        requestBody: body({ currentMpin: MPIN, newMpin: MPIN, confirmMpin: MPIN }, ['currentMpin', 'newMpin', 'confirmMpin']),
        responses: { 200: ok('{ message, mpinExpiresInSeconds }') },
      }),
    },

    // ----- Transfers -----
    '/api/transfers': {
      post: op('Transfers', 'Express Send to a PayPulse account or mobile number (free)', {
        money: 'guarded',
        description: 'Guards in order: idempotency replay → frozen account (423) → QA forced error → AML hold (403) → daily limit / anti-spam (429). Above ₱1,000 the first call answers 202 with an OTP challenge.',
        requestBody: body(
          {
            toAccountNumber: str('Recipient account (or use toMobileNumber)', { example: 'PP1000000002' }),
            toMobileNumber: str('Recipient mobile number'),
            amount: AMOUNT,
            description: str('Note'),
            mpin: MPIN,
            otpChallengeId: str('From the 202 answer (amounts above ₱1,000)'),
            otp: str('6-digit code'),
          },
          ['amount', 'mpin'],
          { toAccountNumber: 'PP1000000002', amount: 250, description: 'Lunch', mpin: '123456' },
        ),
        responses: { 201: ok('Sent', ref('Transfer')), 202: ok('OTP required', ref('OtpChallenge')), 404: err('NotFound') },
      }),
    },
    '/api/transfers/banks': {
      get: op('Transfers', 'Banks and e-wallets by category, with their routes (InstaPay / PESONet), and the fee', {
        responses: {
          200: ok('Banks', { type: 'object' }, {
            fee: '15.00',
            categories: { EWALLET: 'E-wallets & digital banks', BANK: 'Universal & commercial banks' },
            banks: [
              { code: 'GCASH', name: 'GCash', category: 'EWALLET', accountType: 'MOBILE', rails: ['INSTAPAY'], bic: 'GXCHPHM2XXX' },
              { code: 'BDO', name: 'BDO', category: 'BANK', accountType: 'BANK', rails: ['INSTAPAY', 'PESONET'], bic: 'BNORPHMMXXX' },
            ],
          }),
        },
      }),
    },
    '/api/transfers/limits': {
      get: op('Transfers', 'Daily limit used / remaining and the anti-spam rule', {
        responses: {
          200: ok('Limits', { type: 'object' }, {
            daily: { kycLevel: 1, limit: '50000.00', sentToday: '0.00', remaining: '50000.00', resetsAt: '2026-10-26T16:00:00.000Z' },
            rateLimit: { maxTransfers: 3, windowSeconds: 10, transfersInWindow: 0 },
          }),
        },
      }),
    },
    '/api/transfers/pesonet': {
      get: op('Transfers', 'My PESONet transfers (QUEUED / SETTLED) and the next cut-off', { responses: { 200: ok('PESONet transfers') } }),
    },
    '/api/transfers/bank': {
      post: op('Transfers', 'Bank Transfer via InstaPay (instant) or PESONet (batch), ₱15 fee', {
        money: 'guarded',
        description: 'Destinations and their routes come from GET /api/transfers/banks: every bank and e-wallet is on InstaPay; PESONet goes to the banks only (otherwise 400 RAIL_NOT_SUPPORTED).',
        requestBody: body(
          {
            bankCode: str('From GET /api/transfers/banks (e.g. GCASH, MAYA, GOTYME, BDO, UNIONBANK, LANDBANK)', { example: 'BDO' }),
            accountNumber: str('Recipient bank account'),
            accountName: str('Recipient name'),
            amount: AMOUNT,
            rail: str('Clearing rail', { enum: ['INSTAPAY', 'PESONET'], default: 'INSTAPAY' }),
            description: str('Note'),
            mpin: MPIN,
            otpChallengeId: str('From the 202 answer'),
            otp: str('6-digit code'),
          },
          ['bankCode', 'accountNumber', 'accountName', 'amount', 'mpin'],
          { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz', amount: 500, mpin: '123456' },
        ),
        responses: { 201: ok('Sent (PESONet: QUEUED until the cut-off)'), 202: ok('OTP required', ref('OtpChallenge')) },
      }),
    },
    '/api/transfers/bank/{transactionId}/iso20022': {
      get: op('Transfers', 'The pacs.008 message the payment switch sent for one of my bank transfers', {
        params: [pathParam('transactionId', 'transactionId', { type: 'integer' }), query('format', 'json (default) or xml', { type: 'string', enum: ['json', 'xml'] })],
        responses: { 200: { description: 'pacs.008', content: { ...json({ type: 'object' }), 'application/xml': { schema: { type: 'string' } } } }, 404: err('NotFound') },
      }),
    },

    // ----- Bills -----
    '/api/v1/bills': {
      get: op('Bills', 'Bill categories, billers, convenience fee and today\'s cashback status', { responses: { 200: ok('Catalog') } }),
    },
    '/api/v1/bills/pay': {
      post: op('Bills', 'Pay a bill (₱5 cashback on bills of ₱100 or more, 3 a day)', {
        money: 'guarded',
        requestBody: body(
          { billerCode: str('From GET /api/v1/bills', { example: 'MERALCO' }), accountNumber: str('Account at the biller'), accountName: str('Name on the bill'), amount: AMOUNT, mpin: MPIN },
          ['billerCode', 'accountNumber', 'accountName', 'amount', 'mpin'],
          { billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount: 1000, mpin: '123456' },
        ),
        responses: { 201: ok('Paid') },
      }),
    },

    // ----- Load -----
    '/api/v1/load': {
      get: op('Load', 'Networks, brands, regular amounts, promos and today\'s cashback status', { responses: { 200: ok('Catalog') } }),
    },
    '/api/v1/load/detect': {
      get: op('Load', 'Detect the network of a mobile number', {
        params: [query('mobile', 'Mobile number', { type: 'string', example: '09171234567' })],
        responses: { 200: ok('{ mobileNumber, detected, network }') },
      }),
    },
    '/api/v1/load/purchase': {
      post: op('Load', 'Buy regular load or a promo (₱5 cashback)', {
        money: 'guarded',
        description: 'The price is taken from the catalog (a promo\'s price), never from the client, before AML and the daily limit run.',
        requestBody: body(
          {
            mobileNumber: str('09XXXXXXXXX'),
            brand: str('GLOBE, TM, SMART, TNT, DITO or GOMO'),
            productType: str('REGULAR or PROMO', { enum: ['REGULAR', 'PROMO'] }),
            amount: num('Regular load amount (whole pesos)'),
            promoCode: str('Promo code (productType PROMO)'),
            mpin: MPIN,
          },
          ['mobileNumber', 'brand', 'productType', 'mpin'],
          { mobileNumber: '09171234567', brand: 'GLOBE', productType: 'PROMO', promoCode: 'GOPLUS99', mpin: '123456' },
        ),
        responses: { 201: ok('Purchased') },
      }),
    },

    // ----- Savings -----
    '/api/v1/savings': {
      get: op('Savings', 'Vault balance, 6.00% rate, interest earned and activity', { responses: { 200: ok('Savings') } }),
    },
    '/api/v1/savings/deposit': {
      post: op('Savings', 'Move money from the wallet to the vault', { money: 'frozen', requestBody: body({ amount: AMOUNT }, ['amount']), responses: { 201: ok('Moved') } }),
    },
    '/api/v1/savings/withdraw': {
      post: op('Savings', 'Move money from the vault to the wallet', { money: 'frozen', requestBody: body({ amount: AMOUNT }, ['amount']), responses: { 201: ok('Moved') } }),
    },

    // ----- Loans -----
    '/api/v1/loans': {
      get: op('Loans', 'Credit line, rate, terms and my open loan with its schedule', { responses: { 200: ok('Loans') } }),
      post: op('Loans', 'Apply & disburse: credits the wallet immediately', {
        money: 'frozen',
        requestBody: body({ amount: AMOUNT, termMonths: { type: 'integer', enum: [3, 6, 12] }, mpin: MPIN }, ['amount', 'termMonths', 'mpin']),
        responses: { 201: ok('Disbursed'), 409: err('Conflict') },
      }),
    },
    '/api/v1/loans/quote': {
      post: op('Loans', 'Quote: interest, total and monthly installment (nothing is booked)', {
        requestBody: body({ amount: AMOUNT, termMonths: { type: 'integer', enum: [3, 6, 12] } }, ['amount', 'termMonths']),
        responses: { 200: ok('Quote') },
      }),
    },
    '/api/v1/loans/{id}/repay': {
      post: op('Loans', 'Repay from the wallet (interest first, then principal)', {
        money: true,
        params: [pathParam('id', 'Loan id', { type: 'integer' })],
        requestBody: body({ amount: AMOUNT, mpin: MPIN }, ['amount', 'mpin']),
        responses: { 201: ok('Repaid'), 404: err('NotFound') },
      }),
    },

    // ----- Cards -----
    '/api/v1/cards': {
      get: op('Cards', 'My virtual cards (token + masked PAN only)', { responses: { 200: ok('Cards') } }),
    },
    '/api/v1/cards/generate': {
      post: op('Cards', 'Issue a tokenized virtual Visa card', { money: true, requestBody: body({ mpin: MPIN }, ['mpin']), responses: { 201: ok('Card (masked)') } }),
    },
    '/api/v1/cards/{token}': {
      get: op('Cards', 'One card (masked)', { params: [pathParam('token', 'Card token')], responses: { 200: ok('Card'), 404: err('NotFound') } }),
      patch: op('Cards', 'Lock (FROZEN) or unlock (ACTIVE, needs the MPIN) a card', {
        params: [pathParam('token', 'Card token')],
        requestBody: body({ status: str('ACTIVE or FROZEN', { enum: ['ACTIVE', 'FROZEN'] }), mpin: MPIN }, ['status']),
        responses: { 200: ok('Updated'), 404: err('NotFound') },
      }),
    },
    '/api/v1/cards/{token}/payments': {
      post: op('Cards', 'Online purchase with the virtual card (a locked card answers 403 CARD_FROZEN)', {
        money: 'guarded',
        params: [pathParam('token', 'Card token')],
        requestBody: body({ amount: AMOUNT, merchant: str('Merchant name'), mpin: MPIN }, ['amount', 'mpin']),
        responses: { 201: ok('Approved') },
      }),
    },
    '/api/v1/cards/{token}/reveal': {
      post: op('Cards', 'Full PAN, expiry and CVV, for the cardholder only', {
        params: [pathParam('token', 'Card token')],
        requestBody: body({ mpin: MPIN }, ['mpin']),
        responses: { 200: ok('Card details') },
      }),
    },

    // ----- QR -----
    '/api/qr/me': {
      get: op('QR', 'My QR Ph code ("Receive via QR")', {
        params: [query('amount', 'Optional requested amount', { type: 'number' })],
        responses: { 200: ok('{ accountNumber, name, amount, payload, svg }') },
      }),
    },
    '/api/qr/decode': {
      post: op('QR', 'Decode a QR Ph payload or account number', {
        requestBody: body({ payload: str('QR text or account number') }, ['payload']),
        responses: { 200: ok('{ format, accountNumber, receiverName, amount, isOwnAccount }') },
      }),
    },

    // ----- Transactions -----
    '/api/v1/transactions/{id}/iso20022': {
      get: op('Transactions', 'ISO 20022 pacs.008.001.08 of any of my transfers, bill payments or load purchases', {
        description: 'Bank transfers: the stored payment-switch message. Others: serialised from the double-entry ledger entries (debited wallet = debtor, fee = credit to SYS-FEE-INCOME, SttlmMtd INDA). Identifiers are derived from the transaction, so the message is always the same.',
        params: [pathParam('id', 'transactionId', { type: 'integer' }), query('format', 'json (default) or xml', { type: 'string', enum: ['json', 'xml'] })],
        responses: {
          200: { description: 'pacs.008', content: { ...json(ref('IsoMessage')), 'application/xml': { schema: { type: 'string' } } } },
          404: err('NotFound'),
          422: err('Unprocessable'),
        },
      }),
    },

    // ----- Profile -----
    '/api/v1/profile': {
      get: op('Profile', 'KYC level and tiers, security preferences, linked accounts, support tickets', { responses: { 200: ok('Profile') } }),
    },
    '/api/v1/profile/kyc': {
      post: op('Profile', 'Upgrade to KYC Level 2 (mock ID check; raises the daily limit to ₱100,000)', {
        requestBody: body({ idType: str('ID type'), idNumber: str('ID number (only the last 4 are kept)'), birthDate: str('YYYY-MM-DD', { format: 'date' }), selfieConfirmed: bool('Selfie taken') },
          ['idType', 'idNumber', 'birthDate', 'selfieConfirmed']),
        responses: { 200: ok('Level 2') },
      }),
    },
    '/api/v1/profile/linked-accounts': {
      post: op('Profile', 'Link a bank account or card', {
        requestBody: body({
          kind: str('BANK or CARD', { enum: ['BANK', 'CARD'] }),
          bankCode: str('BANK: bank code'),
          accountNumber: str('BANK: account number'),
          cardNumber: str('CARD: card number'),
          expiry: str('CARD: MM/YY'),
          holderName: str('Holder name'),
          mpin: MPIN,
        }, ['kind', 'holderName', 'mpin']),
        responses: { 201: ok('Linked') },
      }),
    },
    '/api/v1/profile/linked-accounts/{id}': {
      delete: op('Profile', 'Unlink a linked account', { params: [pathParam('id', 'Linked account id')], responses: { 204: { description: 'Unlinked (no content)' }, 404: err('NotFound') } }),
    },
    '/api/v1/profile/security': {
      patch: op('Profile', 'Security preferences (SMS 2FA on every send, biometric login)', {
        requestBody: body({ smsTwoFactor: bool('SMS code on every send'), biometricLogin: bool('Biometric login'), mpin: MPIN }),
        responses: { 200: ok('Updated') },
      }),
    },
    '/api/v1/profile/support/tickets': {
      post: op('Profile', 'Open a support ticket', {
        requestBody: body({ category: str('Category'), subject: str('Subject'), message: str('Message') }, ['category', 'subject', 'message']),
        responses: { 201: ok('Ticket') },
      }),
    },

    // ----- Notifications -----
    '/api/v1/notifications': {
      get: op('Notifications', 'Notifications with unread counts', { responses: { 200: ok('{ unreadCount, unreadByCategory, items }') } }),
    },
    '/api/v1/notifications/read': {
      post: op('Notifications', 'Mark notifications as read', {
        requestBody: body({ ids: { type: 'array', items: { type: 'string' } }, all: bool('Mark everything read') }),
        responses: { 200: ok('New unread counts') },
      }),
    },

    // ----- Top-ups -----
    '/api/payments/mock-checkout': {
      post: op('Top-ups', 'Add money with a mock card checkout (ADMIN, MOCK_PAYMENTS=true)', {
        money: true,
        description: 'Checks the top-up limits (₱1,000,000/day for admins, AML), then simulates the provider\'s signed callback through the same handler as the webhook.',
        requestBody: body({ amount: AMOUNT, outcome: str('approve (default) or decline', { enum: ['approve', 'decline'] }) }, ['amount']),
        responses: { 201: ok('Payment result'), 403: err('Forbidden') },
      }),
    },
    '/api/payments/limits': {
      get: op('Top-ups', 'How much can still be added today / held (ADMIN, MOCK_PAYMENTS=true)', { responses: { 200: ok('Top-up limits') } }),
    },
    '/api/webhooks/payments': {
      post: op('Top-ups', 'Payment provider callback (HMAC-signed; idempotent per paymentId)', {
        auth: false,
        params: [{ name: 'X-PayPulse-Signature', in: 'header', required: true, description: 'hex HMAC-SHA256 of the raw body with WEBHOOK_SECRET', schema: { type: 'string' } }],
        requestBody: body(
          { paymentId: str('Provider payment id'), accountNumber: str('Wallet to credit'), amount: AMOUNT, status: str('Payment status', { enum: ['PENDING', 'SUCCESS', 'FAILED'] }) },
          ['paymentId', 'accountNumber', 'amount', 'status'],
        ),
        responses: { 200: ok('{ received: true, ... }'), 401: err('Unauthorized') },
      }),
    },

    // ----- QA Sandbox -----
    '/api/qa/state': {
      get: op('QA Sandbox', 'My QA switches and balance', { description: QA_ONLY, responses: { 200: ok('{ slowNetwork, latencyMs, failNextTransaction, frozen, historyClearedAt, balance }') } }),
    },
    '/api/qa/settings': {
      put: op('QA Sandbox', 'Switch 3 s latency, fail-next-transaction (500) or freeze', {
        description: QA_ONLY,
        requestBody: body({ slowNetwork: bool('3 s latency on every call'), failNextTransaction: bool('Next money move fails with 500'), frozen: bool('Freeze the account (423)') }),
        responses: { 200: ok('New state') },
      }),
    },
    '/api/qa/reset': {
      post: op('QA Sandbox', 'Reset: wallet ₱100,000, savings ₱0, loan written off, history hidden, switches off', { description: QA_ONLY, responses: { 200: ok('Reset') } }),
    },
    '/api/qa/pesonet/run-cutoff': {
      post: op('QA Sandbox', 'Settle my queued PESONet transfers now', { description: QA_ONLY, responses: { 200: ok('Batch') } }),
    },
    '/api/qa/compliance/clear': {
      post: op('QA Sandbox', 'Act as the compliance officer: close my alerts, release the hold', { description: QA_ONLY, responses: { 200: ok('Cleared') } }),
    },
    '/api/qa/savings/accrue': {
      post: op('QA Sandbox', 'Simulate N days (1-31) of savings interest', {
        description: QA_ONLY,
        requestBody: body({ days: { type: 'integer', minimum: 1, maximum: 31, default: 1 } }),
        responses: { 200: ok('{ postedCents, ... }') },
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'The `token` from POST /api/auth/login' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Unique per user action (e.g. a UUID). A retry with the same key replays the first answer (`Idempotent-Replayed: true`) instead of moving money again.',
        schema: { type: 'string', maxLength: 255 },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: { type: 'string', example: 'INVALID_AMOUNT' }, message: { type: 'string' }, details: { type: 'object' } },
          },
        },
      },
      Registration: {
        type: 'object',
        properties: {
          user: { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' }, fullName: { type: 'string' }, mobileNumber: { type: 'string', nullable: true } } },
          account: { type: 'object', properties: { accountNumber: { type: 'string', example: 'PP1000000001' }, currency: { type: 'string', example: 'PHP' } } },
          mpin: { type: 'string', description: 'Shown once', example: '737251' },
          mpinExpiresInSeconds: { type: 'integer', example: 300 },
        },
      },
      Login: {
        type: 'object',
        properties: { token: { type: 'string' }, tokenType: { type: 'string', example: 'Bearer' }, expiresIn: { type: 'string', example: '1h' } },
      },
      Account: {
        type: 'object',
        example: {
          accountNumber: 'PP1000015357', accountHolder: 'Juan Dela Cruz', email: 'juan@example.com', memberSince: '2026-10-26T07:42:51.569Z',
          role: 'CUSTOMER', kycLevel: 1, frozen: false, amlStatus: 'CLEAR', mobileNumber: null, currency: 'PHP',
          balance: '0.00', balanceCents: 0, hasMpin: true, mpinExpiresInSeconds: 300,
        },
      },
      History: {
        type: 'object',
        properties: {
          transactions: { type: 'array', items: { type: 'object' } },
          hasMore: { type: 'boolean' },
          nextBefore: { type: 'integer', nullable: true },
        },
      },
      Transfer: {
        type: 'object',
        description: 'The completed transfer: transactionId, reference (REF-YYYYMMDD-NNNN), amounts and the new balance',
        properties: { transactionId: { type: 'integer' }, reference: { type: 'string' }, status: { type: 'string' } },
      },
      OtpChallenge: {
        type: 'object',
        properties: { otpRequired: { type: 'boolean', example: true }, challengeId: { type: 'string' }, expiresInSeconds: { type: 'integer' }, demoCode: { type: 'string', description: 'Demo only: the SMS code' } },
      },
      IsoMessage: {
        type: 'object',
        properties: {
          messageType: { type: 'string', example: 'pacs.008.001.08' },
          msgId: { type: 'string', example: 'PAYP20261026071159TX00016707' },
          uetr: { type: 'string', format: 'uuid' },
          endToEndId: { type: 'string', example: 'REF-20261026-16707' },
          rail: { type: 'string', example: 'ON_US' },
          status: { type: 'string', example: 'SETTLED' },
          source: { type: 'string', enum: ['LEDGER', 'PAYMENT_SWITCH'] },
          json: { type: 'object', description: 'The document as JSON (element names as in the XSD)' },
          xml: { type: 'string', description: 'The ISO 20022 XML message' },
        },
      },
    },
    responses: {
      BadRequest: { description: 'Validation error', content: json(ref('Error'), { error: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive number with at most 2 decimals' } }) },
      Unauthorized: { description: 'Missing / invalid token or credentials', content: json(ref('Error')) },
      Forbidden: { description: 'Held for compliance review (AML) or not allowed', content: json(ref('Error')) },
      NotFound: { description: 'Not found (or not yours)', content: json(ref('Error')) },
      Conflict: { description: 'Already exists / conflicting state', content: json(ref('Error')) },
      Unprocessable: { description: 'Not applicable to this resource', content: json(ref('Error')) },
      Locked: { description: 'Account frozen or locked', content: json(ref('Error')) },
      TooManyRequests: { description: 'Daily limit or anti-spam window reached', content: json(ref('Error')) },
    },
  },
};
