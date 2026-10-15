// QA Sandbox: per-user switches for testing negative scenarios (QA_SANDBOX=true only).
// Every action affects ONLY the logged-in user's own account.
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { fromCents } = require('../utils/money');

const SLOW_NETWORK_MS = 3000;
const RESET_BALANCE_CENTS = 100_000; // ₱1,000.00
const QA_ACCOUNT = 'SYS-QA-ADJUSTMENT';

async function getState(userId) {
  const { rows } = await pool.query(
    `SELECT u.qa_latency_ms, u.qa_fail_next, u.frozen, u.history_cleared_at, a.balance_cents
     FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    slowNetwork: row.qa_latency_ms > 0,
    latencyMs: row.qa_latency_ms,
    failNextTransaction: row.qa_fail_next,
    frozen: row.frozen,
    historyClearedAt: row.history_cleared_at,
    balance: fromCents(row.balance_cents),
  };
}

/** Switch any of: slowNetwork, failNextTransaction, frozen (booleans; others are ignored). */
async function updateSettings(userId, { slowNetwork, failNextTransaction, frozen } = {}) {
  const sets = [];
  const values = [userId];
  const add = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (typeof slowNetwork === 'boolean') add('qa_latency_ms', slowNetwork ? SLOW_NETWORK_MS : 0);
  if (typeof failNextTransaction === 'boolean') add('qa_fail_next', failNextTransaction);
  if (typeof frozen === 'boolean') add('frozen', frozen);

  if (sets.length > 0) {
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values);
  }
  return getState(userId);
}

/** One-shot: true (and switched off again) if "fail next transaction" was on. */
async function consumeFailNext(userId) {
  const { rowCount } = await pool.query(
    'UPDATE users SET qa_fail_next = false WHERE id = $1 AND qa_fail_next = true',
    [userId],
  );
  return rowCount > 0;
}

/**
 * Reset the user's own account to a clean test state:
 *   - balance becomes ₱1,000.00 through a QA_ADJUSTMENT ledger transaction (debits = credits),
 *     based on the LEDGER balance, so a cached balance broken by the race bug is repaired too
 *   - recent history is hidden and the daily / anti-spam limits restart (rows are kept)
 *   - freeze, slow network, forced error, MPIN lock and pending OTP codes are cleared
 */
async function reset(userId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id,
              COALESCE((SELECT SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END)
                        FROM ledger_entries le WHERE le.account_id = a.id), 0) AS ledger_cents
       FROM accounts a WHERE a.user_id = $1 FOR UPDATE`,
      [userId],
    );
    const wallet = rows[0];
    const delta = RESET_BALANCE_CENTS - Number(wallet.ledger_cents);

    if (delta !== 0) {
      const qa = await client.query('SELECT id FROM accounts WHERE account_number = $1', [QA_ACCOUNT]);
      const qaId = qa.rows[0].id;
      const amountCents = Math.abs(delta);
      await recordTransaction(client, {
        type: 'QA_ADJUSTMENT',
        description: 'QA sandbox reset',
        entries:
          delta > 0
            ? [
                { accountId: qaId, direction: 'DEBIT', amountCents },
                { accountId: wallet.id, direction: 'CREDIT', amountCents },
              ]
            : [
                { accountId: wallet.id, direction: 'DEBIT', amountCents },
                { accountId: qaId, direction: 'CREDIT', amountCents },
              ],
      });
      await client.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2', [delta, qaId]);
    }
    await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2', [RESET_BALANCE_CENTS, wallet.id]);

    // now() is the transaction's start time, so the adjustment above is hidden too (created_at = now()).
    await client.query(
      `UPDATE users
       SET history_cleared_at = now(), frozen = false, qa_latency_ms = 0, qa_fail_next = false,
           mpin_failed_attempts = 0, mpin_locked_until = NULL
       WHERE id = $1`,
      [userId],
    );
    await client.query('UPDATE otp_challenges SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  });
  return getState(userId);
}

module.exports = { getState, updateSettings, consumeFailNext, reset, SLOW_NETWORK_MS, RESET_BALANCE_CENTS };
