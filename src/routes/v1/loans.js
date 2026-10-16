const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { blockFrozenAccounts, simulateServerError } = require('../../middleware/accountGuards');
const loanService = require('../../services/loanService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/loans -> credit line (₱50,000), rate, terms and the open loan with its schedule
router.get('/', async (req, res) => {
  res.json(await loanService.getOverview(req.user.id));
});

// POST /api/v1/loans/quote  { amount, termMonths } -> interest, total and monthly installment (nothing is booked)
router.post('/quote', (req, res) => {
  res.json(loanService.getQuote(req.body || {}));
});

// POST /api/v1/loans  { amount, termMonths, mpin } -> Apply & Disburse: credits the wallet immediately
router.post('/', idempotency, blockFrozenAccounts, simulateServerError, async (req, res) => {
  res.status(201).json(await loanService.apply(req.user.id, req.body || {}));
});

// POST /api/v1/loans/:id/repay  { amount } -> pay from the wallet (interest first, then principal)
router.post('/:id/repay', idempotency, simulateServerError, async (req, res) => {
  res.status(201).json(await loanService.repay(req.user.id, req.params.id, req.body || {}));
});

module.exports = router;
