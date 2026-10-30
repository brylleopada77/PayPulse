const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const otcCashInService = require('../../services/otcCashInService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/cash-in/otc/partners -> { categories, partners: [{ code, name, category, fee, feeLabel, logo, badge }], minAmount, maxAmount, validHours }
router.get('/otc/partners', (req, res) => {
  res.json(otcCashInService.catalog());
});

// POST /api/v1/cash-in/otc  { partnerCode, amount } -> 201 a 12-digit payment code, valid 24 hours
router.post('/otc', idempotency, async (req, res) => {
  res.status(201).json(await otcCashInService.createCode(req.user.id, req.body || {}));
});

// GET /api/v1/cash-in/otc -> { codes } my latest 20 codes (PENDING / PAID / EXPIRED)
router.get('/otc', async (req, res) => {
  res.json(await otcCashInService.listCodes(req.user.id));
});

// GET /api/v1/cash-in/otc/:reference -> one of my codes (the app polls it to see when it is paid)
router.get('/otc/:reference', async (req, res) => {
  res.json(await otcCashInService.getCode(req.user.id, req.params.reference));
});

module.exports = router;
