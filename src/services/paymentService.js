const crypto = require('crypto');
const config = require('../config');
const { withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { badRequest, notFound, unauthorized } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const STATUSES = ['PENDING', 'SUCCESS', 'FAILED'];
const FUNDING_ACCOUNT_NUMBER = 'SYS-EXTERNAL-FUNDING';

/** HMAC-SHA256 of the raw request body, hex encoded. */
function sign(rawBody) {
  return crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
}

function verifySignature(rawBody, signature) {
  if (typeof signature !== 'string' || !rawBody) {
    throw unauthorized('Missing webhook signature');
  }
  const expected = Buffer.from(sign(rawBody));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw unauthorized('Invalid webhook signature');
  }
}

function validatePayload({ paymentId, accountNumber, status }) {
  if (typeof paymentId !== 'string' || paymentId.trim() === '') {
    throw badRequest('INVALID_PAYMENT_ID', 'paymentId is required');
  }
  if (typeof accountNumber !== 'string' || accountNumber.trim() === '') {
    throw badRequest('INVALID_ACCOUNT_NUMBER', 'accountNumber is required');
  }
  if (!STATUSES.includes(status)) {
    throw badRequest('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`);
  }
}

/**
 * Credit the wallet: DEBIT cash at bank (GL 1010, the money arrived in PayPulse's bank account),
 * CREDIT the customer's wallet (GL 2010, PayPulse now owes the customer that money).
 * No balance is edited: both balances follow from these two ledger entries.
 */
async function creditWallet(client, walletId, amountCents, paymentId) {
  const funding = await client.query(
    'SELECT id FROM accounts WHERE account_number = $1',
    [FUNDING_ACCOUNT_NUMBER],
  );
  const fundingId = funding.rows[0].id;

  const transactionId = await recordTransaction(client, {
    type: 'DEPOSIT',
    description: `Top-up via payment ${paymentId}`,
    entries: [
      { accountId: fundingId, direction: 'DEBIT', amountCents },
      { accountId: walletId, direction: 'CREDIT', amountCents },
    ],
  });
  return transactionId;
}

/**
 * Handle a payment status callback from the (mock) payment provider.
 * Idempotent: the same paymentId only ever credits the wallet once.
 */
/**
 * @param {object} [options]
 * @param {(client) => Promise<void>} [options.beforeCredit]  runs inside the same database transaction
 *   before anything is recorded (used by the mock checkout to lock and check its limits); throwing
 *   from it rolls everything back.
 */
async function handlePaymentCallback(rawBody, signature, payload, { beforeCredit } = {}) {
  verifySignature(rawBody, signature);
  validatePayload(payload);
  const amountCents = toCents(payload.amount);
  const paymentId = payload.paymentId.trim();

  return withTransaction(async (client) => {
    const wallet = await client.query(
      'SELECT id FROM accounts WHERE account_number = $1 AND is_system = false',
      [payload.accountNumber.trim()],
    );
    if (!wallet.rows[0]) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Account does not exist');
    }
    const walletId = wallet.rows[0].id;
    if (beforeCredit) await beforeCredit(client);

    // Create the payment row, or lock the existing one so parallel callbacks queue up.
    await client.query(
      `INSERT INTO payments (payment_id, account_id, amount_cents, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId, walletId, amountCents],
    );
    const { rows } = await client.query(
      'SELECT id, status, transaction_id FROM payments WHERE payment_id = $1 FOR UPDATE',
      [paymentId],
    );
    const payment = rows[0];

    if (payment.status === 'SUCCESS') {
      return { paymentId, status: 'SUCCESS', credited: false, duplicate: true };
    }

    let transactionId = null;
    if (payload.status === 'SUCCESS') {
      transactionId = await creditWallet(client, walletId, amountCents, paymentId);
    }

    await client.query(
      `UPDATE payments SET status = $1, transaction_id = $2, updated_at = now() WHERE id = $3`,
      [payload.status, transactionId, payment.id],
    );

    return {
      paymentId,
      status: payload.status,
      credited: transactionId !== null,
      amount: fromCents(amountCents),
      transactionId,
      duplicate: false,
    };
  });
}

module.exports = { handlePaymentCallback, sign };
