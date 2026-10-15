const { pool } = require('../db/pool');
const { findBank } = require('./banks');
const { conflict, notFound } = require('../utils/errors');
const { fromCents } = require('../utils/money');
const { requireMobile } = require('../utils/mobile');

async function getAccountForUser(userId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.account_number, a.balance_cents, a.currency, u.full_name, u.mobile_number,
            u.mpin_hash IS NOT NULL AS has_mpin,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (u.mpin_expires_at - now()))))::int AS mpin_seconds_left
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = $1`,
    [userId],
  );
  if (!rows[0]) {
    throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  }
  return rows[0];
}

async function getBalance(userId) {
  const account = await getAccountForUser(userId);
  return {
    accountNumber: account.account_number,
    accountHolder: account.full_name,
    // Others can Express Send to this number. null until the user adds one.
    mobileNumber: account.mobile_number,
    currency: account.currency,
    balance: fromCents(account.balance_cents),
    balanceCents: account.balance_cents,
    // false for accounts created before random MPINs: the UI asks them to set one up.
    hasMpin: account.has_mpin,
    // Seconds until the MPIN expires (0 = expired; get a new one with the password).
    mpinExpiresInSeconds: account.mpin_seconds_left ?? 0,
  };
}

/** Add or change the user's mobile number (must not belong to another user). */
async function setMobileNumber(userId, mobileNumber) {
  const mobile = requireMobile(mobileNumber);
  try {
    await pool.query('UPDATE users SET mobile_number = $1 WHERE id = $2', [mobile, userId]);
  } catch (err) {
    if (err.code === '23505') {
      throw conflict('MOBILE_TAKEN', 'This mobile number is already used by another PayPulse account');
    }
    throw err;
  }
  return { mobileNumber: mobile };
}

/** Ledger history for the user's wallet, newest first. Bank transfers include their details. */
async function getTransactions(userId, limit = 50) {
  const account = await getAccountForUser(userId);
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.description, t.created_at, le.direction, le.amount_cents,
            bt.reference, bt.bank_code, bt.account_number AS bank_account, bt.account_name,
            bt.amount_cents AS bank_amount_cents, bt.fee_cents
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     LEFT JOIN bank_transfers bt ON bt.transaction_id = t.id
     WHERE le.account_id = $1
     ORDER BY le.id DESC
     LIMIT $2`,
    [account.id, limit],
  );

  return rows.map((row) => ({
    transactionId: row.id,
    type: row.type,
    direction: row.direction,
    amount: fromCents(row.amount_cents),
    amountCents: row.amount_cents,
    description: row.description,
    createdAt: row.created_at,
    ...(row.reference && {
      bankTransfer: {
        reference: row.reference,
        bank: findBank(row.bank_code)?.name ?? row.bank_code,
        accountNumber: `••••${row.bank_account.slice(-4)}`,
        accountName: row.account_name,
        amount: fromCents(row.bank_amount_cents),
        fee: fromCents(row.fee_cents),
      },
    }),
  }));
}

module.exports = { getBalance, getTransactions, setMobileNumber };
