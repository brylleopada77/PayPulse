// PayPulse Save: a savings vault per customer (GL 2030 Customer Savings Deposits), 6.00% p.a.
// Money moves between the main wallet (GL 2010) and the vault as SAVINGS_TRANSFER journals.
// Unlike Send, these moves lock both accounts first, so concurrent moves can't overdraw anything.
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction, getBalanceCents } = require('./ledgerService');
const { referenceFor } = require('./receiptService');
const { badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const DEFAULT_RATE_BPS = 600; // 6.00% per year

/** The user's vault account id, opening the vault on first use. */
async function ensureVault(db, userId) {
  const existing = await db.query('SELECT id FROM accounts WHERE savings_owner_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].id;
  await db.query(
    `INSERT INTO accounts (account_number, savings_owner_id, gl_code, interest_rate_bps, is_system)
     VALUES ('SV' || nextval('savings_account_seq')::text, $1, '2030', $2, false)
     ON CONFLICT (savings_owner_id) DO NOTHING`,
    [userId, DEFAULT_RATE_BPS],
  );
  const created = await db.query('SELECT id FROM accounts WHERE savings_owner_id = $1', [userId]);
  return created.rows[0].id;
}

/** Vault overview: balance, rate, interest earned, estimated daily interest, recent activity. */
async function getVault(userId) {
  const vaultId = await ensureVault(pool, userId);
  const { rows } = await pool.query(
    `SELECT a.account_number, a.interest_rate_bps, ab.balance_cents,
            COALESCE(SUM(i.posted_cents), 0)::bigint AS interest_posted_cents,
            MAX(i.accrual_date)::text AS last_accrual_date
     FROM accounts a
     JOIN account_balances ab ON ab.account_id = a.id
     LEFT JOIN savings_interest_accruals i ON i.account_id = a.id
     WHERE a.id = $1
     GROUP BY a.id, ab.balance_cents`,
    [vaultId],
  );
  const v = rows[0];
  const balanceCents = Number(v.balance_cents);
  const recent = await pool.query(
    `SELECT t.id, t.type, t.description, t.created_at, le.direction, le.amount_cents
     FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE le.account_id = $1 ORDER BY le.id DESC LIMIT 10`,
    [vaultId],
  );

  return {
    accountNumber: v.account_number,
    balance: fromCents(balanceCents),
    balanceCents,
    annualRate: (v.interest_rate_bps / 100).toFixed(2),
    interestEarned: fromCents(Number(v.interest_posted_cents)),
    estimatedDailyInterest: ((balanceCents * v.interest_rate_bps) / 10000 / 365 / 100).toFixed(4),
    lastAccrualDate: v.last_accrual_date,
    activity: recent.rows.map((r) => ({
      transactionId: r.id,
      type: r.type,
      direction: r.direction,
      amount: fromCents(Number(r.amount_cents)),
      description: r.description,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Move money between the wallet and the vault.
 * @param {'DEPOSIT' | 'WITHDRAW'} direction  DEPOSIT = wallet -> vault, WITHDRAW = vault -> wallet
 */
async function move(userId, direction, amount) {
  if (direction !== 'DEPOSIT' && direction !== 'WITHDRAW') throw badRequest('INVALID_DIRECTION', 'Unknown direction');
  const amountCents = toCents(amount);

  return withTransaction(async (client) => {
    const vaultId = await ensureVault(client, userId);
    const wallet = await client.query('SELECT id FROM accounts WHERE user_id = $1', [userId]);
    if (!wallet.rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    const walletId = wallet.rows[0].id;

    // Lock both accounts (always in id order, so two moves can't deadlock) before reading balances.
    await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[walletId, vaultId]]);
    const walletBalance = await getBalanceCents(client, walletId);
    const vaultBalance = await getBalanceCents(client, vaultId);

    const fromId = direction === 'DEPOSIT' ? walletId : vaultId;
    const toId = direction === 'DEPOSIT' ? vaultId : walletId;
    if (direction === 'DEPOSIT' && walletBalance < amountCents) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this amount');
    }
    if (direction === 'WITHDRAW' && vaultBalance < amountCents) {
      throw unprocessable('INSUFFICIENT_SAVINGS', 'Your PayPulse Save balance is too low for this amount');
    }

    const transactionId = await recordTransaction(client, {
      type: 'SAVINGS_TRANSFER',
      description: direction === 'DEPOSIT' ? 'Moved to PayPulse Save' : 'Withdrawn from PayPulse Save',
      entries: [
        { accountId: fromId, direction: 'DEBIT', amountCents },
        { accountId: toId, direction: 'CREDIT', amountCents },
      ],
    });

    const delta = direction === 'DEPOSIT' ? amountCents : -amountCents;
    return {
      direction,
      transactionId,
      reference: await referenceFor(client, transactionId),
      amount: fromCents(amountCents),
      walletBalance: fromCents(walletBalance - delta),
      savingsBalance: fromCents(vaultBalance + delta),
    };
  });
}

module.exports = { ensureVault, getVault, move, DEFAULT_RATE_BPS };
