const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { badRequest, forbidden, gone, locked, unauthorized } = require('../utils/errors');

const MPIN_PATTERN = /^\d{6}$/;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
// An MPIN works for this long after it is issued (sign-up or reset); then the user gets a new one.
const MPIN_TTL_MINUTES = 5;
const MPIN_TTL_SECONDS = MPIN_TTL_MINUTES * 60;

/** A random 6-digit MPIN (000000-999999) from a cryptographically secure source. */
function generateMpin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Generate a new random MPIN and its hash. Only the hash is ever stored.
 * `expiresInSeconds` is how long it stays valid; store it as now() + that many seconds.
 */
async function newMpin() {
  const mpin = generateMpin();
  return { mpin, mpinHash: await bcrypt.hash(mpin, 10), expiresInSeconds: MPIN_TTL_SECONDS };
}

/** Record a wrong MPIN. Locks MPIN use after MAX_FAILED_ATTEMPTS in a row. */
async function registerFailure(userId) {
  const { rows } = await pool.query(
    `UPDATE users
     SET mpin_failed_attempts = CASE WHEN mpin_failed_attempts + 1 >= $2 THEN 0
                                     ELSE mpin_failed_attempts + 1 END,
         mpin_locked_until    = CASE WHEN mpin_failed_attempts + 1 >= $2
                                     THEN now() + make_interval(mins => $3) END
     WHERE id = $1
     RETURNING mpin_locked_until IS NOT NULL AS is_locked`,
    [userId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
  );
  return rows[0]?.is_locked === true;
}

function lockedError() {
  return locked(
    'MPIN_LOCKED',
    `Too many wrong MPIN attempts. Transfers are locked for ${LOCK_MINUTES} minutes, or reset your MPIN.`,
  );
}

/**
 * Check the user's 6-digit MPIN before money leaves their wallet.
 * Throws INVALID_MPIN (403) for a wrong PIN, MPIN_EXPIRED (410) once it is older than
 * MPIN_TTL_MINUTES, and MPIN_LOCKED (423) after repeated failures.
 */
async function verifyMpin(userId, mpin) {
  if (mpin === undefined || mpin === null || mpin === '') {
    throw badRequest('MPIN_REQUIRED', 'Enter your 6-digit MPIN');
  }

  const { rows } = await pool.query(
    `SELECT mpin_hash, mpin_failed_attempts,
            COALESCE(mpin_locked_until > now(), false)  AS is_locked,
            COALESCE(mpin_expires_at <= now(), true)    AS is_expired
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user) throw unauthorized();
  if (!user.mpin_hash) {
    // Accounts created before random MPINs existed.
    throw forbidden('MPIN_NOT_SET', 'You have no MPIN yet. Use "Forgot MPIN" to get one.');
  }
  if (user.is_locked) throw lockedError();
  if (user.is_expired) {
    throw gone('MPIN_EXPIRED', 'Your MPIN has expired. Enter your password to get a new one.');
  }

  const valid = typeof mpin === 'string' && MPIN_PATTERN.test(mpin) && (await bcrypt.compare(mpin, user.mpin_hash));
  if (!valid) {
    if (await registerFailure(userId)) throw lockedError();
    throw forbidden('INVALID_MPIN', 'Invalid MPIN');
  }

  if (user.mpin_failed_attempts > 0) {
    await pool.query('UPDATE users SET mpin_failed_attempts = 0 WHERE id = $1', [userId]);
  }
}

/**
 * "Forgot MPIN" / expired MPIN: after re-checking the account password, replace the MPIN with
 * a new random one (valid for MPIN_TTL_MINUTES) and clear any lock.
 * Returns { mpin, mpinExpiresInSeconds }; the MPIN is shown to the user once.
 */
async function resetMpin(userId, password) {
  if (typeof password !== 'string' || password === '') {
    throw badRequest('PASSWORD_REQUIRED', 'Enter your account password');
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw unauthorized();
  if (!(await bcrypt.compare(password, rows[0].password_hash))) {
    // 403, not 401: the session is still valid, only the password is wrong.
    throw forbidden('INVALID_PASSWORD', 'Incorrect password');
  }

  const { mpin, mpinHash, expiresInSeconds } = await newMpin();
  await pool.query(
    `UPDATE users
     SET mpin_hash = $1, mpin_failed_attempts = 0, mpin_locked_until = NULL,
         mpin_expires_at = now() + make_interval(secs => $3)
     WHERE id = $2`,
    [mpinHash, userId, expiresInSeconds],
  );
  return { mpin, mpinExpiresInSeconds: expiresInSeconds };
}

/** Easy-to-guess PINs: one digit repeated (111111) or a straight run (123456, 987654). */
function isWeakMpin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const steps = [...pin].slice(1).map((d, i) => Number(d) - Number(pin[i]));
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

/**
 * Change MPIN: the current MPIN (same checks as a transfer: wrong / expired / locked), then a new
 * user-chosen 6-digit MPIN typed twice. The new MPIN follows the same 5-minute lifetime rule.
 */
async function changeMpin(userId, { currentMpin, newMpin: next, confirmMpin } = {}) {
  await verifyMpin(userId, currentMpin);
  if (typeof next !== 'string' || !MPIN_PATTERN.test(next)) {
    throw badRequest('INVALID_NEW_MPIN', 'Your new MPIN must be exactly 6 digits');
  }
  if (next !== confirmMpin) throw badRequest('MPIN_MISMATCH', 'The new MPINs do not match');
  if (next === currentMpin) throw badRequest('MPIN_SAME_AS_OLD', 'Choose an MPIN different from your current one');
  if (isWeakMpin(next)) {
    throw badRequest('WEAK_MPIN', 'This MPIN is too easy to guess. Avoid repeated digits (111111) and runs (123456).');
  }
  await pool.query(
    `UPDATE users
     SET mpin_hash = $1, mpin_failed_attempts = 0, mpin_locked_until = NULL,
         mpin_expires_at = now() + make_interval(secs => $3)
     WHERE id = $2`,
    [await bcrypt.hash(next, 10), userId, MPIN_TTL_SECONDS],
  );
  return { message: 'Your MPIN has been changed', mpinExpiresInSeconds: MPIN_TTL_SECONDS };
}

module.exports = { verifyMpin, resetMpin, changeMpin, isWeakMpin, newMpin, MPIN_TTL_SECONDS };
