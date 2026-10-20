const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { pool, withTransaction } = require('../db/pool');
const { validatePassword } = require('./authService');
const { badRequest, forbidden, gone, tooManyRequests } = require('../utils/errors');

const RESET_TTL_MINUTES = 10;
const RESET_TTL_SECONDS = RESET_TTL_MINUTES * 60;
const MAX_ATTEMPTS = 3;
const CODE_PATTERN = /^\d{6}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_MESSAGE = 'If an account exists for this email, we sent it a 6-digit code.';

function hashCode(resetId, code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`pwreset:${resetId}:${code}`).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Step 1: start a password reset for an email.
 *
 * The response is identical whether or not the email belongs to an account, so this endpoint
 * can't be used to find out who has a PayPulse account. Unknown emails get a stored request
 * with user_id NULL that can never change any password.
 *
 * MOCK email: the code is returned as `demoCode` so the web UI can show it as a fake email.
 * A real system would email it and never return it.
 */
async function requestReset(email) {
  if (typeof email !== 'string' || email.trim() === '') {
    throw badRequest('INVALID_EMAIL', 'A valid email is required');
  }
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);

  const resetId = crypto.randomUUID();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query(
    `INSERT INTO password_resets (id, user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [resetId, rows[0]?.id ?? null, hashCode(resetId, code), RESET_TTL_SECONDS],
  );

  return { message: GENERIC_MESSAGE, resetId, expiresInSeconds: RESET_TTL_SECONDS, demoCode: code };
}

function invalidCode(left) {
  const suffix = left === undefined ? '' : ` ${left} attempt${left === 1 ? '' : 's'} left.`;
  return forbidden('INVALID_RESET_CODE', `Invalid or expired code.${suffix}`);
}

/**
 * Step 2: check the code and set the new password.
 * Changing the password also signs out every existing session (see middleware/auth.js).
 */
async function resetPassword({ resetId, code, newPassword }) {
  validatePassword(newPassword);
  if (typeof resetId !== 'string' || !UUID_PATTERN.test(resetId)) throw invalidCode();

  const { rows } = await pool.query(
    `SELECT code_hash, attempts, used_at, expires_at <= now() AS expired
     FROM password_resets WHERE id = $1`,
    [resetId],
  );
  const reset = rows[0];

  if (!reset || reset.used_at) throw invalidCode();
  if (reset.expired) throw gone('RESET_CODE_EXPIRED', 'The code has expired. Request a new one.');
  if (reset.attempts >= MAX_ATTEMPTS) {
    throw tooManyRequests('RESET_ATTEMPTS_EXCEEDED', 'Too many wrong codes. Request a new one.');
  }

  const valid =
    typeof code === 'string' && CODE_PATTERN.test(code) && sameHash(hashCode(resetId, code), reset.code_hash);
  if (!valid) {
    const result = await pool.query(
      'UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [resetId],
    );
    const left = MAX_ATTEMPTS - result.rows[0].attempts;
    if (left <= 0) throw tooManyRequests('RESET_ATTEMPTS_EXCEEDED', 'Too many wrong codes. Request a new one.');
    throw invalidCode(left);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  return withTransaction(async (client) => {
    // Mark the code used atomically, so two parallel requests can't both use it.
    const used = await client.query(
      `UPDATE password_resets SET used_at = now()
       WHERE id = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [resetId],
    );
    if (used.rowCount === 0) throw invalidCode();

    const userId = used.rows[0].user_id;
    if (userId !== null) {
      await client.query(
        'UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
        [passwordHash, userId],
      );
    }
    // Same answer for unknown emails, so the outcome reveals nothing either.
    return { message: 'Your password has been changed. Log in with your new password.' };
  });
}

module.exports = { requestReset, resetPassword, RESET_TTL_SECONDS };
