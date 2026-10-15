const limitsService = require('../services/limitsService');
const { toCents } = require('../utils/money');

/**
 * Runs before every outgoing transfer (Express Send and Bank Transfer), after requireAuth:
 *   - anti-spam: at most 3 transfers in 10 seconds    -> 429 TOO_MANY_TRANSFERS
 *   - daily limit: ₱50,000 sent per day                -> 400 DAILY_LIMIT_EXCEEDED
 * An invalid amount is rejected here too (400 INVALID_AMOUNT), exactly as the transfer would.
 * Both checks run again on the OTP step of large transfers, so the limits always apply.
 */
async function enforceTransferLimits(req, res, next) {
  const amountCents = toCents((req.body || {}).amount);
  await limitsService.assertWithinLimits(req.user.id, amountCents);
  next();
}

module.exports = { enforceTransferLimits };
