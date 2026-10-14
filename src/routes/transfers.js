const express = require('express');
const { requireAuth } = require('../middleware/auth');
const transferService = require('../services/transferService');

const router = express.Router();

// POST /api/transfers  { toAccountNumber, amount, description?, mpin, otpChallengeId?, otp? }
//   201 -> transfer completed
//   202 -> amount is above ₱1,000: { otpRequired, challengeId, expiresInSeconds, demoCode };
//          repeat the same request with otpChallengeId + otp to complete it
router.post('/', requireAuth, async (req, res) => {
  const result = await transferService.transfer(req.user.id, req.body || {});
  res.status(result.otpRequired ? 202 : 201).json(result);
});

module.exports = router;
