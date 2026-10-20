// Payment switch: hands an outbound bank transfer to its clearing rail as an ISO 20022 pacs.008
// message and records that message.
//   INSTAPAY -> accepted and settled immediately (status SETTLED)
//   PESONET  -> queued for the next batch cut-off (status QUEUED, see pesonetService)
const { pool } = require('../db/pool');
const { buildPacs008, toXml, newIdentifiers, MESSAGE_TYPE } = require('./iso20022');
const { nextCutoff } = require('./pesonetService');
const { notFound } = require('../utils/errors');

/**
 * Build, store and "send" the pacs.008 for a bank transfer, inside the transfer's transaction.
 * @returns {{ msgId, uetr, status, settlementDate }}
 */
async function submitOutbound(client, t) {
  const createdAt = new Date();
  const { msgId, uetr } = newIdentifiers(createdAt);
  const settlementDate = t.rail === 'PESONET' ? nextCutoff(createdAt) : createdAt;
  const status = t.rail === 'PESONET' ? 'QUEUED' : 'SETTLED';

  const document = buildPacs008({
    msgId,
    uetr,
    instructionId: t.bankReference,
    endToEndId: t.reference,
    rail: t.rail,
    createdAt,
    settlementDate,
    amountCents: t.amountCents,
    feeCents: t.feeCents,
    debtor: t.debtor,
    creditor: t.creditor,
    remittance: t.remittance,
  });

  await client.query(
    `INSERT INTO payment_messages
       (bank_transfer_id, message_type, msg_id, end_to_end_id, uetr, rail, status, payload_json, payload_xml)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [t.bankTransferId, MESSAGE_TYPE, msgId, t.reference, uetr, t.rail, status, document, toXml(document)],
  );
  return { msgId, uetr, status, settlementDate };
}

/** The stored pacs.008 for one of the user's own bank transfers (by transaction id). */
async function getMessage(userId, transactionId) {
  const id = Number(transactionId);
  const { rows } = Number.isInteger(id) && id > 0
    ? await pool.query(
        `SELECT pm.message_type, pm.msg_id, pm.uetr, pm.rail, pm.status, pm.payload_json, pm.payload_xml
         FROM payment_messages pm
         JOIN bank_transfers bt ON bt.id = pm.bank_transfer_id
         WHERE bt.transaction_id = $1 AND bt.user_id = $2`,
        [id, userId],
      )
    : { rows: [] };
  if (!rows[0]) throw notFound('PAYMENT_MESSAGE_NOT_FOUND', 'No ISO 20022 message for this transaction');
  const m = rows[0];
  return {
    messageType: m.message_type,
    msgId: m.msg_id,
    uetr: m.uetr,
    rail: m.rail,
    status: m.status,
    json: m.payload_json,
    xml: m.payload_xml,
  };
}

module.exports = { submitOutbound, getMessage };
