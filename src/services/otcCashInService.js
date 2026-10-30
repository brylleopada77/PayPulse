/**
 * Over-the-counter cash-in.
 *
 *   1. The customer picks a partner and an amount: POST /api/v1/cash-in/otc returns a 12-digit
 *      payment code (11 random digits + a Luhn check digit), valid for 24 hours.
 *   2. At the counter the customer pays amount + the partner's fee in cash.
 *   3. The partner confirms (signed webhook, or the QA sandbox in tests): the wallet is credited the
 *      amount exactly once, as a DEPOSIT from SYS-EXTERNAL-FUNDING. The fee stays with the partner.
 *
 * A code that is past its expiry reads as EXPIRED and can no longer be paid.
 */
const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { CATEGORIES, PARTNERS, feeCents, feeLabel, findPartner } = require('./otcPartners');
const { badRequest, notFound, conflict, gone } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const MIN_CENTS = 10_000; // ₱100
const MAX_CENTS = 5_000_000; // ₱50,000 per code
const VALID_HOURS = 24;
const MAX_PENDING = 5; // unpaid codes at a time
const FUNDING_ACCOUNT_NUMBER = 'SYS-EXTERNAL-FUNDING';

/** Luhn check digit for a string of digits. */
function luhnDigit(digits) {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2 === 0) n *= 2;
    sum += n > 9 ? n - 9 : n;
  });
  return String((10 - (sum % 10)) % 10);
}

const isValidReference = (ref) => /^\d{12}$/.test(ref) && luhnDigit(ref.slice(0, 11)) === ref[11];

function newReference() {
  const body = String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 10 ** 10)).padStart(10, '0');
  return body + luhnDigit(body);
}

/** "882930194410" -> "8829 3019 4410" (how the code is printed and read out at the counter). */
const formatReference = (ref) => ref.replace(/(\d{4})(?=\d)/g, '$1 ');

function partnerView(p) {
  return { code: p.code, name: p.name, category: p.category, fee: p.fee, feeLabel: feeLabel(p), logo: p.logo, badge: p.badge };
}

function catalog() {
  return {
    categories: CATEGORIES,
    partners: PARTNERS.map(partnerView),
    minAmount: fromCents(MIN_CENTS),
    maxAmount: fromCents(MAX_CENTS),
    validHours: VALID_HOURS,
  };
}

function codeView(row) {
  const p = findPartner(row.partner_code);
  const total = Number(row.amount_cents) + Number(row.fee_cents);
  return {
    reference: row.reference,
    displayReference: formatReference(row.reference),
    partner: p ? partnerView(p) : { code: row.partner_code, name: row.partner_code },
    amount: fromCents(Number(row.amount_cents)),
    fee: fromCents(Number(row.fee_cents)),
    totalToPay: fromCents(total),
    status: row.status === 'PENDING' && new Date(row.expires_at) <= new Date() ? 'EXPIRED' : row.status,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    transactionId: row.transaction_id,
    createdAt: row.created_at,
  };
}

function validate({ partnerCode, amount } = {}) {
  const p = findPartner(partnerCode);
  if (!p) {
    throw badRequest('INVALID_PARTNER', 'Choose a cash-in partner from the list (GET /api/v1/cash-in/otc/partners)');
  }
  const amountCents = toCents(amount);
  if (amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
    throw badRequest('AMOUNT_OUT_OF_RANGE', 'Cash in from ₱100 to ₱50,000 per code')
      .withDetails({ minAmount: fromCents(MIN_CENTS), maxAmount: fromCents(MAX_CENTS) });
  }
  return { partner: p, amountCents, feeCents: feeCents(p, amountCents) };
}

/** Create a payment code for the caller. */
async function createCode(userId, body) {
  const { partner, amountCents, feeCents: fee } = validate(body);
  return withTransaction(async (client) => {
    // one at a time per user, so the pending-codes cap holds under parallel requests
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otc:${userId}`]);
    const pending = await client.query(
      `SELECT count(*)::int AS n FROM otc_cash_in_codes WHERE user_id = $1 AND status = 'PENDING' AND expires_at > now()`,
      [userId],
    );
    if (pending.rows[0].n >= MAX_PENDING) {
      throw conflict('TOO_MANY_PENDING_CODES', `You already have ${MAX_PENDING} unpaid cash-in codes. Pay one or wait for it to expire.`);
    }
    for (let attempt = 0; ; attempt += 1) {
      const { rows } = await client.query(
        `INSERT INTO otc_cash_in_codes (user_id, partner_code, reference, amount_cents, fee_cents, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         ON CONFLICT (reference) DO NOTHING
         RETURNING *`,
        [userId, partner.code, newReference(), amountCents, fee, VALID_HOURS],
      );
      if (rows[0]) return codeView(rows[0]);
      if (attempt >= 5) throw new Error('Could not allocate a unique cash-in reference');
    }
  });
}

async function listCodes(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM otc_cash_in_codes WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20',
    [userId],
  );
  return { codes: rows.map(codeView) };
}

const normalizeReference = (ref) => String(ref ?? '').replace(/[\s-]/g, '');

async function getCode(userId, reference) {
  const { rows } = await pool.query(
    'SELECT * FROM otc_cash_in_codes WHERE user_id = $1 AND reference = $2',
    [userId, normalizeReference(reference)],
  );
  if (!rows[0]) throw notFound('CODE_NOT_FOUND', 'No cash-in code with this reference');
  return codeView(rows[0]);
}

/**
 * The partner took the cash: credit the wallet once. `amountPaid` must be the full amount to pay
 * (amount + fee). Paying an already-paid code again is answered as a duplicate, not a second credit.
 * `userId` (QA sandbox) limits it to the caller's own codes.
 */
async function confirmPayment({ reference, amountPaid, partnerTxnId } = {}, { userId } = {}) {
  const ref = normalizeReference(reference);
  if (!isValidReference(ref)) throw badRequest('INVALID_REFERENCE', 'reference must be the 12-digit cash-in code');
  const paidCents = toCents(amountPaid);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT c.*, a.id AS wallet_id FROM otc_cash_in_codes c JOIN accounts a ON a.user_id = c.user_id
       WHERE c.reference = $1 ${userId ? 'AND c.user_id = $2' : ''} FOR UPDATE OF c`,
      userId ? [ref, userId] : [ref],
    );
    const code = rows[0];
    if (!code) throw notFound('CODE_NOT_FOUND', 'No cash-in code with this reference');
    if (code.status === 'PAID') return { ...codeView(code), credited: false, duplicate: true };
    if (new Date(code.expires_at) <= new Date()) {
      throw gone('CODE_EXPIRED', 'This cash-in code has expired. Generate a new one.');
    }
    const totalCents = Number(code.amount_cents) + Number(code.fee_cents);
    if (paidCents !== totalCents) {
      throw conflict('AMOUNT_MISMATCH', `The customer must pay exactly ₱${fromCents(totalCents)}`)
        .withDetails({ totalToPay: fromCents(totalCents), amountPaid: fromCents(paidCents) });
    }

    const partner = findPartner(code.partner_code);
    const funding = await client.query('SELECT id FROM accounts WHERE account_number = $1', [FUNDING_ACCOUNT_NUMBER]);
    const transactionId = await recordTransaction(client, {
      type: 'DEPOSIT',
      description: `Cash in at ${partner?.name ?? code.partner_code} (${formatReference(ref)})`,
      entries: [
        { accountId: funding.rows[0].id, direction: 'DEBIT', amountCents: Number(code.amount_cents) },
        { accountId: code.wallet_id, direction: 'CREDIT', amountCents: Number(code.amount_cents) },
      ],
    });
    const updated = await client.query(
      `UPDATE otc_cash_in_codes SET status = 'PAID', paid_at = now(), partner_txn_id = $2, transaction_id = $3
       WHERE id = $1 RETURNING *`,
      [code.id, partnerTxnId ? String(partnerTxnId).slice(0, 64) : null, transactionId],
    );
    return { ...codeView(updated.rows[0]), credited: true, duplicate: false };
  });
}

module.exports = { catalog, createCode, listCodes, getCode, confirmPayment, isValidReference, luhnDigit, formatReference };
