// Mock payment provider for "Add money": ADMIN accounts only (403 ADMIN_ONLY for customers).
// Only mounted when MOCK_PAYMENTS=true (see app.js):
// in production these routes don't exist, and money can only come in through the provider's
// signed callback (POST /api/webhooks/payments).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { simulateServerError } = require('../middleware/accountGuards');
const { idempotency } = require('../middleware/idempotency');
const { requireAdmin } = require('../middleware/requireAdmin');
const topupService = require('../services/topupService');

const router = express.Router();

// POST /api/payments/mock-checkout  { amount, outcome?: "approve" | "decline" }
// Checks the top-up limits (₱100,000/day, ₱1,000,000 held, AML), then simulates the provider's
// signed callback through the same handler as POST /api/webhooks/payments.
router.post('/mock-checkout', requireAuth, requireAdmin, idempotency, simulateServerError, async (req, res) => {
  res.status(201).json(await topupService.checkout(req.user.id, req.body || {}));
});

// GET /api/payments/limits -> how much can still be added today / held
router.get('/limits', requireAuth, requireAdmin, async (req, res) => {
  res.json(await topupService.getLimits(req.user.id));
});

module.exports = router;
