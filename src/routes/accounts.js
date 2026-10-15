const express = require('express');
const { requireAuth } = require('../middleware/auth');
const accountService = require('../services/accountService');
const mpinService = require('../services/mpinService');

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

// PUT /api/accounts/me/mobile  { mobileNumber }  -> { mobileNumber }  (add or change)
router.put('/me/mobile', async (req, res) => {
  res.json(await accountService.setMobileNumber(req.user.id, (req.body || {}).mobileNumber));
});

// POST /api/accounts/me/mpin/reset  { password }  -> { mpin, mpinExpiresInSeconds }
// ("Forgot MPIN" or an expired MPIN)
router.post('/me/mpin/reset', async (req, res) => {
  res.json(await mpinService.resetMpin(req.user.id, (req.body || {}).password));
});

module.exports = router;
