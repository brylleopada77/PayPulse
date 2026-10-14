const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const accountService = require('../services/accountService');
const paymentService = require('../services/paymentService');
const { badRequest } = require('../utils/errors');

const router = express.Router();

const OUTCOMES = { approve: 'SUCCESS', decline: 'FAILED' };

// POST /api/payments/mock-checkout  { amount, outcome?: "approve" | "decline" }
// Stands in for a real payment provider (used by the web UI's "Add money" screen):
// it builds the provider's callback, signs it with WEBHOOK_SECRET and runs it
// through the same webhook handler as POST /api/webhooks/payments.
router.post('/mock-checkout', requireAuth, async (req, res) => {
  const { amount, outcome = 'approve' } = req.body || {};
  const status = OUTCOMES[outcome];
  if (!status) {
    throw badRequest('INVALID_OUTCOME', 'outcome must be "approve" or "decline"');
  }

  const { accountNumber } = await accountService.getBalance(req.user.id);
  const rawBody = JSON.stringify({
    paymentId: `mock-${crypto.randomUUID()}`,
    accountNumber,
    amount,
    status,
  });

  const result = await paymentService.handlePaymentCallback(
    rawBody,
    paymentService.sign(rawBody),
    JSON.parse(rawBody),
  );
  res.status(201).json(result);
});

module.exports = router;
