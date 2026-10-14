const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db/pool');
const { unauthorized } = require('../utils/errors');

/**
 * Require a valid "Authorization: Bearer <token>" header and set req.user.
 * Tokens issued before the user's last password change are rejected, so resetting a
 * password signs out every existing session.
 */
async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized());
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }

  // JWT `iat` is whole seconds, so compare against the change time rounded down.
  const { rows } = await pool.query(
    'SELECT FLOOR(EXTRACT(EPOCH FROM password_changed_at))::bigint AS changed_at FROM users WHERE id = $1',
    [payload.sub],
  );
  if (!rows[0]) {
    return next(unauthorized('Invalid or expired token'));
  }
  if (rows[0].changed_at !== null && payload.iat < rows[0].changed_at) {
    return next(unauthorized('Your password was changed. Please log in again.'));
  }

  req.user = { id: payload.sub, email: payload.email };
  return next();
}

module.exports = { requireAuth };
