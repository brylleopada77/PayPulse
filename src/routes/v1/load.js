const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { blockFrozenAccounts, simulateServerError } = require('../../middleware/accountGuards');
const { amlMonitor } = require('../../middleware/amlMonitor');
const { enforceTransferLimits } = require('../../middleware/transferLimits');
const loadService = require('../../services/loadService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/load -> networks, brands, regular amounts, promos, today's cashback status
router.get('/', async (req, res) => {
  res.json(await loadService.getCatalog(req.user.id));
});

// GET /api/v1/load/detect?mobile=09171234567 -> { mobileNumber, detected, network }
router.get('/detect', (req, res) => {
  res.json(loadService.detect(req.query.mobile));
});

// POST /api/v1/load/purchase
//   { mobileNumber, brand, productType: "REGULAR", amount, mpin }
//   { mobileNumber, brand, productType: "PROMO", promoCode, mpin }
// Same guards as a transfer: frozen accounts, QA forced errors, AML, daily limit / anti-spam.
// The purchase is validated FIRST and `amount` is set to the real price (a promo's catalog price),
// so AML and the daily limit always check what will actually be charged, never a client-sent number.
router.post(
  '/purchase',
  (req, res, next) => {
    const checked = loadService.validate(req.body || {});
    req.body = { ...req.body, amount: (checked.amountCents / 100).toFixed(2) };
    next();
  },
  idempotency,
  blockFrozenAccounts,
  simulateServerError,
  amlMonitor,
  enforceTransferLimits,
  async (req, res) => {
    res.status(201).json(await loadService.purchase(req.user.id, req.body || {}));
  },
);

module.exports = router;
