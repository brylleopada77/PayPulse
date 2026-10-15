const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { enforceTransferLimits } = require('../middleware/transferLimits');
const { blockFrozenAccounts, simulateServerError } = require('../middleware/accountGuards');
const transferService = require('../services/transferService');
const limitsService = require('../services/limitsService');
const { BANKS, BANK_TRANSFER_FEE_CENTS } = require('../services/banks');
const { fromCents } = require('../utils/money');

const router = express.Router();

// Both send endpoints answer:
//   201 -> transfer completed
//   202 -> amount is above ₱1,000: { otpRequired, challengeId, expiresInSeconds, demoCode };
//          repeat the same request with otpChallengeId + otp to complete it
//   423 ACCOUNT_FROZEN, 500 (QA sandbox) -> see middleware/accountGuards.js
//   400 DAILY_LIMIT_EXCEEDED / 429 TOO_MANY_TRANSFERS -> see middleware/transferLimits.js
const reply = (res, result) => res.status(result.otpRequired ? 202 : 201).json(result);

// POST /api/transfers  (Express Send, free)
//   { toAccountNumber | toMobileNumber, amount, description?, mpin, otpChallengeId?, otp? }
router.post('/', requireAuth, blockFrozenAccounts, simulateServerError, enforceTransferLimits, async (req, res) => {
  reply(res, await transferService.transfer(req.user.id, req.body || {}));
});

// GET /api/transfers/banks  -> banks / e-wallets for Bank Transfer and the fee
router.get('/banks', requireAuth, (req, res) => {
  res.json({ fee: fromCents(BANK_TRANSFER_FEE_CENTS), feeCents: BANK_TRANSFER_FEE_CENTS, banks: BANKS });
});

// GET /api/transfers/limits  -> daily limit used/remaining and the anti-spam rule
router.get('/limits', requireAuth, async (req, res) => {
  res.json(await limitsService.getLimits(req.user.id));
});

// POST /api/transfers/bank  (Bank Transfer, ₱15 fee)
//   { bankCode, accountNumber, accountName, amount, description?, mpin, otpChallengeId?, otp? }
router.post('/bank', requireAuth, blockFrozenAccounts, simulateServerError, enforceTransferLimits, async (req, res) => {
  reply(res, await transferService.bankTransfer(req.user.id, req.body || {}));
});

module.exports = router;
