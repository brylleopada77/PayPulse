const express = require('express');
const { requireAuth } = require('../middleware/auth');
const accountService = require('../services/accountService');

const router = express.Router();

router.use(requireAuth);

// GET /api/accounts/me  -> balance of the logged-in user
router.get('/me', async (req, res) => {
  res.json(await accountService.getBalance(req.user.id));
});

// GET /api/accounts/me/transactions  -> ledger history
router.get('/me/transactions', async (req, res) => {
  res.json({ transactions: await accountService.getTransactions(req.user.id) });
});

module.exports = router;
