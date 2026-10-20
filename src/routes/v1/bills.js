const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { blockFrozenAccounts, simulateServerError } = require('../../middleware/accountGuards');
const { amlMonitor } = require('../../middleware/amlMonitor');
const { enforceTransferLimits } = require('../../middleware/transferLimits');
const billService = require('../../services/billService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/bills -> categories, billers, convenience fee and today's cashback status
router.get('/', async (req, res) => {
  res.json(await billService.getCatalog(req.user.id));
});

// POST /api/v1/bills/pay  { billerCode, accountNumber, accountName, amount, mpin }
// Same guards as a transfer: frozen accounts, QA forced errors, AML screening, daily limit / anti-spam.
router.post('/pay', idempotency, blockFrozenAccounts, simulateServerError, amlMonitor, enforceTransferLimits, async (req, res) => {
  res.status(201).json(await billService.pay(req.user.id, req.body || {}));
});

module.exports = router;
