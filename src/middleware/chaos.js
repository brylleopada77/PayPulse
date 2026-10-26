// Chaos engineering middleware for QA (only when the server runs with QA_SANDBOX=true; in
// production these headers are ignored), and only for logged-in ADMIN accounts. Mounted on /api.
//
// Turn it on per request with headers:
//   x-chaos-mode: true                     enable chaos for this request
//   x-chaos-fault: db-lock | drop | error-500 | random   which fault to inject (default: random)
//       db-lock  hold a real row lock on the caller's wallet for x-chaos-lock-ms (default 2000)
//                before the request continues: the request is slow, and other requests that
//                need that wallet's lock wait too
//       drop     answer 503 Service Unavailable (a "network drop")
//       error-500  fault injection: a money-moving POST (transfers, bank transfers, top-ups,
//                bills, load) fails with HTTP 500 CHAOS_FAULT_INJECTED with probability
//                x-chaos-rate, BEFORE it runs (no money moves, so the app may retry it). Other
//                requests are not affected.
//       random   each request: 50% db-lock, then a drop with probability x-chaos-rate
//   x-chaos-rate: 0..1                     probability of a drop / 500 (default 0.3)
//   x-chaos-latency-ms: N                  wait N ms (max 10000) before the request runs; can be
//                                          combined with any fault (or sent alone)
//   x-chaos-drop-when: before | after      before (default): the request never runs
//                                          after: the request RUNS, then its answer is lost
//                                          (the retry must not repeat it: see idempotency.js)
//   x-chaos-drop-attempts: N               deterministic: drop (or 500) only the first N attempts
//                                          of each Idempotency-Key (ignores x-chaos-rate), for tests
// Every chaos-affected response carries `X-Chaos: <what happened>`.
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db/pool');

const MAX_LOCK_MS = 10_000;
// Requests that move money (relative to /api): the targets of error-500 fault injection.
const MONEY_PATHS = /^\/(transfers(\/bank)?|payments\/mock-checkout|v1\/bills\/pay|v1\/load\/purchase)\/?$/;
const attempts = new Map(); // "<auth>|<idempotency key>" -> { count, at }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function attemptNumber(req) {
  const id = `${req.get('authorization') || ''}|${req.get('idempotency-key')}`;
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.at > 10 * 60_000) attempts.delete(k);
  const entry = attempts.get(id) || { count: 0, at: now };
  entry.count += 1;
  entry.at = now;
  attempts.set(id, entry);
  return entry.count;
}

/** Hold a row lock on the caller's wallet for `ms` (a real database lock wait), or just wait. */
async function lockDelay(req, ms) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  let userId = null;
  try {
    userId = jwt.verify(token, config.jwtSecret).sub;
  } catch {
    /* not logged in: plain delay */
  }
  if (!userId) return sleep(ms);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
    await client.query('SELECT pg_sleep($1)', [ms / 1000]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function injectedFault(res) {
  res.set('X-Chaos', 'error-500');
  return res.status(500).json({
    error: {
      code: 'CHAOS_FAULT_INJECTED',
      message: 'Chaos Engine: server fault injected. The request was not processed.',
      details: { chaos: true, retryable: true },
    },
  });
}

function unavailable(res, when) {
  res.set('Retry-After', '1');
  res.set('X-Chaos', `drop-${when}`);
  return res.status(503).json({
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again.',
      details: { chaos: true, droppedWhen: when },
    },
  });
}

/** Chaos is an admin tool: honour the headers only for a logged-in ADMIN (ignored otherwise). */
async function isAdminRequest(req) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  try {
    const { sub } = jwt.verify(token, config.jwtSecret);
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [sub]);
    return rows[0]?.role === 'ADMIN';
  } catch {
    return false;
  }
}

async function chaos(req, res, next) {
  if (!config.qaSandbox || req.get('x-chaos-mode') !== 'true') return next();
  if (!(await isAdminRequest(req))) return next();

  const latencyMs = Math.min(MAX_LOCK_MS, Math.max(0, Number(req.get('x-chaos-latency-ms')) || 0));
  if (latencyMs) {
    await sleep(latencyMs);
    res.set('X-Chaos', `latency-${latencyMs}ms`);
  }
  if (!req.get('x-chaos-fault') && latencyMs) return next();

  const fault = (req.get('x-chaos-fault') || 'random').toLowerCase();
  const rate = Math.min(1, Math.max(0, Number(req.get('x-chaos-rate') ?? 0.3) || 0));
  const when = req.get('x-chaos-drop-when') === 'after' ? 'after' : 'before';
  const dropFirst = Number(req.get('x-chaos-drop-attempts'));
  const lockMs = Math.min(MAX_LOCK_MS, Math.max(0, Number(req.get('x-chaos-lock-ms')) || 2000));

  if (fault === 'error-500') {
    if (req.method !== 'POST' || !MONEY_PATHS.test(req.path)) return next();
    const fail =
      Number.isInteger(dropFirst) && dropFirst > 0 && req.get('idempotency-key')
        ? attemptNumber(req) <= dropFirst
        : Math.random() < rate;
    return fail ? injectedFault(res) : next();
  }

  const effects = [];
  if (fault === 'db-lock' || (fault === 'random' && Math.random() < 0.5)) {
    await lockDelay(req, lockMs);
    effects.push(`db-lock-${lockMs}ms`);
  }

  let drop = false;
  if (fault === 'drop' || fault === 'random') {
    drop =
      Number.isInteger(dropFirst) && dropFirst > 0 && req.get('idempotency-key')
        ? attemptNumber(req) <= dropFirst
        : Math.random() < rate;
  }
  if (effects.length) res.set('X-Chaos', effects.join(','));

  if (drop && when === 'before') return unavailable(res, 'before');
  if (drop && when === 'after') {
    // Let the request run to the end, then lose its answer on the way back.
    const json = res.json.bind(res);
    res.json = () => {
      res.json = json;
      return unavailable(res, 'after');
    };
  }
  return next();
}

module.exports = { chaos };
