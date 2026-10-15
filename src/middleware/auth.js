const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db/pool');
const { unauthorized } = require('../utils/errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Require a valid "Authorization: Bearer <token>" header and set req.user.
 * Tokens issued before the user's last password change are rejected, so resetting a
 * password signs out every existing session.
 *
 * QA sandbox (QA_SANDBOX=true only): if the user switched on "slow network", every
 * authenticated API call waits qa_latency_ms first, except the /api/qa controls themselves.
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
    `SELECT FLOOR(EXTRACT(EPOCH FROM password_changed_at))::bigint AS changed_at, qa_latency_ms, role
     FROM users WHERE id = $1`,
    [payload.sub],
  );
  if (!rows[0]) {
    return next(unauthorized('Invalid or expired token'));
  }
  if (rows[0].changed_at !== null && payload.iat < rows[0].changed_at) {
    return next(unauthorized('Your password was changed. Please log in again.'));
  }

  req.user = { id: payload.sub, email: payload.email, role: rows[0].role };

  if (config.qaSandbox && rows[0].qa_latency_ms > 0 && req.baseUrl !== '/api/qa') {
    await sleep(rows[0].qa_latency_ms);
  }
  return next();
}

module.exports = { requireAuth };
