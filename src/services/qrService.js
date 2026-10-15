const QRCode = require('qrcode');
const { pool } = require('../db/pool');
const { buildPayload, parsePayload } = require('../utils/qrph');
const { toCents, fromCents } = require('../utils/money');
const { shortName } = require('../utils/privacy');
const { notFound } = require('../utils/errors');

/** "Receive via QR": the user's own QR Ph code (optionally for a fixed amount) as text + SVG. */
async function getMyQr(userId, amount) {
  const { rows } = await pool.query(
    `SELECT a.account_number, u.full_name
     FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  const { account_number: accountNumber, full_name: fullName } = rows[0];

  const fixedAmount = amount === undefined || amount === null || amount === '' ? null : fromCents(toCents(amount));
  const payload = buildPayload({ accountNumber, name: fullName, amount: fixedAmount });
  const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#1b1d2a', light: '#ffffff' } });
  return { accountNumber, name: fullName, amount: fixedAmount, payload, svg };
}

/**
 * "Scan QR": read a QR Ph text (or a plain account number) and look up the PayPulse wallet it
 * points to, so the Send form can be filled in. The receiver's name is shortened ("Maria S.").
 */
async function decode(userId, payload) {
  const parsed = parsePayload(payload);
  const { rows } = await pool.query(
    `SELECT a.account_number, u.full_name, u.id AS user_id
     FROM accounts a JOIN users u ON u.id = a.user_id
     WHERE a.account_number = $1 AND a.is_system = false`,
    [parsed.accountNumber],
  );
  if (!rows[0]) throw notFound('RECEIVER_NOT_FOUND', 'No PayPulse account matches this QR code');

  return {
    format: parsed.format,
    accountNumber: rows[0].account_number,
    receiverName: shortName(rows[0].full_name),
    amount: parsed.amount,
    isOwnAccount: rows[0].user_id === userId,
  };
}

module.exports = { getMyQr, decode };
