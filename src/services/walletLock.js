// Concurrency protection for money leaving a wallet (Express Send, Bank Transfer, Pay Bills,
// Buy Load, card payments).
//
// Every outgoing payment runs in ONE database transaction that starts by locking the payer's wallet
// row (SELECT ... FOR UPDATE). Simultaneous payments from the same wallet wait for each other, so
// each one reads the balance, today's usage and the AML counters only after the previous payment
// committed (or rolled back): the check and the ledger postings are atomic. Any failed check throws,
// and withTransaction rolls the whole transaction back (no ledger entry is written).
//
// Lock order is always wallet first; payments never lock two wallets, so they can't deadlock.
const { withTransaction } = require('../db/pool');
const { getBalanceCents } = require('./ledgerService');
const complianceService = require('./complianceService');
const limitsService = require('./limitsService');
const { notFound } = require('../utils/errors');

/**
 * Lock the customer wallet of `userId` in this transaction and return its id and balance.
 * (Balances are computed from the immutable ledger, view account_balances, so the row we lock is the
 * account itself: every other payment from this wallet locks the same row first.)
 */
async function lockWallet(client, userId) {
  const { rows } = await client.query(
    'SELECT id, account_number FROM accounts WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  if (!rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  return { ...rows[0], balanceCents: await getBalanceCents(client, rows[0].id) };
}

/**
 * Under the lock: the AML screen (403 TRANSACTION_HELD_FOR_REVIEW) and the limits (429 anti-spam,
 * 400 daily limit), on the transaction's own connection. The middlewares already ran them once to
 * fail fast; this run is the one that counts for simultaneous requests.
 */
async function checkOutgoing(client, userId, amountCents, endpoint) {
  await complianceService.screenTransfer(userId, amountCents, endpoint, client);
  await limitsService.assertWithinLimits(userId, amountCents, client);
}

/**
 * Run `work(client)` in a transaction; if it was held by AML, open the compliance alert after the
 * rollback (it can't be written inside the transaction that is being rolled back).
 */
async function withPaymentTransaction(work) {
  try {
    return await withTransaction(work);
  } catch (err) {
    await complianceService.openPendingAlert(err);
    throw err;
  }
}

module.exports = { lockWallet, checkOutgoing, withPaymentTransaction };
