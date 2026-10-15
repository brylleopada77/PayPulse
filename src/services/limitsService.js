const { pool } = require('../db/pool');
const { badRequest, notFound, tooManyRequests } = require('../utils/errors');
const { fromCents } = require('../utils/money');

// ₱50,000 per account per calendar day (Philippine time). Counts the amounts you SEND with
// Express Send and Bank Transfer; bank fees and money you receive don't count.
const DAILY_LIMIT_CENTS = 5_000_000;
// Simulated fraud prevention: at most 3 transfers in any 10 seconds.
const MAX_TRANSFERS_PER_WINDOW = 3;
const WINDOW_SECONDS = 10;
const TIME_ZONE = 'Asia/Manila';

/**
 * How much the account has sent today, and its transfers in the last WINDOW_SECONDS.
 *
 * NOTE: like the balance check, this is a plain read without a lock. Sequential requests are
 * limited correctly, but a burst of truly simultaneous requests can all read the same numbers
 * and get past both limits (see QA_NOTES.md). The intentional race-condition tests rely on this.
 */
async function getUsage(accountId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'BANK_TRANSFER' THEN bt.amount_cents ELSE le.amount_cents END)
                FILTER (WHERE t.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2), 0)
         AS sent_today_cents,
       COUNT(*) FILTER (WHERE t.created_at > now() - make_interval(secs => $3)) AS recent_count,
       MIN(t.created_at) FILTER (WHERE t.created_at > now() - make_interval(secs => $3)) AS oldest_recent_at,
       (date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2 AS resets_at
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     LEFT JOIN bank_transfers bt ON bt.transaction_id = t.id
     WHERE le.account_id = $1
       AND le.direction = 'DEBIT'
       AND t.type IN ('TRANSFER', 'BANK_TRANSFER')
       -- a QA sandbox reset restarts the limits
       AND t.created_at > COALESCE((SELECT u.history_cleared_at FROM users u
                                    JOIN accounts a ON a.user_id = u.id WHERE a.id = $1), '-infinity')
       AND t.created_at >= LEAST(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2,
                                 now() - make_interval(secs => $3))`,
    [accountId, TIME_ZONE, WINDOW_SECONDS],
  );
  const row = rows[0];
  return {
    sentTodayCents: Number(row.sent_today_cents),
    recentCount: Number(row.recent_count),
    oldestRecentAt: row.oldest_recent_at,
    resetsAt: row.resets_at,
  };
}

async function accountIdFor(userId) {
  const { rows } = await pool.query('SELECT id FROM accounts WHERE user_id = $1', [userId]);
  if (!rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  return rows[0].id;
}

/**
 * Reject a new outgoing transfer of `amountCents` if it breaks a rule:
 *   429 TOO_MANY_TRANSFERS   - already MAX_TRANSFERS_PER_WINDOW transfers in the last WINDOW_SECONDS
 *   400 DAILY_LIMIT_EXCEEDED - today's sent total + this amount would be over ₱50,000
 */
async function assertWithinLimits(userId, amountCents) {
  const usage = await getUsage(await accountIdFor(userId));

  if (usage.recentCount >= MAX_TRANSFERS_PER_WINDOW) {
    const freeAt = new Date(usage.oldestRecentAt).getTime() + WINDOW_SECONDS * 1000;
    const retryAfterSeconds = Math.max(1, Math.ceil((freeAt - Date.now()) / 1000));
    throw tooManyRequests(
      'TOO_MANY_TRANSFERS',
      `Too many transfers. You can make at most ${MAX_TRANSFERS_PER_WINDOW} transfers every ${WINDOW_SECONDS} seconds. ` +
        `Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    )
      .withDetails({ maxTransfers: MAX_TRANSFERS_PER_WINDOW, windowSeconds: WINDOW_SECONDS, retryAfterSeconds })
      .withHeaders({ 'Retry-After': String(retryAfterSeconds) });
  }

  if (usage.sentTodayCents + amountCents > DAILY_LIMIT_CENTS) {
    const remainingCents = Math.max(0, DAILY_LIMIT_CENTS - usage.sentTodayCents);
    throw badRequest('DAILY_LIMIT_EXCEEDED', 'Daily transaction limit of ₱50,000 exceeded.').withDetails({
      dailyLimit: fromCents(DAILY_LIMIT_CENTS),
      sentToday: fromCents(usage.sentTodayCents),
      remainingToday: fromCents(remainingCents),
      requested: fromCents(amountCents),
      resetsAt: usage.resetsAt,
    });
  }
}

/** For GET /api/transfers/limits: the rules and how much of today's limit is left. */
async function getLimits(userId) {
  const usage = await getUsage(await accountIdFor(userId));
  return {
    daily: {
      limit: fromCents(DAILY_LIMIT_CENTS),
      sentToday: fromCents(usage.sentTodayCents),
      remaining: fromCents(Math.max(0, DAILY_LIMIT_CENTS - usage.sentTodayCents)),
      resetsAt: usage.resetsAt,
    },
    rateLimit: {
      maxTransfers: MAX_TRANSFERS_PER_WINDOW,
      windowSeconds: WINDOW_SECONDS,
      transfersInWindow: usage.recentCount,
    },
  };
}

module.exports = {
  assertWithinLimits,
  getLimits,
  DAILY_LIMIT_CENTS,
  MAX_TRANSFERS_PER_WINDOW,
  WINDOW_SECONDS,
};
