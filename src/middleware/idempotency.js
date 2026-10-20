const crypto = require('crypto');
const { pool } = require('../db/pool');
const { badRequest, conflict, unprocessable } = require('../utils/errors');

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Idempotency-Key support for money-moving POSTs (after requireAuth, before the other guards).
 *
 * Send `Idempotency-Key: <unique id>` with a request and repeat the SAME key when retrying it
 * (e.g. after a timeout or a 503). The first final answer (any status below 500) is stored, and
 * every retry with that key gets the stored answer back with `Idempotent-Replayed: true`; the
 * transfer itself runs at most once. 5xx answers are not stored, so the client may retry.
 *   409 IDEMPOTENCY_IN_PROGRESS  the first request with this key hasn't finished yet
 *   422 IDEMPOTENCY_KEY_REUSED   the key was used for a different request (endpoint or body)
 * Requests without the header behave exactly as before.
 */
async function idempotency(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!KEY_PATTERN.test(key)) {
    throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-100 letters, digits, "-" or "_"');
  }

  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
  const claimed = await pool.query(
    `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [req.user.id, key, endpoint, requestHash],
  );

  if (claimed.rowCount === 0) {
    const { rows } = await pool.query(
      'SELECT endpoint, request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [req.user.id, key],
    );
    const previous = rows[0];
    if (!previous) return idempotency(req, res, next); // released by a failed (5xx) attempt just now
    if (previous.endpoint !== endpoint || previous.request_hash !== requestHash) {
      throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    if (previous.status_code === null) {
      throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    }
    res.set('Idempotent-Replayed', 'true');
    return res.status(previous.status_code).json(previous.response);
  }

  // First time: store the final answer before sending it (or release the key on a 5xx).
  const json = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    const save =
      status < 500
        ? pool.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2', [
            req.user.id,
            key,
            status,
            body,
          ])
        : pool.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, key]);
    save.catch((err) => console.error('idempotency store failed:', err.message)).finally(() => json(body));
    return res;
  };
  return next();
}

module.exports = { idempotency };
