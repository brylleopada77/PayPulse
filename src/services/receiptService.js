const { pool } = require('../db/pool');
const { findBank } = require('./banks');
const { findBiller } = require('./billers');
const { nextCutoff } = require('./pesonetService');
const { notFound } = require('../utils/errors');
const { fromCents } = require('../utils/money');
const { maskAccount, shortName } = require('../utils/privacy');

const MANILA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Human-friendly reference for a transaction: REF-<date in Manila>-<transaction id>,
 * e.g. REF-20261015-0981. Unique (the id is unique) and always the same for a transaction.
 */
function formatReference(transactionId, createdAt) {
  const date = MANILA_DATE.format(new Date(createdAt)).replaceAll('-', '');
  return `REF-${date}-${String(transactionId).padStart(4, '0')}`;
}

/** The reference of a transaction that was just written (inside or outside a db transaction). */
async function referenceFor(db, transactionId) {
  const { rows } = await db.query('SELECT created_at FROM transactions WHERE id = $1', [transactionId]);
  return formatReference(transactionId, rows[0].created_at);
}

/**
 * Everything the receipt modal shows for one transaction, from the point of view of `userId`.
 * Only works for transactions that touched the user's own wallet (otherwise 404).
 */
async function getReceipt(userId, transactionId) {
  const id = Number(transactionId);
  const notYours = () => notFound('RECEIPT_NOT_FOUND', 'Transaction not found');
  if (!Number.isInteger(id) || id <= 0) throw notYours();

  const { rows: entries } = await pool.query(
    `SELECT le.direction, le.amount_cents, a.account_number, a.is_system, a.user_id, a.savings_owner_id,
            u.full_name, t.type, t.description, t.created_at
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     JOIN accounts a ON a.id = le.account_id
     LEFT JOIN users u ON u.id = COALESCE(a.user_id, a.savings_owner_id)
     WHERE le.transaction_id = $1
     ORDER BY le.id`,
    [id],
  );
  // The user's wallet entry; for savings interest (which never touches the wallet), their vault's.
  const mine = entries.find((e) => e.user_id === userId) ?? entries.find((e) => e.savings_owner_id === userId);
  if (!mine) throw notYours();

  const { type, description, created_at: createdAt } = mine;
  // Your own name is shown in full, the other party's shortened.
  const party = (entry) => ({
    name: entry.user_id === userId ? entry.full_name : shortName(entry.full_name),
    account: entry.account_number,
  });

  const receipt = {
    transactionId: id,
    reference: formatReference(id, createdAt),
    type,
    direction: mine.direction === 'DEBIT' ? 'SENT' : 'RECEIVED',
    status: 'SUCCESSFUL',
    createdAt,
  };

  if (type === 'SAVINGS_TRANSFER') {
    // Between the user's own wallet and PayPulse Save vault.
    const { rows: vault } = await pool.query(
      'SELECT account_number FROM accounts WHERE savings_owner_id = $1',
      [userId],
    );
    const wallet = { name: `${mine.full_name} (Main Wallet)`, account: mine.account_number };
    const save = { name: `${mine.full_name} (PayPulse Save)`, account: vault[0]?.account_number ?? 'PayPulse Save' };
    const toSavings = mine.direction === 'DEBIT';
    return {
      ...receipt,
      title: toSavings ? 'Moved to PayPulse Save' : 'Withdrawn from PayPulse Save',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: toSavings ? wallet : save,
      recipient: toSavings ? save : wallet,
      bankName: 'PayPulse',
    };
  }

  if (type === 'DEPOSIT') {
    const { rows } = await pool.query('SELECT payment_id FROM payments WHERE transaction_id = $1', [id]);
    return {
      ...receipt,
      title: 'Top-up Successful',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: { name: 'Card payment', account: rows[0]?.payment_id ?? 'External funding' },
      recipient: party(mine),
      bankName: 'PayPulse',
    };
  }

  if (type === 'INTEREST') {
    const { rows } = await pool.query(
      `SELECT accrual_date::text AS day, rate_bps FROM savings_interest_accruals WHERE transaction_id = $1`,
      [id],
    );
    const accrual = rows[0];
    return {
      ...receipt,
      title: 'Savings Interest Earned',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: { name: 'PayPulse (interest)', account: 'PayPulse Save' },
      recipient: { name: `${mine.full_name} (PayPulse Save)`, account: mine.account_number },
      bankName: 'PayPulse',
      note: accrual
        ? `Interest for ${accrual.day} at ${(accrual.rate_bps / 100).toFixed(2)}% p.a., added to PayPulse Save`
        : 'Added to PayPulse Save',
    };
  }

  if (type === 'CARD_PAYMENT') {
    const { rows } = await pool.query(
      `SELECT cp.merchant, cp.auth_code, vc.bin, vc.last4
       FROM card_payments cp JOIN virtual_cards vc ON vc.id = cp.card_id WHERE cp.transaction_id = $1`,
      [id],
    );
    const cp = rows[0];
    return {
      ...receipt,
      title: 'Card Payment Approved',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: { name: `${mine.full_name} (Virtual Visa)`, account: cp ? `${cp.bin.slice(0, 4)} •••• ${cp.last4}` : 'Virtual Visa' },
      recipient: { name: cp?.merchant ?? 'Merchant', account: 'Online purchase' },
      bankName: 'PayPulse Visa',
      note: cp ? `Authorization code ${cp.auth_code}` : null,
    };
  }

  if (type === 'BILL_PAYMENT' || type === 'CASHBACK') {
    const isBill = type === 'BILL_PAYMENT';
    const { rows } = await pool.query(
      `SELECT bp.*, t.created_at AS paid_at FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id
       WHERE ${isBill ? 'bp.transaction_id' : 'bp.cashback_transaction_id'} = $1`,
      [id],
    );
    const bill = rows[0];
    const billerName = findBiller(bill?.biller_code)?.name ?? bill?.biller_code ?? 'Biller';
    const billRef = bill ? formatReference(bill.transaction_id, bill.paid_at).replace(/^REF-/, 'REF-BILL-') : null;
    if (isBill) {
      return {
        ...receipt,
        reference: billRef,
        title: 'Bills Payment Successful',
        amount: fromCents(Number(bill.amount_cents)),
        fee: fromCents(Number(bill.fee_cents)),
        total: fromCents(Number(bill.amount_cents) + Number(bill.fee_cents)),
        sender: party(mine),
        recipient: { name: billerName, account: bill.account_ref },
        bankName: 'PayPulse Bills Payment',
        biller: {
          code: bill.biller_code,
          name: billerName,
          category: findBiller(bill.biller_code)?.category ?? null,
          accountNumber: bill.account_ref,
          accountName: bill.account_name,
        },
        cashback: Number(bill.cashback_cents) > 0 ? fromCents(Number(bill.cashback_cents)) : null,
      };
    }
    return {
      ...receipt,
      title: 'Cashback Received',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: { name: 'PayPulse Rewards', account: 'Bills Payment Cashback' },
      recipient: party(mine),
      bankName: 'PayPulse',
      note: billRef ? `For ${billerName} bill ${billRef}` : 'Bills Payment Cashback',
    };
  }

  if (type === 'LOAN_DISBURSEMENT' || type === 'LOAN_REPAYMENT') {
    const disbursed = type === 'LOAN_DISBURSEMENT';
    const { rows } = await pool.query(
      disbursed
        ? `SELECT l.id, l.term_months, NULL::bigint AS principal_cents, NULL::bigint AS interest_cents
           FROM loans l WHERE l.disbursement_transaction_id = $1`
        : `SELECT l.id, l.term_months, p.principal_cents, p.interest_cents
           FROM loan_payments p JOIN loans l ON l.id = p.loan_id WHERE p.transaction_id = $1`,
      [id],
    );
    const loan = rows[0];
    const lender = { name: 'PayPulse Instant Loan', account: loan ? `LOAN-${String(loan.id).padStart(6, '0')}` : 'Instant Loan' };
    return {
      ...receipt,
      title: disbursed ? 'Loan Disbursed' : 'Loan Repayment Successful',
      amount: fromCents(mine.amount_cents),
      fee: fromCents(0),
      total: fromCents(mine.amount_cents),
      sender: disbursed ? lender : party(mine),
      recipient: disbursed ? party(mine) : lender,
      bankName: 'PayPulse',
      note: disbursed
        ? `${loan?.term_months ?? ''}-month Instant Loan`
        : `Interest ₱${fromCents(Number(loan?.interest_cents ?? 0))} · principal ₱${fromCents(Number(loan?.principal_cents ?? 0))}`,
    };
  }

  if (type === 'BANK_TRANSFER') {
    const { rows } = await pool.query(
      `SELECT bt.*, pm.msg_id, pm.uetr
       FROM bank_transfers bt LEFT JOIN payment_messages pm ON pm.bank_transfer_id = bt.id
       WHERE bt.transaction_id = $1`,
      [id],
    );
    const bt = rows[0];
    const queued = bt.status === 'QUEUED';
    return {
      ...receipt,
      title: queued ? 'Transfer Submitted' : 'Transfer Successful',
      status: queued ? 'PENDING_SETTLEMENT' : 'SUCCESSFUL',
      amount: fromCents(bt.amount_cents),
      fee: fromCents(bt.fee_cents),
      total: fromCents(Number(bt.amount_cents) + Number(bt.fee_cents)),
      sender: party(mine),
      recipient: { name: bt.account_name, account: maskAccount(bt.account_number) },
      bankName: findBank(bt.bank_code)?.name ?? bt.bank_code,
      bankReference: bt.reference,
      rail: bt.rail,
      settlement: {
        status: bt.status,
        settledAt: bt.settled_at,
        batchId: bt.batch_id,
        expectedAt: queued ? nextCutoff() : null,
      },
      iso20022: bt.msg_id ? { messageType: 'pacs.008.001.08', msgId: bt.msg_id, uetr: bt.uetr } : null,
    };
  }

  // TRANSFER (Express Send): one DEBIT (sender) and one CREDIT (recipient) entry.
  const debit = entries.find((e) => e.direction === 'DEBIT');
  const credit = entries.find((e) => e.direction === 'CREDIT');
  const defaultDescription = `Transfer to ${credit.account_number}`;
  return {
    ...receipt,
    title: receipt.direction === 'SENT' ? 'Transfer Successful' : 'Money Received',
    amount: fromCents(mine.amount_cents),
    fee: fromCents(0),
    total: fromCents(mine.amount_cents),
    sender: party(debit),
    recipient: party(credit),
    bankName: 'PayPulse',
    note: description && description !== defaultDescription ? description : null,
  };
}

module.exports = { getReceipt, formatReference, referenceFor };
