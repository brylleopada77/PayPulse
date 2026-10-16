const express = require('express');
const { requireAuth } = require('../middleware/auth');
const accountService = require('../services/accountService');
const mpinService = require('../services/mpinService');
const receiptService = require('../services/receiptService');
const complianceService = require('../services/complianceService');

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

// GET /api/accounts/me/transactions/:id/receipt  -> receipt details (own transactions only)
router.get('/me/transactions/:id/receipt', async (req, res) => {
  res.json(await receiptService.getReceipt(req.user.id, req.params.id));
});

// GET /api/accounts/me/compliance  -> AML status (CLEAR / UNDER_REVIEW), rules and my alerts
router.get('/me/compliance', async (req, res) => {
  res.json(await complianceService.getStatus(req.user.id));
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

// POST /api/accounts/me/mpin/change  { currentMpin, newMpin, confirmMpin } -> { message, mpinExpiresInSeconds }
router.post('/me/mpin/change', async (req, res) => {
  res.json(await mpinService.changeMpin(req.user.id, req.body || {}));
});

module.exports = router;
