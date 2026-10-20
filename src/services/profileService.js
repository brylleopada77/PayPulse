// My Profile: KYC level, linked bank accounts / cards, security preferences and support tickets.
// Everything here is a mock of a real e-wallet's profile area: the ID check approves instantly and
// linked accounts are never debited, but the rules (limits, masking, MPIN checks) are real.
const { pool } = require('../db/pool');
const mpinService = require('./mpinService');
const { DAILY_LIMIT_BY_KYC } = require('./limitsService');
const { badRequest, conflict, notFound, tooManyRequests } = require('../utils/errors');
const { fromCents } = require('../utils/money');

const KYC_TIERS = [
  { level: 1, name: 'Basic', label: 'Level 1 (Basic)', requirements: 'Email and mobile number' },
  { level: 2, name: 'Fully Verified', label: 'Level 2 (Fully Verified)', requirements: 'Government ID and selfie' },
].map((t) => ({ ...t, dailyLimit: fromCents(DAILY_LIMIT_BY_KYC[t.level]) }));

const ID_TYPES = {
  PHILSYS: 'PhilSys National ID',
  PASSPORT: 'Philippine Passport',
  DRIVERS_LICENSE: "Driver's License",
  UMID: 'UMID',
  PRC: 'PRC ID',
};

// Banks a customer can link (cards: Visa / Mastercard only).
const LINKABLE_BANKS = {
  BDO: 'BDO Unibank',
  BPI: 'BPI',
  METROBANK: 'Metrobank',
  LANDBANK: 'LANDBANK',
  UNIONBANK: 'UnionBank',
  SECURITY_BANK: 'Security Bank',
  RCBC: 'RCBC',
  PNB: 'PNB',
};
const MAX_LINKED = 5;
const TICKET_CATEGORIES = ['TRANSFER', 'BILLS', 'LOAN', 'CARD', 'ACCOUNT', 'OTHER'];
const MAX_TICKETS_PER_DAY = 10;

const ticketNumber = (id) => `PP-TKT-${String(id).padStart(6, '0')}`;

function presentTicket(t) {
  return {
    ticketNumber: ticketNumber(t.id),
    category: t.category,
    subject: t.subject,
    message: t.message,
    status: t.status,
    createdAt: t.created_at,
  };
}

function presentLinked(row) {
  return {
    id: row.id,
    kind: row.kind,
    institution: row.institution,
    name: row.kind === 'BANK' ? LINKABLE_BANKS[row.institution] ?? row.institution : row.institution,
    maskedNumber: `•••• ${row.last4}`,
    holderName: row.holder_name,
    expiry: row.expiry,
    linkedAt: row.created_at,
  };
}

/** GET /api/v1/profile */
async function getProfile(userId) {
  const { rows: [u] } = await pool.query(
    `SELECT kyc_level, kyc_id_type, kyc_id_last4, kyc_verified_at, sms_2fa_all, biometric_login
     FROM users WHERE id = $1`,
    [userId],
  );
  const linked = await pool.query('SELECT * FROM linked_accounts WHERE user_id = $1 ORDER BY id', [userId]);
  const tickets = await pool.query(
    'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
    [userId],
  );
  const tier = KYC_TIERS.find((t) => t.level === u.kyc_level);
  return {
    kyc: {
      level: tier.level,
      label: tier.label,
      verified: tier.level >= 2,
      dailyLimit: tier.dailyLimit,
      verifiedAt: u.kyc_verified_at,
      idType: u.kyc_id_type ? ID_TYPES[u.kyc_id_type] : null,
      idNumber: u.kyc_id_last4 ? `•••• ${u.kyc_id_last4}` : null,
      tiers: KYC_TIERS,
      idTypes: Object.entries(ID_TYPES).map(([code, name]) => ({ code, name })),
    },
    security: { smsTwoFactor: u.sms_2fa_all, biometricLogin: u.biometric_login },
    linkedAccounts: linked.rows.map(presentLinked),
    linkableBanks: Object.entries(LINKABLE_BANKS).map(([code, name]) => ({ code, name })),
    supportTickets: tickets.rows.map(presentTicket),
  };
}

function ageOn(birthDate, today = new Date()) {
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age -= 1;
  return age;
}

/** POST /api/v1/profile/kyc: mock ID check, approved instantly -> Level 2 (₱100,000 a day). */
async function verifyKyc(userId, { idType, idNumber, birthDate, selfieConfirmed } = {}) {
  if (!ID_TYPES[idType]) throw badRequest('INVALID_ID_TYPE', 'Choose a valid government ID');
  const id = String(idNumber ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(id)) throw badRequest('INVALID_ID_NUMBER', 'Enter the ID number as printed (6 to 20 letters or digits)');
  const born = /^\d{4}-\d{2}-\d{2}$/.test(String(birthDate)) ? new Date(`${birthDate}T00:00:00Z`) : null;
  if (!born || Number.isNaN(born.getTime()) || born.toISOString().slice(0, 10) !== birthDate) {
    throw badRequest('INVALID_BIRTH_DATE', 'Enter your date of birth (YYYY-MM-DD)');
  }
  const age = ageOn(born);
  if (age < 18 || age > 120) throw badRequest('UNDERAGE', 'You must be at least 18 years old to be fully verified');
  if (selfieConfirmed !== true) throw badRequest('SELFIE_REQUIRED', 'Take a selfie holding your ID to finish verification');

  const { rowCount } = await pool.query(
    `UPDATE users SET kyc_level = 2, kyc_id_type = $2, kyc_id_last4 = $3, kyc_verified_at = now()
     WHERE id = $1 AND kyc_level < 2`,
    [userId, idType, id.slice(-4)],
  );
  if (rowCount === 0) throw conflict('ALREADY_VERIFIED', 'Your account is already fully verified');
  return (await getProfile(userId)).kyc;
}

const luhnValid = (digits) =>
  [...digits].reverse().reduce((sum, ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    return sum + d;
  }, 0) % 10 === 0;

function cardBrand(digits) {
  if (/^4/.test(digits)) return 'Visa';
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return 'Mastercard';
  return null;
}

/** POST /api/v1/profile/linked-accounts: link a bank account or a Visa / Mastercard (MPIN required). */
async function linkAccount(userId, { kind, bankCode, accountNumber, cardNumber, expiry, holderName, mpin } = {}) {
  const holder = String(holderName ?? '').trim().replace(/\s+/g, ' ');
  if (holder.length < 2 || holder.length > 100) throw badRequest('INVALID_HOLDER_NAME', 'Enter the account holder name');

  let row;
  if (kind === 'BANK') {
    if (!LINKABLE_BANKS[bankCode]) throw badRequest('INVALID_BANK', 'Choose a bank from the list');
    const digits = String(accountNumber ?? '').replace(/[\s-]/g, '');
    if (!/^\d{10,16}$/.test(digits)) throw badRequest('INVALID_ACCOUNT_NUMBER', 'Bank account numbers have 10 to 16 digits');
    row = { kind, institution: bankCode, last4: digits.slice(-4), expiry: null };
  } else if (kind === 'CARD') {
    const digits = String(cardNumber ?? '').replace(/[\s-]/g, '');
    if (!/^\d{16}$/.test(digits) || !luhnValid(digits)) throw badRequest('INVALID_CARD_NUMBER', 'Enter a valid 16-digit card number');
    const brand = cardBrand(digits);
    if (!brand) throw badRequest('UNSUPPORTED_CARD', 'Only Visa and Mastercard can be linked');
    const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(String(expiry ?? '').trim());
    if (!m) throw badRequest('INVALID_EXPIRY', 'Enter the expiry date as MM/YY');
    const endOfMonth = new Date(Date.UTC(2000 + Number(m[2]), Number(m[1]), 1));
    if (endOfMonth <= new Date()) throw badRequest('CARD_EXPIRED', 'This card has expired');
    row = { kind, institution: brand, last4: digits.slice(-4), expiry: `${m[1]}/${m[2]}` };
  } else {
    throw badRequest('INVALID_KIND', 'Choose a bank account or a card');
  }

  await mpinService.verifyMpin(userId, mpin);
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM linked_accounts WHERE user_id = $1', [userId]);
  if (n >= MAX_LINKED) throw conflict('TOO_MANY_LINKED_ACCOUNTS', `You can link up to ${MAX_LINKED} accounts and cards`);
  try {
    const { rows: [saved] } = await pool.query(
      `INSERT INTO linked_accounts (user_id, kind, institution, last4, holder_name, expiry)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, row.kind, row.institution, row.last4, holder, row.expiry],
    );
    return presentLinked(saved);
  } catch (err) {
    if (err.code === '23505') throw conflict('ALREADY_LINKED', 'This account is already linked');
    throw err;
  }
}

/** DELETE /api/v1/profile/linked-accounts/:id */
async function unlinkAccount(userId, id) {
  const { rowCount } = await pool.query('DELETE FROM linked_accounts WHERE id = $1 AND user_id = $2', [Number(id) || 0, userId]);
  if (rowCount === 0) throw notFound('LINKED_ACCOUNT_NOT_FOUND', 'Linked account not found');
}

/**
 * PATCH /api/v1/profile/security { smsTwoFactor?, biometricLogin?, mpin? }
 * Turning SMS 2FA OFF weakens the account, so it needs the MPIN; turning things on doesn't.
 */
async function updateSecurity(userId, { smsTwoFactor, biometricLogin, mpin } = {}) {
  const { rows: [current] } = await pool.query('SELECT sms_2fa_all FROM users WHERE id = $1', [userId]);
  if (smsTwoFactor === false && current.sms_2fa_all) await mpinService.verifyMpin(userId, mpin);
  const sets = [];
  const values = [userId];
  if (typeof smsTwoFactor === 'boolean') sets.push(`sms_2fa_all = $${values.push(smsTwoFactor)}`);
  if (typeof biometricLogin === 'boolean') sets.push(`biometric_login = $${values.push(biometricLogin)}`);
  if (sets.length) await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values);
  return (await getProfile(userId)).security;
}

/** POST /api/v1/profile/support/tickets { category, subject, message } */
async function createTicket(userId, { category, subject, message } = {}) {
  if (!TICKET_CATEGORIES.includes(category)) throw badRequest('INVALID_CATEGORY', 'Choose what your concern is about');
  const title = String(subject ?? '').trim();
  const body = String(message ?? '').trim();
  if (title.length < 3 || title.length > 100) throw badRequest('INVALID_SUBJECT', 'Write a short subject (3 to 100 characters)');
  if (body.length < 10 || body.length > 1000) throw badRequest('INVALID_MESSAGE', 'Describe your concern (10 to 1,000 characters)');

  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
    [userId],
  );
  if (n >= MAX_TICKETS_PER_DAY) throw tooManyRequests('TOO_MANY_TICKETS', 'You have sent many tickets today. Our team will reply soon.');
  const { rows: [t] } = await pool.query(
    'INSERT INTO support_tickets (user_id, category, subject, message) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, category, title, body],
  );
  return presentTicket(t);
}

module.exports = {
  getProfile,
  verifyKyc,
  linkAccount,
  unlinkAccount,
  updateSecurity,
  createTicket,
  KYC_TIERS,
  LINKABLE_BANKS,
};
