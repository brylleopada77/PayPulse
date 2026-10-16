// "Add money" through the MOCK payment provider (dev / QA / demo only: MOCK_PAYMENTS=true).
// Only ADMIN accounts can use it (the route requires the admin role): an operator adds demo money
// to their own wallet and sends it to testers.
//
// Nothing is charged here, so even for admins this channel must never be an unlimited money
// printer. Before any money is credited, every top-up passes these checks:
//   400 TOPUP_DAILY_LIMIT_EXCEEDED  more than ₱1,000,000 added today (Asia/Manila)
//   400 WALLET_LIMIT_EXCEEDED       wallet + PayPulse Save would hold more than ₱10,000,000
//   403 TRANSACTION_HELD_FOR_REVIEW account under compliance review, or a 6th top-up within a
//                                   minute (opens a TOPUP_VELOCITY alert)
// The checks and the credit run under a per-user advisory lock, so parallel requests can't slip
// past them (unlike the intentional race in Send).
//
// Real money must only come in through POST /api/webhooks/payments, signed by the provider.
const crypto = require('crypto');
const { pool } = require('../db/pool');
const paymentService = require('./paymentService');
const { AppError, badRequest } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

// Operator (admin) limits for funding a demo.
const DAILY_TOPUP_LIMIT_CENTS = 100_000_000; // ₱1,000,000 per day
const MAX_HOLDINGS_CENTS = 1_000_000_000; // ₱10,000,000 wallet + savings (room for the daily ₱1,000,000)
const TOPUP_VELOCITY_MAX = 5; // per minute
const TIME_ZONE = 'Asia/Manila';
const OUTCOMES = { approve: 'SUCCESS', decline: 'FAILED' };

const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/**
 * Today's mock top-ups, mock top-ups in the last minute, and what the customer holds now.
 * Only the MOCK channel counts towards the daily/velocity limits: money from a real provider
 * (signed webhook) was actually paid, and providers apply their own limits before charging.
 * The holding limit counts everything the customer holds (wallet + PayPulse Save).
 */
async function getUsage(db, userId) {
  const { rows } = await db.query(
    `WITH me AS (SELECT a.id AS wallet_id, u.history_cleared_at FROM accounts a JOIN users u ON u.id = a.user_id
                 WHERE a.user_id = $1)
     SELECT
       (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p, me
         WHERE p.account_id = me.wallet_id AND p.status = 'SUCCESS' AND p.payment_id LIKE 'mock-%'
           AND p.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
           AND p.created_at > COALESCE(me.history_cleared_at, '-infinity'))            AS added_today,
       (SELECT COUNT(*) FROM payments p, me
         WHERE p.account_id = me.wallet_id AND p.status = 'SUCCESS' AND p.payment_id LIKE 'mock-%'
           AND p.created_at > now() - interval '60 seconds'
           AND p.created_at > COALESCE(me.history_cleared_at, '-infinity'))            AS last_minute,
       (SELECT COALESCE(SUM(ab.balance_cents), 0) FROM account_balances ab
         JOIN accounts a ON a.id = ab.account_id
         WHERE a.user_id = $1 OR a.savings_owner_id = $1)                               AS holdings,
       (SELECT aml_status FROM users WHERE id = $1)                                     AS aml_status`,
    [userId, TIME_ZONE],
  );
  const r = rows[0];
  return {
    addedTodayCents: Number(r.added_today),
    lastMinute: Number(r.last_minute),
    holdingsCents: Number(r.holdings),
    amlStatus: r.aml_status,
  };
}

function held(details) {
  return new AppError(403, 'TRANSACTION_HELD_FOR_REVIEW', 'Transaction Held for Compliance Review', { details });
}

async function assertAllowed(db, userId, amountCents) {
  const usage = await getUsage(db, userId);

  if (usage.amlStatus === 'UNDER_REVIEW') {
    throw held({
      rule: 'ACCOUNT_UNDER_REVIEW',
      reason: 'This account is under compliance review. Top-ups are on hold until it is cleared.',
    });
  }
  if (usage.lastMinute >= TOPUP_VELOCITY_MAX) {
    const details = {
      rule: 'TOPUP_VELOCITY',
      reason: `More than ${TOPUP_VELOCITY_MAX} top-ups within 60 seconds.`,
      topUpsInWindow: usage.lastMinute + 1,
    };
    // The alert is written by checkout() AFTER this transaction rolls back, so it isn't lost.
    const err = held(details);
    err.openAlert = { rule: 'TOPUP_VELOCITY', amountCents, details };
    throw err;
  }
  if (usage.addedTodayCents + amountCents > DAILY_TOPUP_LIMIT_CENTS) {
    throw badRequest(
      'TOPUP_DAILY_LIMIT_EXCEEDED',
      `Daily top-up limit of ${peso(DAILY_TOPUP_LIMIT_CENTS)} exceeded.`,
    ).withDetails({
      dailyLimit: fromCents(DAILY_TOPUP_LIMIT_CENTS),
      addedToday: fromCents(usage.addedTodayCents),
      remainingToday: fromCents(Math.max(0, DAILY_TOPUP_LIMIT_CENTS - usage.addedTodayCents)),
      requested: fromCents(amountCents),
    });
  }
  if (usage.holdingsCents + amountCents > MAX_HOLDINGS_CENTS) {
    throw badRequest('WALLET_LIMIT_EXCEEDED', `Wallet limit of ${peso(MAX_HOLDINGS_CENTS)} exceeded.`).withDetails({
      walletLimit: fromCents(MAX_HOLDINGS_CENTS),
      currentHoldings: fromCents(usage.holdingsCents),
      roomLeft: fromCents(Math.max(0, MAX_HOLDINGS_CENTS - usage.holdingsCents)),
      requested: fromCents(amountCents),
    });
  }
}

/**
 * Mock checkout: simulates the provider's signed callback through the real webhook handler.
 * The limit checks run INSIDE that handler's database transaction, after a per-user transaction
 * advisory lock: one connection, and parallel top-ups for the same user queue up behind the lock.
 * (Holding a second connection while waiting for the handler's own would deadlock the pool.)
 */
async function checkout(userId, { amount, outcome = 'approve' } = {}) {
  const status = OUTCOMES[outcome];
  if (!status) throw badRequest('INVALID_OUTCOME', 'outcome must be "approve" or "decline"');
  const amountCents = toCents(amount);

  const { rows } = await pool.query('SELECT account_number FROM accounts WHERE user_id = $1', [userId]);
  const rawBody = JSON.stringify({
    paymentId: `mock-${crypto.randomUUID()}`,
    accountNumber: rows[0].account_number,
    amount: fromCents(amountCents),
    status,
  });

  try {
    return await paymentService.handlePaymentCallback(rawBody, paymentService.sign(rawBody), JSON.parse(rawBody), {
      beforeCredit: async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`topup:${userId}`]);
        if (status === 'SUCCESS') await assertAllowed(client, userId, amountCents);
      },
    });
  } catch (err) {
    if (err.openAlert) {
      // Opened outside the rolled-back transaction: the account goes under review.
      const { rows: alert } = await pool.query(
        `INSERT INTO compliance_alerts (user_id, rule, amount_cents, endpoint, details)
         VALUES ($1, $2, $3, 'POST /api/payments/mock-checkout', $4) RETURNING id`,
        [userId, err.openAlert.rule, err.openAlert.amountCents, err.openAlert.details],
      );
      await pool.query(`UPDATE users SET aml_status = 'UNDER_REVIEW' WHERE id = $1`, [userId]);
      err.details = { ...err.details, alertId: alert[0].id };
    }
    throw err;
  }
}

/** Limits for the UI (Add money screen, profile). */
async function getLimits(userId) {
  const usage = await getUsage(pool, userId);
  return {
    dailyLimit: fromCents(DAILY_TOPUP_LIMIT_CENTS),
    addedToday: fromCents(usage.addedTodayCents),
    remainingToday: fromCents(Math.max(0, DAILY_TOPUP_LIMIT_CENTS - usage.addedTodayCents)),
    walletLimit: fromCents(MAX_HOLDINGS_CENTS),
    currentHoldings: fromCents(usage.holdingsCents),
    roomLeft: fromCents(Math.max(0, MAX_HOLDINGS_CENTS - usage.holdingsCents)),
  };
}

module.exports = { checkout, getLimits, DAILY_TOPUP_LIMIT_CENTS, MAX_HOLDINGS_CENTS, TOPUP_VELOCITY_MAX };
