// PESONet (mock): outbound batch transfers wait in "PESONet Clearing - Pending Outbound"
// (GL 2020) until a batch cut-off, then the whole batch is settled in one ledger transaction:
//   DEBIT  SYS-PESONET-CLEARING  (GL 2020)  batch total
//   CREDIT SYS-BANK-SETTLEMENT   (GL 1020)  batch total
const crypto = require('crypto');
const config = require('../config');
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { fromCents } = require('../utils/money');

const CLEARING_ACCOUNT = 'SYS-PESONET-CLEARING';
const SETTLEMENT_ACCOUNT = 'SYS-BANK-SETTLEMENT';
const BATCH_LOCK_KEY = 4270082; // pg advisory lock: only one cut-off runs at a time

const cutoffMs = () => config.pesonetCutoffMinutes * 60_000;

/** The next mock cut-off after `now` (cut-offs are every PESONET_CUTOFF_MINUTES, on the clock). */
function nextCutoff(now = new Date()) {
  return new Date(Math.floor(now.getTime() / cutoffMs()) * cutoffMs() + cutoffMs());
}

/** The most recent cut-off at or before `now`. */
function lastCutoff(now = new Date()) {
  return new Date(Math.floor(now.getTime() / cutoffMs()) * cutoffMs());
}

/**
 * Run a batch cut-off: settle every QUEUED PESONet transfer created at or before `cutoffAt`.
 * `userId` limits the batch to one customer's transfers (used by the QA sandbox "run now").
 * Returns the batch, or null when there was nothing to settle or another cut-off is running.
 */
async function runCutoff({ cutoffAt = new Date(), userId = null } = {}) {
  return withTransaction(async (client) => {
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [BATCH_LOCK_KEY]);
    if (!lock.rows[0].locked) return null;

    const { rows: items } = await client.query(
      `SELECT id, amount_cents FROM bank_transfers
       WHERE status = 'QUEUED' AND rail = 'PESONET' AND created_at <= $1
         AND ($2::int IS NULL OR user_id = $2)
       ORDER BY id
       FOR UPDATE SKIP LOCKED`,
      [cutoffAt, userId],
    );
    if (items.length === 0) return null;

    const totalCents = items.reduce((sum, item) => sum + Number(item.amount_cents), 0);
    const batchId = `PSN-${cutoffAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const accounts = await client.query(
      'SELECT account_number, id FROM accounts WHERE account_number = ANY($1)',
      [[CLEARING_ACCOUNT, SETTLEMENT_ACCOUNT]],
    );
    const idOf = Object.fromEntries(accounts.rows.map((r) => [r.account_number, r.id]));

    const transactionId = await recordTransaction(client, {
      type: 'PESONET_SETTLEMENT',
      description: `PESONet batch ${batchId} (${items.length} transfer${items.length === 1 ? '' : 's'})`,
      entries: [
        { accountId: idOf[CLEARING_ACCOUNT], direction: 'DEBIT', amountCents: totalCents },
        { accountId: idOf[SETTLEMENT_ACCOUNT], direction: 'CREDIT', amountCents: totalCents },
      ],
    });

    const ids = items.map((item) => item.id);
    await client.query(
      `INSERT INTO pesonet_batches (batch_id, cutoff_at, item_count, total_cents, transaction_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [batchId, cutoffAt, items.length, totalCents, transactionId],
    );
    await client.query(
      `UPDATE bank_transfers SET status = 'SETTLED', settled_at = now(), batch_id = $2 WHERE id = ANY($1)`,
      [ids, batchId],
    );
    await client.query(
      `UPDATE payment_messages SET status = 'SETTLED', updated_at = now() WHERE bank_transfer_id = ANY($1)`,
      [ids],
    );

    return { batchId, cutoffAt, itemCount: items.length, total: fromCents(totalCents), totalCents, transactionId };
  });
}

/** The user's PESONet transfers and the next cut-off (GET /api/transfers/pesonet). */
async function getForUser(userId) {
  const { rows } = await pool.query(
    `SELECT bt.reference, bt.transaction_id, bt.amount_cents, bt.status, bt.batch_id, bt.created_at, bt.settled_at
     FROM bank_transfers bt
     WHERE bt.user_id = $1 AND bt.rail = 'PESONET'
     ORDER BY bt.id DESC LIMIT 20`,
    [userId],
  );
  return {
    cutoffEveryMinutes: config.pesonetCutoffMinutes,
    nextCutoffAt: nextCutoff(),
    transfers: rows.map((r) => ({
      bankReference: r.reference,
      transactionId: r.transaction_id,
      amount: fromCents(Number(r.amount_cents)),
      status: r.status,
      batchId: r.batch_id,
      createdAt: r.created_at,
      settledAt: r.settled_at,
    })),
  };
}

module.exports = { runCutoff, getForUser, nextCutoff, lastCutoff, CLEARING_ACCOUNT, SETTLEMENT_ACCOUNT };
