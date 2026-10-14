const express = require('express');
const paymentService = require('../services/paymentService');

const router = express.Router();

// POST /api/webhooks/payments
// Header: X-PayPulse-Signature = hex HMAC-SHA256 of the raw body using WEBHOOK_SECRET
// Body:   { paymentId, accountNumber, amount, status: "PENDING" | "SUCCESS" | "FAILED" }
router.post('/payments', async (req, res) => {
  const result = await paymentService.handlePaymentCallback(
    req.rawBody,
    req.get('x-paypulse-signature'),
    req.body || {},
  );
  res.json({ received: true, ...result });
});

module.exports = router;
