const express = require('express');
const paymentService = require('../services/paymentService');
const otcCashInService = require('../services/otcCashInService');

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

// POST /api/webhooks/otc: an over-the-counter partner confirms a cash-in code was paid
// Header: X-PayPulse-Signature (same HMAC as above)
// Body:   { reference: "882930194410", amountPaid: "1015.00", partnerTxnId? }
router.post('/otc', async (req, res) => {
  paymentService.verifySignature(req.rawBody, req.get('x-paypulse-signature'));
  res.json({ received: true, ...(await otcCashInService.confirmPayment(req.body || {})) });
});

module.exports = router;
