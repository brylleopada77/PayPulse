// Virtual card engine (mock issuer). Cards are tokenized: every API response identifies a card by
// its token and shows only a masked PAN. The full PAN + CVV are only returned by reveal(), after
// the MPIN is checked, and never logged or cached.
const crypto = require('crypto');
const { pool } = require('../db/pool');
const mpinService = require('./mpinService');
const { encryptPan, decryptPan, fingerprint, deriveCvv, luhnCheckDigit, maskPan } = require('../utils/cardCrypto');
const { badRequest, conflict, notFound } = require('../utils/errors');

// Mock PayPulse Visa BIN (issuer identification number). Visa numbers start with 4.
const VISA_BIN = '484735';
const MAX_CARDS = 3;
const VALID_YEARS = 3;

/** A new 16-digit Visa PAN: BIN (6) + random account digits (9) + Luhn check digit (1). */
function newPan() {
  let body = VISA_BIN;
  while (body.length < 15) body += crypto.randomInt(0, 10);
  return body + luhnCheckDigit(body);
}

/** The public (PCI-safe) view of a card: token, masked PAN, last 4, expiry, status. */
function toPublic(row) {
  return {
    token: row.token,
    brand: row.brand,
    maskedPan: maskPan(row.bin, row.last4),
    last4: row.last4,
    expiry: `${String(row.expiry_month).padStart(2, '0')}/${String(row.expiry_year).slice(-2)}`,
    cardholderName: row.cardholder_name,
    status: row.status,
    linkedAccount: row.account_number,
    createdAt: row.created_at,
  };
}

const SELECT_CARD = `
  SELECT vc.*, a.account_number FROM virtual_cards vc JOIN accounts a ON a.id = vc.account_id`;

/** Issue a new virtual Visa card linked to the user's main wallet (MPIN required). */
async function generate(userId, { mpin } = {}) {
  await mpinService.verifyMpin(userId, mpin);

  const { rows: owner } = await pool.query(
    `SELECT a.id AS account_id, u.full_name,
            (SELECT COUNT(*)::int FROM virtual_cards WHERE user_id = u.id) AS cards
     FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  if (owner[0].cards >= MAX_CARDS) {
    throw conflict('CARD_LIMIT_REACHED', `You can have at most ${MAX_CARDS} virtual cards`);
  }

  const now = new Date();
  const expiryMonth = now.getUTCMonth() + 1;
  const expiryYear = now.getUTCFullYear() + VALID_YEARS;
  const name = owner[0].full_name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').toUpperCase().slice(0, 26);

  for (let attempt = 0; attempt < 5; attempt++) {
    const pan = newPan();
    const token = `card_${crypto.randomBytes(12).toString('base64url')}`;
    try {
      const { rows } = await pool.query(
        `INSERT INTO virtual_cards
           (token, user_id, account_id, bin, last4, pan_encrypted, pan_fingerprint, expiry_month, expiry_year, cardholder_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [token, userId, owner[0].account_id, pan.slice(0, 6), pan.slice(-4), encryptPan(pan), fingerprint(pan),
          expiryMonth, expiryYear, name],
      );
      if (rows[0]) return getCard(userId, token);
    } catch (err) {
      if (err.code !== '23505') throw err; // a PAN collision: try another number
    }
  }
  throw new Error('Could not generate a unique card number');
}

async function getCard(userId, token) {
  const { rows } = await pool.query(`${SELECT_CARD} WHERE vc.user_id = $1 AND vc.token = $2`, [userId, token]);
  if (!rows[0]) throw notFound('CARD_NOT_FOUND', 'Card not found');
  return toPublic(rows[0]);
}

async function listCards(userId) {
  const { rows } = await pool.query(`${SELECT_CARD} WHERE vc.user_id = $1 ORDER BY vc.id`, [userId]);
  return rows.map(toPublic);
}

/** Freeze or unfreeze a card. */
/**
 * Lock (FROZEN) or unlock (ACTIVE) a card. Locking is one tap (an emergency); UNLOCKING a locked card
 * needs the MPIN, so someone holding an unlocked phone can't undo the lock.
 */
async function setStatus(userId, token, status, mpin) {
  if (status !== 'ACTIVE' && status !== 'FROZEN') throw badRequest('INVALID_STATUS', 'status must be ACTIVE or FROZEN');
  if (status === 'ACTIVE') {
    const { rows } = await pool.query('SELECT status FROM virtual_cards WHERE user_id = $1 AND token = $2', [userId, token]);
    if (!rows[0]) throw notFound('CARD_NOT_FOUND', 'Card not found');
    if (rows[0].status === 'FROZEN') await mpinService.verifyMpin(userId, mpin);
  }
  const { rowCount } = await pool.query('UPDATE virtual_cards SET status = $3 WHERE user_id = $1 AND token = $2', [
    userId,
    token,
    status,
  ]);
  if (!rowCount) throw notFound('CARD_NOT_FOUND', 'Card not found');
  return getCard(userId, token);
}

/** Full card details for the cardholder only, after the MPIN. The CVV is derived, never stored. */
async function reveal(userId, token, { mpin } = {}) {
  await mpinService.verifyMpin(userId, mpin);
  const { rows } = await pool.query(`${SELECT_CARD} WHERE vc.user_id = $1 AND vc.token = $2`, [userId, token]);
  if (!rows[0]) throw notFound('CARD_NOT_FOUND', 'Card not found');
  const card = rows[0];
  const pan = decryptPan(card.pan_encrypted);
  return {
    ...toPublic(card),
    pan,
    cvv: deriveCvv(pan, card.expiry_month, card.expiry_year),
  };
}

module.exports = { generate, listCards, getCard, setStatus, reveal, VISA_BIN, MAX_CARDS };
