// ISO 20022 Message Inspector: a pacs.008.001.08 message for any credit transfer in the ledger.
//
//   BANK_TRANSFER                            -> the message the payment switch actually sent
//                                               (stored in payment_messages, see paymentSwitch)
//   TRANSFER, BILL_PAYMENT, LOAD_PURCHASE    -> serialised from the transaction's double-entry
//                                               ledger entries: the debited customer wallet is the
//                                               debtor, the amount is what left it minus any fee,
//                                               and the fee is the credit to SYS-FEE-INCOME. These
//                                               settle on PayPulse's own books (SttlmMtd INDA).
//
// Identifiers are derived from the transaction, so the same transaction always yields the same
// MsgId / UETR / EndToEndId (the message is a deterministic view of the ledger, not a new payment).
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { buildPacs008, toXml, MESSAGE_TYPE } = require('./iso20022');
const { PAYPULSE_BIC } = require('./banks');
const { findBiller } = require('./billers');
const telcos = require('./telcos');
const paymentSwitch = require('./paymentSwitch');
const { formatReference } = require('./receiptService');
const { shortName } = require('../utils/privacy');
const { notFound, unprocessable } = require('../utils/errors');

const FEE_ACCOUNT = 'SYS-FEE-INCOME';
const LOCAL_INSTRUMENT = { TRANSFER: 'CTR', BILL_PAYMENT: 'BILLPAY', LOAD_PURCHASE: 'PREPAIDLOAD' };

/** Stable identifiers for transaction `id`: MsgId (≤35 chars) and a UUID v4-shaped UETR. */
function identifiersFor(id, createdAt) {
  const stamp = new Date(createdAt).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const hex = crypto.createHash('sha256').update(`paypulse-tx-${id}-${stamp}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return {
    msgId: `PAYP${stamp}TX${String(id).padStart(8, '0')}`,
    uetr: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
}

/** The other side of a bill payment / load purchase (the ledger only knows the settlement account). */
async function externalCreditor(type, id) {
  if (type === 'BILL_PAYMENT') {
    const { rows } = await pool.query('SELECT biller_code, account_ref FROM bill_payments WHERE transaction_id = $1', [id]);
    const bill = rows[0];
    return {
      name: findBiller(bill?.biller_code)?.name ?? bill?.biller_code ?? 'Biller',
      account: bill?.account_ref ?? 'BILLER',
      remittance: 'Bills payment',
      reference: (createdAt) => formatReference(id, createdAt).replace(/^REF-/, 'REF-BILL-'),
    };
  }
  const { rows } = await pool.query('SELECT brand, mobile_number, product_name FROM load_purchases WHERE transaction_id = $1', [id]);
  const load = rows[0];
  return {
    name: `${telcos.BRANDS[load?.brand]?.name ?? load?.brand ?? 'Telco'} prepaid`,
    account: load?.mobile_number ?? 'TELCO',
    remittance: load ? `Prepaid load: ${load.product_name}` : 'Prepaid load',
    reference: (createdAt) => formatReference(id, createdAt).replace(/^REF-/, 'REF-LOAD-'),
  };
}

/**
 * The pacs.008 for transaction `transactionId`, if the user is a party to it.
 * @returns {{ messageType, msgId, uetr, endToEndId, rail, status, source, json, xml }}
 */
async function getTransactionMessage(userId, transactionId) {
  const id = Number(transactionId);
  const notYours = () => notFound('TRANSACTION_NOT_FOUND', 'Transaction not found');
  if (!Number.isInteger(id) || id <= 0) throw notYours();

  const { rows: entries } = await pool.query(
    `SELECT le.direction, le.amount_cents, a.account_number, a.user_id, u.full_name,
            t.type, t.description, t.created_at
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     JOIN accounts a ON a.id = le.account_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE le.transaction_id = $1
     ORDER BY le.id`,
    [id],
  );
  if (!entries.some((e) => e.user_id === userId)) throw notYours();
  const { type, description, created_at: createdAt } = entries[0];

  if (type === 'BANK_TRANSFER') {
    const stored = await paymentSwitch.getMessage(userId, id);
    const { rows } = await pool.query('SELECT end_to_end_id FROM payment_messages WHERE msg_id = $1', [stored.msgId]);
    return { ...stored, endToEndId: rows[0]?.end_to_end_id ?? null, source: 'PAYMENT_SWITCH' };
  }
  if (!LOCAL_INSTRUMENT[type]) {
    throw unprocessable('NOT_A_CREDIT_TRANSFER', `A ${type} transaction has no pacs.008 credit transfer message`);
  }

  // Ledger -> message: debtor = the customer wallet that was debited; fee = credit to fee income.
  const debit = entries.find((e) => e.direction === 'DEBIT' && e.user_id);
  if (!debit) throw unprocessable('NOT_A_CREDIT_TRANSFER', 'No customer account was debited by this transaction');
  const feeCents = entries
    .filter((e) => e.direction === 'CREDIT' && e.account_number === FEE_ACCOUNT)
    .reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const totalDebitCents = entries
    .filter((e) => e.direction === 'DEBIT' && e.account_number === debit.account_number)
    .reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const amountCents = totalDebitCents - feeCents;

  // Your own name in full, the other party's shortened (as on the receipt).
  const nameOf = (entry) => (entry.user_id === userId ? entry.full_name : shortName(entry.full_name));
  let creditor;
  let endToEndId = formatReference(id, createdAt);
  let remittance = description || undefined;
  if (type === 'TRANSFER') {
    const credit = entries.find((e) => e.direction === 'CREDIT' && e.account_number !== FEE_ACCOUNT);
    creditor = { name: credit.full_name ? nameOf(credit) : credit.account_number, account: credit.account_number, bic: PAYPULSE_BIC };
  } else {
    const ext = await externalCreditor(type, id);
    creditor = { name: ext.name, account: ext.account, bic: PAYPULSE_BIC };
    endToEndId = ext.reference(createdAt);
    remittance = remittance || ext.remittance;
  }

  const { msgId, uetr } = identifiersFor(id, createdAt);
  const document = buildPacs008({
    msgId,
    uetr,
    instructionId: `TX-${String(id).padStart(8, '0')}`,
    endToEndId,
    localInstrument: LOCAL_INSTRUMENT[type],
    createdAt,
    settlementDate: createdAt,
    amountCents,
    feeCents,
    debtor: { name: nameOf(debit), account: debit.account_number },
    creditor,
    remittance,
  });
  return {
    messageType: MESSAGE_TYPE,
    msgId,
    uetr,
    endToEndId,
    rail: 'ON_US',
    status: 'SETTLED',
    source: 'LEDGER',
    json: document,
    xml: toXml(document),
  };
}

module.exports = { getTransactionMessage };
