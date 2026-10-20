const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db/pool');
const { conflict, forbidden, gone, tooManyRequests } = require('../utils/errors');

const OTP_TTL_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 3;
const CODE_PATTERN = /^\d{6}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes are never stored in plain text. */
function hashCode(challengeId, code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${challengeId}:${code}`).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Create a one-time code for one specific transfer (recipient + amount).
 * This is a MOCK 2FA: instead of sending an SMS, the code is returned as `demoCode`
 * so the web UI can show it as a fake text message. A real system must never do this.
 */
async function issue(userId, { toAccountNumber, amountCents }) {
  const challengeId = crypto.randomUUID();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

  await pool.query(
    `INSERT INTO otp_challenges (id, user_id, code_hash, to_account, amount_cents, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [challengeId, userId, hashCode(challengeId, code), toAccountNumber, amountCents, OTP_TTL_SECONDS],
  );

  return { challengeId, expiresInSeconds: OTP_TTL_SECONDS, demoCode: code };
}

function invalidChallenge() {
  return forbidden('INVALID_OTP_CHALLENGE', 'This verification request is not valid. Please start the transfer again.');
}

/** Check a code against its challenge. Wrong codes count towards OTP_MAX_ATTEMPTS. */
async function verify(userId, { challengeId, code, toAccountNumber, amountCents }) {
  if (typeof challengeId !== 'string' || !UUID_PATTERN.test(challengeId)) throw invalidChallenge();

  const { rows } = await pool.query(
    `SELECT code_hash, to_account, amount_cents, attempts, used_at, expires_at <= now() AS expired
     FROM otp_challenges WHERE id = $1 AND user_id = $2`,
    [challengeId, userId],
  );
  const challenge = rows[0];

  if (!challenge) throw invalidChallenge();
  if (challenge.used_at) throw conflict('OTP_ALREADY_USED', 'This code has already been used.');
  if (challenge.expired) throw gone('OTP_EXPIRED', 'The code has expired. Request a new one.');
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    throw tooManyRequests('OTP_ATTEMPTS_EXCEEDED', 'Too many wrong codes. Request a new one.');
  }
  if (challenge.to_account !== toAccountNumber || challenge.amount_cents !== amountCents) {
    throw forbidden('OTP_MISMATCH', 'This code was issued for a different transfer.');
  }

  const valid = typeof code === 'string' && CODE_PATTERN.test(code) && sameHash(hashCode(challengeId, code), challenge.code_hash);
  if (!valid) {
    const result = await pool.query(
      'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [challengeId],
    );
    const left = OTP_MAX_ATTEMPTS - result.rows[0].attempts;
    if (left <= 0) throw tooManyRequests('OTP_ATTEMPTS_EXCEEDED', 'Too many wrong codes. Request a new one.');
    throw forbidden('INVALID_OTP', `Invalid OTP. ${left} attempt${left === 1 ? '' : 's'} left.`);
  }
}

/** Mark the code as used inside the transfer's transaction, so it can never be replayed. */
async function consume(client, challengeId) {
  const { rowCount } = await client.query(
    'UPDATE otp_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL',
    [challengeId],
  );
  if (rowCount === 0) throw conflict('OTP_ALREADY_USED', 'This code has already been used.');
}

module.exports = { issue, verify, consume, OTP_TTL_SECONDS };
