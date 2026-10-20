const config = require('../config');
const { pool } = require('../db/pool');
const qaService = require('../services/qaService');
const { AppError, locked } = require('../utils/errors');

/** Frozen accounts cannot send money: 423 ACCOUNT_FROZEN. Runs before every outgoing transfer. */
async function blockFrozenAccounts(req, res, next) {
  const { rows } = await pool.query('SELECT frozen FROM users WHERE id = $1', [req.user.id]);
  if (rows[0]?.frozen) {
    throw locked('ACCOUNT_FROZEN', 'This account is frozen. Sending money is blocked until it is unfrozen.');
  }
  next();
}

/**
 * QA sandbox (QA_SANDBOX=true only): if "fail next transaction" is on, this request fails with
 * a realistic 500 and the switch turns itself off. No money moves.
 */
async function simulateServerError(req, res, next) {
  if (config.qaSandbox && (await qaService.consumeFailNext(req.user.id))) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Something went wrong', {
      details: { simulated: true, source: 'QA sandbox: fail next transaction' },
    });
  }
  next();
}

module.exports = { blockFrozenAccounts, simulateServerError };
