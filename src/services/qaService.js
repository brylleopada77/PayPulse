// QA Sandbox: per-user switches for testing negative scenarios (QA_SANDBOX=true only).
// Every action affects ONLY the logged-in user's own account.
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction, getBalanceCents } = require('./ledgerService');
const { fromCents } = require('../utils/money');
const loanService = require('./loanService');

const SLOW_NETWORK_MS = 3000;
const RESET_BALANCE_CENTS = 10_000_000; // ₱100,000.00
const QA_ACCOUNT = 'SYS-QA-ADJUSTMENT'; // GL 3900 Sandbox Adjustments (non-production)

async function getState(userId) {
  const { rows } = await pool.query(
    `SELECT u.qa_latency_ms, u.qa_fail_next, u.frozen, u.aml_status, u.history_cleared_at, ab.balance_cents
     FROM users u JOIN account_balances ab ON ab.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    slowNetwork: row.qa_latency_ms > 0,
    latencyMs: row.qa_latency_ms,
    failNextTransaction: row.qa_fail_next,
    frozen: row.frozen,
    amlStatus: row.aml_status,
    historyClearedAt: row.history_cleared_at,
    balance: fromCents(Number(row.balance_cents)),
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
 *   - balance becomes ₱100,000.00 through a QA_ADJUSTMENT journal against GL 3900 (debits =
 *     credits); nothing is edited or deleted, so an overdrawn wallet is brought back too
 *   - PayPulse Save goes back to ₱0 and an open Instant Loan is written off (also against GL 3900)
 *   - recent history is hidden and the daily / anti-spam / velocity limits restart (rows are kept)
 *   - freeze, slow network, forced error, compliance hold, MPIN lock and pending OTPs are cleared
 */
async function reset(userId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, user_id FROM accounts WHERE user_id = $1 OR savings_owner_id = $1 ORDER BY id FOR UPDATE',
      [userId],
    );
    const qa = await client.query('SELECT id FROM accounts WHERE account_number = $1', [QA_ACCOUNT]);
    const qaId = qa.rows[0].id;

    await loanService.writeOffForQa(client, userId, qaId);

    // Wallet back to ₱100,000; PayPulse Save vault (if any) back to ₱0.
    for (const account of rows) {
      const target = account.user_id === userId ? RESET_BALANCE_CENTS : 0;
      const delta = target - (await getBalanceCents(client, account.id));
      if (delta === 0) continue;
      const amountCents = Math.abs(delta);
      await recordTransaction(client, {
        type: 'QA_ADJUSTMENT',
        description: 'QA sandbox reset',
        entries:
          delta > 0
            ? [
                { accountId: qaId, direction: 'DEBIT', amountCents },
                { accountId: account.id, direction: 'CREDIT', amountCents },
              ]
            : [
                { accountId: account.id, direction: 'DEBIT', amountCents },
                { accountId: qaId, direction: 'CREDIT', amountCents },
              ],
      });
    }

    // now() is the transaction's start time, so the adjustment above is hidden too (created_at = now()).
    await client.query(
      `UPDATE users
       SET history_cleared_at = now(), frozen = false, qa_latency_ms = 0, qa_fail_next = false,
           aml_status = 'CLEAR', mpin_failed_attempts = 0, mpin_locked_until = NULL
       WHERE id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE compliance_alerts SET status = 'CLEARED', cleared_at = now() WHERE user_id = $1 AND status = 'OPEN'`,
      [userId],
    );
    await client.query('UPDATE otp_challenges SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  });
  return getState(userId);
}

module.exports = { getState, updateSettings, consumeFailNext, reset, SLOW_NETWORK_MS, RESET_BALANCE_CENTS };
