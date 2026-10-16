// Automated AML transaction monitoring (simulated). Runs before every outgoing transfer.
//
// Rules:
//   LARGE_TRANSFER  a single transfer above ₱500,000
//   VELOCITY        more than 5 completed transfers within 1 minute (the 6th is held)
//
// When a rule fires, the transfer is NOT executed, a compliance alert is opened, and the account
// goes UNDER_REVIEW: every further outgoing transfer is held too, until compliance clears it.
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../utils/errors');
const { fromCents } = require('../utils/money');

const LARGE_TRANSFER_CENTS = 50_000_000; // ₱500,000.00
const VELOCITY_MAX_TRANSFERS = 5;
const VELOCITY_WINDOW_SECONDS = 60;
const HELD_MESSAGE = 'Transaction Held for Compliance Review';
const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

function heldError(details) {
  return new AppError(403, 'TRANSACTION_HELD_FOR_REVIEW', HELD_MESSAGE, { details });
}

/** Completed outgoing transfers and bill payments in the velocity window (after any QA sandbox reset). */
async function recentTransferCount(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     JOIN accounts a ON a.id = le.account_id
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = $1
       AND le.direction = 'DEBIT'
       AND t.type IN ('TRANSFER', 'BANK_TRANSFER', 'BILL_PAYMENT')
       AND t.created_at > now() - make_interval(secs => $2)
       AND t.created_at > COALESCE(u.history_cleared_at, '-infinity')`,
    [userId, VELOCITY_WINDOW_SECONDS],
  );
  return rows[0].n;
}

/** Open an alert and put the account under review (one database transaction). */
async function flag(userId, { rule, amountCents, endpoint, details }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO compliance_alerts (user_id, rule, amount_cents, endpoint, details)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, rule, amountCents, endpoint, details],
    );
    await client.query(`UPDATE users SET aml_status = 'UNDER_REVIEW' WHERE id = $1`, [userId]);
    return rows[0].id;
  });
}

/**
 * Check an outgoing transfer of `amountCents`. Throws 403 TRANSACTION_HELD_FOR_REVIEW when the
 * account is already under review or when a rule fires (which also opens an alert).
 */
async function screenTransfer(userId, amountCents, endpoint) {
  const { rows } = await pool.query('SELECT aml_status FROM users WHERE id = $1', [userId]);
  if (rows[0]?.aml_status === 'UNDER_REVIEW') {
    throw heldError({
      rule: 'ACCOUNT_UNDER_REVIEW',
      reason: 'This account is under compliance review. Outgoing transfers are on hold until it is cleared.',
    });
  }

  if (amountCents > LARGE_TRANSFER_CENTS) {
    const details = {
      rule: 'LARGE_TRANSFER',
      reason: `Single transfers above ${peso(LARGE_TRANSFER_CENTS)} are reviewed before release.`,
      threshold: fromCents(LARGE_TRANSFER_CENTS),
      amount: fromCents(amountCents),
    };
    const alertId = await flag(userId, { rule: 'LARGE_TRANSFER', amountCents, endpoint, details });
    throw heldError({ ...details, alertId });
  }

  const recent = await recentTransferCount(userId);
  if (recent >= VELOCITY_MAX_TRANSFERS) {
    const details = {
      rule: 'VELOCITY',
      reason: `More than ${VELOCITY_MAX_TRANSFERS} transfers within ${VELOCITY_WINDOW_SECONDS} seconds.`,
      transfersInWindow: recent + 1,
      maxTransfers: VELOCITY_MAX_TRANSFERS,
      windowSeconds: VELOCITY_WINDOW_SECONDS,
    };
    const alertId = await flag(userId, { rule: 'VELOCITY', amountCents, endpoint, details });
    throw heldError({ ...details, alertId });
  }
}

/** The user's own compliance status and alerts (GET /api/accounts/me/compliance). */
async function getStatus(userId) {
  const { rows: user } = await pool.query('SELECT aml_status FROM users WHERE id = $1', [userId]);
  const { rows } = await pool.query(
    `SELECT id, rule, amount_cents, endpoint, details, status, created_at, cleared_at
     FROM compliance_alerts WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
    [userId],
  );
  return {
    amlStatus: user[0].aml_status,
    rules: {
      largeTransferAbove: fromCents(LARGE_TRANSFER_CENTS),
      velocity: { maxTransfers: VELOCITY_MAX_TRANSFERS, windowSeconds: VELOCITY_WINDOW_SECONDS },
    },
    alerts: rows.map((r) => ({
      alertId: r.id,
      rule: r.rule,
      amount: fromCents(Number(r.amount_cents)),
      endpoint: r.endpoint,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      clearedAt: r.cleared_at,
    })),
  };
}

/** Compliance officer action (simulated via the QA sandbox): close open alerts, release the hold. */
async function clear(userId) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE compliance_alerts SET status = 'CLEARED', cleared_at = now() WHERE user_id = $1 AND status = 'OPEN'`,
      [userId],
    );
    await client.query(`UPDATE users SET aml_status = 'CLEAR' WHERE id = $1`, [userId]);
  });
  return getStatus(userId);
}

module.exports = {
  screenTransfer,
  getStatus,
  clear,
  LARGE_TRANSFER_CENTS,
  VELOCITY_MAX_TRANSFERS,
  VELOCITY_WINDOW_SECONDS,
  HELD_MESSAGE,
};
