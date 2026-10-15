const complianceService = require('../services/complianceService');
const { toCents } = require('../utils/money');

/**
 * AML transaction monitoring, before every outgoing transfer (after requireAuth, before limits):
 *   - a single transfer above ₱500,000                 -> 403 TRANSACTION_HELD_FOR_REVIEW
 *   - more than 5 transfers within 1 minute             -> 403 TRANSACTION_HELD_FOR_REVIEW
 *   - account already under review                      -> 403 TRANSACTION_HELD_FOR_REVIEW
 * A rule that fires opens a compliance alert and puts the account under review.
 * Runs again on the OTP step of large transfers.
 */
async function amlMonitor(req, res, next) {
  const amountCents = toCents((req.body || {}).amount);
  await complianceService.screenTransfer(req.user.id, amountCents, `${req.method} ${req.baseUrl}${req.path}`);
  next();
}

module.exports = { amlMonitor };
