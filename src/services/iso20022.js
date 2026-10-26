// ISO 20022 translation layer: builds pacs.008.001.08 (FI-to-FI Customer Credit Transfer)
// messages for outbound bank transfers, as JSON (element names as in the XSD) and as XML.
//
// JSON convention: an element with attributes is { "@Ccy": "PHP", "#text": "500.00" };
// every other value is a child element. toXml() turns that into the standard XML document.
const crypto = require('crypto');
const { PAYPULSE_BIC } = require('./banks');

const NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08';
const MESSAGE_TYPE = 'pacs.008.001.08';

const amount = (cents) => ({ '@Ccy': 'PHP', '#text': (cents / 100).toFixed(2) });
const isoDate = (date) => new Date(date).toISOString().slice(0, 10);
const isoDateTime = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
// ISO 20022 Max35Text / Max140Text limits
const max = (text, length) => String(text).slice(0, length);

/** New message identifiers: MsgId (≤35 chars, unique per message) and UETR (UUID v4). */
function newIdentifiers(createdAt) {
  const stamp = new Date(createdAt).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return {
    msgId: `PAYP${stamp}${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    uetr: crypto.randomUUID(),
  };
}

/**
 * Build the pacs.008 document for one outbound credit transfer.
 *
 * @param {object} p
 * @param {string} p.msgId          GrpHdr/MsgId
 * @param {string} p.uetr           PmtId/UETR
 * @param {string} p.instructionId  PmtId/InstrId (our bank reference, BT-...)
 * @param {string} p.endToEndId     PmtId/EndToEndId (our transaction reference, REF-...)
 * @param {string} [p.rail]        'INSTAPAY' | 'PESONET' (clearing system); omitted for an on-us
 *                                  book transfer inside PayPulse (settled on our books: INDA)
 * @param {string} [p.localInstrument] PmtTpInf/LclInstrm/Prtry (default 'CTR')
 * @param {Date}   p.createdAt
 * @param {Date}   p.settlementDate interbank settlement date (PESONet: the batch date)
 * @param {number} p.amountCents    amount the creditor receives
 * @param {number} p.feeCents       charge taken from the debtor (ChrgBr DEBT)
 * @param {object} p.debtor         { name, account }
 * @param {object} p.creditor       { name, account, bic }
 * @param {string} [p.remittance]   unstructured remittance information
 */
function buildPacs008(p) {
  return {
    FIToFICstmrCdtTrf: {
      GrpHdr: {
        MsgId: max(p.msgId, 35),
        CreDtTm: isoDateTime(p.createdAt),
        NbOfTxs: '1',
        TtlIntrBkSttlmAmt: amount(p.amountCents),
        IntrBkSttlmDt: isoDate(p.settlementDate),
        SttlmInf: p.rail ? { SttlmMtd: 'CLRG', ClrSys: { Prtry: p.rail } } : { SttlmMtd: 'INDA' },
        InstgAgt: { FinInstnId: { BICFI: PAYPULSE_BIC } },
        InstdAgt: { FinInstnId: { BICFI: p.creditor.bic } },
      },
      CdtTrfTxInf: {
        PmtId: {
          InstrId: max(p.instructionId, 35),
          EndToEndId: max(p.endToEndId, 35),
          UETR: p.uetr,
        },
        PmtTpInf: {
          ...(p.rail && { SvcLvl: { Prtry: p.rail } }),
          LclInstrm: { Prtry: p.localInstrument ?? 'CTR' },
        },
        IntrBkSttlmAmt: amount(p.amountCents),
        ChrgBr: 'DEBT',
        ChrgsInf: {
          Amt: amount(p.feeCents),
          Agt: { FinInstnId: { BICFI: PAYPULSE_BIC } },
        },
        Dbtr: { Nm: max(p.debtor.name, 140) },
        DbtrAcct: { Id: { Othr: { Id: p.debtor.account } } },
        DbtrAgt: { FinInstnId: { BICFI: PAYPULSE_BIC } },
        CdtrAgt: { FinInstnId: { BICFI: p.creditor.bic } },
        Cdtr: { Nm: max(p.creditor.name, 140) },
        CdtrAcct: { Id: { Othr: { Id: p.creditor.account } } },
        ...(p.remittance && { RmtInf: { Ustrd: max(p.remittance, 140) } }),
      },
    },
  };
}

const escapeXml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function elementToXml(name, value, indent) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return `${pad}<${name}>${escapeXml(value)}</${name}>\n`;

  const attributes = Object.entries(value)
    .filter(([key]) => key.startsWith('@'))
    .map(([key, v]) => ` ${key.slice(1)}="${escapeXml(v)}"`)
    .join('');
  if ('#text' in value) return `${pad}<${name}${attributes}>${escapeXml(value['#text'])}</${name}>\n`;

  const children = Object.entries(value)
    .filter(([key]) => !key.startsWith('@'))
    .map(([key, v]) => elementToXml(key, v, indent + 1))
    .join('');
  return `${pad}<${name}${attributes}>\n${children}${pad}</${name}>\n`;
}

/** Serialise a pacs.008 JSON document as an ISO 20022 XML message. */
function toXml(document) {
  const [[root, body]] = Object.entries(document);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Document xmlns="${NAMESPACE}">\n` +
    elementToXml(root, body, 1) +
    '</Document>\n'
  );
}

module.exports = { buildPacs008, toXml, newIdentifiers, MESSAGE_TYPE, NAMESPACE };
