const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { blockFrozenAccounts, simulateServerError } = require('../../middleware/accountGuards');
const savingsService = require('../../services/savingsService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/savings -> vault balance, 6.00% rate, interest earned, estimated daily interest, activity
router.get('/', async (req, res) => {
  res.json(await savingsService.getVault(req.user.id));
});

const moveRoute = (direction) => [
  idempotency,
  blockFrozenAccounts,
  simulateServerError,
  async (req, res) => {
    res.status(201).json(await savingsService.move(req.user.id, direction, (req.body || {}).amount));
  },
];

// POST /api/v1/savings/deposit  { amount }  wallet -> vault
router.post('/deposit', ...moveRoute('DEPOSIT'));

// POST /api/v1/savings/withdraw { amount }  vault -> wallet
router.post('/withdraw', ...moveRoute('WITHDRAW'));

module.exports = router;
