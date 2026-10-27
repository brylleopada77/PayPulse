// Pay Bills with the PayPulse ₱5.00 bills cashback.
//
// Bill payment:  DEBIT  customer wallet (GL 2010)                     bill amount
//                CREDIT Biller Settlement (GL 2040)                    bill amount
// Cashback:      DEBIT  Marketing Expense - Cashback (GL 5020)          ₱5.00
//                CREDIT customer wallet                                 ₱5.00
//
// Both journals are written in ONE database transaction under a lock on the wallet (walletLock.js),
// so the balance, limit and AML checks can't be raced and a payment never ends up without its cashback.
// Cashback guardrails (otherwise paying ₱1 "bills" would earn ₱4 each time): only on bills of
// ₱100 or more, and at most 3 cashbacks per customer per day (Manila).
const { pool } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { lockWallet, checkOutgoing, withPaymentTransaction } = require('./walletLock');
const { formatReference } = require('./receiptService');
const mpinService = require('./mpinService');
const { findBiller, catalog } = require('./billers');
const { badRequest, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');
const { maskAccount } = require('../utils/privacy');

const CASHBACK_CENTS = 500; // ₱5.00
const CASHBACK_MIN_BILL_CENTS = 10_000; // ₱100.00
const CASHBACK_DAILY_MAX = 3;
const MAX_BILL_CENTS = 5_000_000; // ₱50,000.00 per payment (the daily send limit applies too)
const FEE_CENTS = 0;
const TIME_ZONE = 'Asia/Manila';
const SETTLEMENT_ACCOUNT = 'SYS-BILLER-SETTLEMENT';
const CASHBACK_ACCOUNT = 'SYS-CASHBACK-EXPENSE';

/** REF-BILL-<date in Manila>-<transaction id>, e.g. REF-BILL-20261016-8812. */
const billReference = (transactionId, createdAt) => formatReference(transactionId, createdAt).replace(/^REF-/, 'REF-BILL-');

/** Cashbacks earned today (Manila), counting only after a QA sandbox reset. */
async function cashbacksToday(db, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM bill_payments bp JOIN users u ON u.id = bp.user_id
     WHERE bp.user_id = $1 AND bp.cashback_cents > 0
       AND bp.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
       AND bp.created_at > COALESCE(u.history_cleared_at, '-infinity')`,
    [userId, TIME_ZONE],
  );
  return rows[0].n;
}

function cashbackStatus(usedToday) {
  return {
    amount: fromCents(CASHBACK_CENTS),
    minBill: fromCents(CASHBACK_MIN_BILL_CENTS),
    dailyMax: CASHBACK_DAILY_MAX,
    usedToday,
    remainingToday: Math.max(0, CASHBACK_DAILY_MAX - usedToday),
  };
}

/** GET /api/v1/bills: categories, billers, fee and today's cashback status. */
async function getCatalog(userId) {
  return {
    ...catalog(),
    convenienceFee: fromCents(FEE_CENTS),
    maxAmount: fromCents(MAX_BILL_CENTS),
    cashback: cashbackStatus(await cashbacksToday(pool, userId)),
  };
}

function validate({ billerCode, accountNumber, accountName, amount }) {
  const biller = findBiller(String(billerCode || ''));
  if (!biller) throw badRequest('UNKNOWN_BILLER', 'Choose a biller from the list');

  const account = String(accountNumber ?? '').replace(/\s+/g, '').toUpperCase();
  if (!biller.pattern.test(account)) {
    throw badRequest('INVALID_BILLER_ACCOUNT', `Enter a valid ${biller.accountLabel} (${biller.hint})`).withDetails({
      field: 'accountNumber',
      accountLabel: biller.accountLabel,
      hint: biller.hint,
    });
  }

  const name = String(accountName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) {
    throw badRequest('INVALID_ACCOUNT_NAME', 'Enter the account name as it appears on the bill');
  }

  const amountCents = toCents(amount);
  if (amountCents > MAX_BILL_CENTS) {
    throw badRequest('BILL_AMOUNT_TOO_HIGH', `A single bill payment can be up to ₱${fromCents(MAX_BILL_CENTS)}`).withDetails({
      maxAmount: fromCents(MAX_BILL_CENTS),
    });
  }
  // Only the last 4 digits of a credit card number are ever stored or shown.
  return { biller, accountRef: biller.sensitive ? maskAccount(account) : account, name, amountCents };
}

const systemAccountId = async (client, accountNumber) =>
  (await client.query('SELECT id FROM accounts WHERE account_number = $1', [accountNumber])).rows[0].id;

/** POST /api/v1/bills/pay: pay the bill, then credit the cashback if it applies. Needs the MPIN. */
async function pay(userId, body = {}) {
  const { biller, accountRef, name, amountCents } = validate(body);
  await mpinService.verifyMpin(userId, body.mpin);

  return withPaymentTransaction(async (client) => {
    const { id: walletId, balanceCents: balanceBefore } = await lockWallet(client, userId);
    await checkOutgoing(client, userId, amountCents, 'POST /api/v1/bills/pay');
    if (balanceBefore < amountCents + FEE_CENTS) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this bill');
    }

    const transactionId = await recordTransaction(client, {
      type: 'BILL_PAYMENT',
      description: `Bill Payment - ${biller.name}`,
      entries: [
        { accountId: walletId, direction: 'DEBIT', amountCents },
        { accountId: await systemAccountId(client, SETTLEMENT_ACCOUNT), direction: 'CREDIT', amountCents },
      ],
    });

    // The wallet lock serialises this user's payments, so the daily count can't be raced.
    const usedToday = await cashbacksToday(client, userId);
    let cashbackReason = null;
    if (amountCents < CASHBACK_MIN_BILL_CENTS) cashbackReason = 'BELOW_MINIMUM';
    else if (usedToday >= CASHBACK_DAILY_MAX) cashbackReason = 'DAILY_LIMIT_REACHED';

    let cashbackTransactionId = null;
    if (!cashbackReason) {
      cashbackTransactionId = await recordTransaction(client, {
        type: 'CASHBACK',
        description: 'Cashback Reward - Bills Payment',
        entries: [
          { accountId: await systemAccountId(client, CASHBACK_ACCOUNT), direction: 'DEBIT', amountCents: CASHBACK_CENTS },
          { accountId: walletId, direction: 'CREDIT', amountCents: CASHBACK_CENTS },
        ],
      });
    }
    const cashbackCents = cashbackTransactionId ? CASHBACK_CENTS : 0;

    const { rows: [bill] } = await client.query(
      `INSERT INTO bill_payments (user_id, biller_code, account_ref, account_name, amount_cents, fee_cents,
                                  cashback_cents, transaction_id, cashback_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [userId, biller.code, accountRef, name, amountCents, FEE_CENTS, cashbackCents, transactionId, cashbackTransactionId],
    );
    const { rows: [tx] } = await client.query('SELECT created_at FROM transactions WHERE id = $1', [transactionId]);

    return {
      billPaymentId: bill.id,
      reference: billReference(transactionId, tx.created_at),
      status: 'PAID',
      biller: { code: biller.code, name: biller.name, category: biller.category },
      accountNumber: accountRef,
      accountName: name,
      amount: fromCents(amountCents),
      convenienceFee: fromCents(FEE_CENTS),
      cashback: {
        // Today's status first: its `amount` (the program's ₱5.00) must not hide what was earned.
        ...cashbackStatus(usedToday + (cashbackCents > 0 ? 1 : 0)),
        earned: cashbackCents > 0,
        amount: fromCents(cashbackCents),
        reason: cashbackReason,
      },
      transactionId,
      cashbackTransactionId,
      balanceAfter: fromCents(balanceBefore - amountCents - FEE_CENTS + cashbackCents),
      createdAt: bill.created_at,
    };
  });
}

module.exports = {
  getCatalog,
  pay,
  billReference,
  CASHBACK_CENTS,
  CASHBACK_MIN_BILL_CENTS,
  CASHBACK_DAILY_MAX,
  MAX_BILL_CENTS,
};
