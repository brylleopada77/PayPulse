const { pool } = require('../db/pool');
const { findBank } = require('./banks');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { fromCents } = require('../utils/money');
const { requireMobile } = require('../utils/mobile');
const { maskAccount } = require('../utils/privacy');
const { formatReference } = require('./receiptService');

async function getAccountForUser(userId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.account_number, ab.balance_cents, a.currency, u.full_name, u.mobile_number,
            u.email, u.created_at AS member_since, u.frozen, u.aml_status, u.history_cleared_at, u.role,
            u.mpin_hash IS NOT NULL AS has_mpin, u.kyc_level,
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
    // CUSTOMER or ADMIN (admins can Add money and use the QA tools).
    role: account.role,
    // 1 = Basic (₱50,000 a day), 2 = Fully Verified (₱100,000 a day).
    kycLevel: account.kyc_level,
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

const DIRECTIONS = { IN: 'CREDIT', OUT: 'DEBIT' };

/**
 * Validate the paging query of GET /me/transactions:
 *   limit      1-100 (default 50)
 *   before     a transactionId: only older transactions (the "Load more" cursor)
 *   direction  IN (money in) | OUT (money out)
 */
function parseHistoryQuery({ limit, before, direction } = {}) {
  const parsed = { limit: 50, before: null, direction: null };
  if (limit !== undefined) {
    parsed.limit = Number(limit);
    if (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 100) {
      throw badRequest('INVALID_LIMIT', 'limit must be a whole number from 1 to 100');
    }
  }
  if (before !== undefined) {
    parsed.before = Number(before);
    if (!Number.isInteger(parsed.before) || parsed.before < 1) throw badRequest('INVALID_CURSOR', 'before must be a transaction id');
  }
  if (direction !== undefined) {
    parsed.direction = DIRECTIONS[String(direction).toUpperCase()];
    if (!parsed.direction) throw badRequest('INVALID_DIRECTION', 'direction must be IN or OUT');
  }
  return parsed;
}

/**
 * Ledger history for the user's wallet, newest first. Bank transfers include their details.
 * Daily interest credited to the user's PayPulse Save vault is included too (account: "SAVINGS"),
 * so every day's earnings show in the history; everything else is the main wallet (account: "WALLET").
 * Entries from before a QA sandbox reset (users.history_cleared_at) are hidden.
 * Returns one page: { transactions, hasMore, nextBefore } (nextBefore = cursor for the next page).
 */
async function getTransactionPage(userId, { limit = 50, before = null, direction = null } = {}) {
  const account = await getAccountForUser(userId);
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.description, t.created_at, le.direction, le.amount_cents,
            le.account_id <> $1 AS in_savings,
            bt.reference, bt.bank_code, bt.account_number AS bank_account, bt.account_name,
            bt.amount_cents AS bank_amount_cents, bt.fee_cents, bt.rail, bt.status AS bank_status
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     LEFT JOIN bank_transfers bt ON bt.transaction_id = t.id
     WHERE (le.account_id = $1
            OR (t.type = 'INTEREST' AND le.account_id = (SELECT id FROM accounts WHERE savings_owner_id = $3)))
       -- compared inside SQL: a JS Date would drop the microseconds of history_cleared_at
       AND t.created_at > COALESCE((SELECT history_cleared_at FROM users WHERE id = $3), '-infinity')
       AND ($4::int IS NULL OR t.id < $4)
       AND ($5::text IS NULL OR le.direction = $5)
     ORDER BY t.id DESC, le.id DESC
     LIMIT $2`,
    [account.id, limit + 1, userId, before, direction], // one extra row tells us if there is more
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const transactions = page.map((row) => ({
    transactionId: row.id,
    reference: formatReference(row.id, row.created_at),
    type: row.type,
    direction: row.direction,
    amount: fromCents(row.amount_cents),
    amountCents: row.amount_cents,
    description: row.description,
    createdAt: row.created_at,
    // WALLET: the main wallet (Available Balance). SAVINGS: credited to PayPulse Save (interest).
    account: row.in_savings ? 'SAVINGS' : 'WALLET',
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
  return { transactions, hasMore, nextBefore: hasMore ? page[page.length - 1].id : null };
}

/** The newest `limit` transactions (kept for existing callers). */
async function getTransactions(userId, limit = 50) {
  return (await getTransactionPage(userId, { limit })).transactions;
}

module.exports = { getBalance, getTransactions, getTransactionPage, parseHistoryQuery, setMobileNumber };
