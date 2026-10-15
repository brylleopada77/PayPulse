const { pool } = require('../db/pool');
const { findBank } = require('./banks');
const { conflict, notFound } = require('../utils/errors');
const { fromCents } = require('../utils/money');
const { requireMobile } = require('../utils/mobile');
const { maskAccount } = require('../utils/privacy');
const { formatReference } = require('./receiptService');

async function getAccountForUser(userId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.account_number, ab.balance_cents, a.currency, u.full_name, u.mobile_number,
            u.email, u.created_at AS member_since, u.frozen, u.aml_status, u.history_cleared_at,
            u.mpin_hash IS NOT NULL AS has_mpin,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (u.mpin_expires_at - now()))))::int AS mpin_seconds_left
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     -- the balance is computed from the ledger, never stored
     JOIN account_balances ab ON ab.account_id = a.id
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
    email: account.email,
    memberSince: account.member_since,
    // A frozen account cannot send money (423 ACCOUNT_FROZEN).
    frozen: account.frozen,
    // UNDER_REVIEW: an AML rule fired; outgoing transfers are held (403) until compliance clears it.
    amlStatus: account.aml_status,
    // Others can Express Send to this number. null until the user adds one.
    mobileNumber: account.mobile_number,
    currency: account.currency,
    balance: fromCents(Number(account.balance_cents)),
    balanceCents: Number(account.balance_cents),
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

/**
 * Ledger history for the user's wallet, newest first. Bank transfers include their details.
 * Entries from before a QA sandbox reset (users.history_cleared_at) are hidden.
 */
async function getTransactions(userId, limit = 50) {
  const account = await getAccountForUser(userId);
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.description, t.created_at, le.direction, le.amount_cents,
            bt.reference, bt.bank_code, bt.account_number AS bank_account, bt.account_name,
            bt.amount_cents AS bank_amount_cents, bt.fee_cents, bt.rail, bt.status AS bank_status
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     LEFT JOIN bank_transfers bt ON bt.transaction_id = t.id
     WHERE le.account_id = $1
       -- compared inside SQL: a JS Date would drop the microseconds of history_cleared_at
       AND t.created_at > COALESCE((SELECT history_cleared_at FROM users WHERE id = $3), '-infinity')
     ORDER BY le.id DESC
     LIMIT $2`,
    [account.id, limit, userId],
  );

  return rows.map((row) => ({
    transactionId: row.id,
    reference: formatReference(row.id, row.created_at),
    type: row.type,
    direction: row.direction,
    amount: fromCents(row.amount_cents),
    amountCents: row.amount_cents,
    description: row.description,
    createdAt: row.created_at,
    ...(row.reference && {
      bankTransfer: {
        bankReference: row.reference,
        bank: findBank(row.bank_code)?.name ?? row.bank_code,
        accountNumber: maskAccount(row.bank_account),
        accountName: row.account_name,
        amount: fromCents(row.bank_amount_cents),
        fee: fromCents(row.fee_cents),
        rail: row.rail,
        status: row.bank_status,
      },
    }),
  }));
}

module.exports = { getBalance, getTransactions, setMobileNumber };
