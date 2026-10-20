// QR Ph (mock) for PayPulse P2P transfers, in the EMVCo merchant-presented QR layout that
// QR Ph uses: a list of ID(2) + LENGTH(2) + VALUE fields, ending with a CRC-16 checksum.
//
//   00 Payload format          "01"
//   01 Initiation method       "11" static (no amount) | "12" dynamic (amount included)
//   27 Merchant account info   00 "com.p2pqrpay" (QR Ph P2P id), 01 "PAYPPHM2XXX" (mock PayPulse code),
//                              03 PayPulse account number
//   52 Category code           "6016"
//   53 Currency                "608" (PHP)
//   54 Amount                  optional, e.g. "250.00"
//   58 Country                 "PH"
//   59 Account holder name     max 25 characters
//   60 City                    "MANILA"
//   63 CRC                     CRC-16/CCITT-FALSE over everything before it, incl. "6304"
const { badRequest } = require('./errors');

const P2P_GUID = 'com.p2pqrpay';
const PAYPULSE_CODE = 'PAYPPHM2XXX';
const ACCOUNT_PATTERN = /^PP\d{6,}$/;

const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as used by EMVCo QR. 4 uppercase hex chars. */
function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Build the QR Ph text for receiving money into `accountNumber` (optionally with a fixed amount). */
function buildPayload({ accountNumber, name, amount }) {
  const merchant = field('00', P2P_GUID) + field('01', PAYPULSE_CODE) + field('03', accountNumber);
  const cleanName = name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').toUpperCase().slice(0, 25) || 'PAYPULSE USER';
  const body =
    field('00', '01') +
    field('01', amount ? '12' : '11') +
    field('27', merchant) +
    field('52', '6016') +
    field('53', '608') +
    (amount ? field('54', amount) : '') +
    field('58', 'PH') +
    field('59', cleanName) +
    field('60', 'MANILA') +
    '6304';
  return body + crc16(body);
}

/** Split "ID LEN VALUE..." into { id: value }. Returns null if the lengths don't add up. */
function parseFields(text) {
  const fields = {};
  let i = 0;
  while (i < text.length) {
    const id = text.slice(i, i + 2);
    const length = Number(text.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(length) || i + 4 + length > text.length) return null;
    fields[id] = text.slice(i + 4, i + 4 + length);
    i += 4 + length;
  }
  return fields;
}

const invalid = (message = 'This is not a valid PayPulse QR Ph code') => badRequest('INVALID_QR', message);

/**
 * Read a scanned QR text. Accepts a QR Ph payload, or (for manual entry) a plain PayPulse account
 * number. Returns { format, accountNumber, name, amount }; throws 400 INVALID_QR / QR_CHECKSUM_MISMATCH.
 */
function parsePayload(input) {
  if (typeof input !== 'string' || input.trim() === '') throw invalid('Enter or scan a QR code');
  const text = input.trim();

  if (ACCOUNT_PATTERN.test(text.toUpperCase())) {
    return { format: 'ACCOUNT_NUMBER', accountNumber: text.toUpperCase(), name: null, amount: null };
  }

  const fields = parseFields(text);
  if (!fields || fields['00'] !== '01' || !fields['63']) throw invalid();
  if (crc16(text.slice(0, -4)) !== text.slice(-4).toUpperCase()) {
    throw badRequest('QR_CHECKSUM_MISMATCH', 'The QR code is damaged or was edited (checksum does not match)');
  }
  if (fields['53'] !== '608' || fields['58'] !== 'PH') throw invalid('Only Philippine peso QR Ph codes are supported');

  const merchant = parseFields(fields['27'] || '');
  if (!merchant || merchant['00'] !== P2P_GUID) throw invalid('This QR code is not a QR Ph person-to-person code');
  if (merchant['01'] !== PAYPULSE_CODE) {
    throw badRequest('QR_NOT_SUPPORTED', 'This QR Ph code is from another bank or e-wallet. Use Bank Transfer instead.');
  }
  if (!ACCOUNT_PATTERN.test(merchant['03'] || '')) throw invalid();

  const amount = fields['54'] ?? null;
  if (amount !== null && !/^\d+(\.\d{1,2})?$/.test(amount)) throw invalid('The amount in this QR code is not valid');

  return { format: 'QR_PH', accountNumber: merchant['03'], name: fields['59'] ?? null, amount };
}

module.exports = { buildPayload, parsePayload, crc16 };
