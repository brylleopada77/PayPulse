const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const mpinService = require('./mpinService');
const { withTransaction, pool } = require('../db/pool');
const { badRequest, conflict, unauthorized } = require('../utils/errors');
const { requireMobile } = require('../utils/mobile');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest('INVALID_PASSWORD', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function validateRegistration({ email, password, fullName }) {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    throw badRequest('INVALID_EMAIL', 'A valid email is required');
  }
  validatePassword(password);
  if (typeof fullName !== 'string' || fullName.trim() === '') {
    throw badRequest('INVALID_NAME', 'Full name is required');
  }
}

/**
 * Create a user together with their wallet account and a random 6-digit MPIN.
 * mobileNumber is optional; with it, others can Express Send to this user by mobile number.
 */
async function register({ email, password, fullName, mobileNumber }) {
  validateRegistration({ email, password, fullName });
  const mobile = mobileNumber === undefined || mobileNumber === null || mobileNumber === '' ? null : requireMobile(mobileNumber);
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);
  const { mpin, mpinHash, expiresInSeconds } = await mpinService.newMpin();

  try {
    return await withTransaction(async (client) => {
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, full_name, mpin_hash, mpin_expires_at, mobile_number)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)
         RETURNING id, email, full_name, mobile_number`,
        [normalizedEmail, passwordHash, fullName.trim(), mpinHash, expiresInSeconds, mobile],
      );
      const user = userResult.rows[0];

      const accountResult = await client.query(
        'INSERT INTO accounts (user_id) VALUES ($1) RETURNING account_number, currency',
        [user.id],
      );
      const account = accountResult.rows[0];

      return {
        user: { id: user.id, email: user.email, fullName: user.full_name, mobileNumber: user.mobile_number },
        account: { accountNumber: account.account_number, currency: account.currency },
        // Shown to the user once. Only its hash is stored. It expires after a few minutes.
        mpin,
        mpinExpiresInSeconds: expiresInSeconds,
      };
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'idx_users_mobile_number') {
      throw conflict('MOBILE_TAKEN', 'This mobile number is already used by another PayPulse account');
    }
    if (err.code === '23505') {
      // unique_violation on users.email
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
}

/** Check credentials and return a signed JWT. */
async function login({ email, password }) {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw badRequest('INVALID_CREDENTIALS_FORMAT', 'Email and password are required');
  }

  const { rows } = await pool.query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const user = rows[0];

  // Same error for "no such user" and "wrong password" so emails can't be probed.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw unauthorized('Invalid email or password');
  }

  const token = jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
  return { token, tokenType: 'Bearer', expiresIn: config.jwtExpiresIn };
}

module.exports = { register, login, validatePassword };
