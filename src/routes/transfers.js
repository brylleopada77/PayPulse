const express = require('express');
const { requireAuth } = require('../middleware/auth');
const transferService = require('../services/transferService');

const router = express.Router();

// POST /api/transfers  { toAccountNumber, amount, description? }
router.post('/', requireAuth, async (req, res) => {
  const result = await transferService.transfer(req.user.id, req.body || {});
  res.status(201).json(result);
});

module.exports = router;
