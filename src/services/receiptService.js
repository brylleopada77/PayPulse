const { pool } = require('../db/pool');
const { findBank } = require('./banks');
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
    `SELECT le.direction, le.amount_cents, a.account_number, a.is_system, a.user_id, u.full_name,
            t.type, t.description, t.created_at
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     JOIN accounts a ON a.id = le.account_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE le.transaction_id = $1
     ORDER BY le.id`,
    [id],
  );
  const mine = entries.find((e) => e.user_id === userId);
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
