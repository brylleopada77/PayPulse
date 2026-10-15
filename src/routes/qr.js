const express = require('express');
const { requireAuth } = require('../middleware/auth');
const qrService = require('../services/qrService');

const router = express.Router();

router.use(requireAuth);

// GET /api/qr/me?amount=250  -> { accountNumber, name, amount, payload, svg }  ("Receive via QR")
router.get('/me', async (req, res) => {
  res.json(await qrService.getMyQr(req.user.id, req.query.amount));
});

// POST /api/qr/decode  { payload }  -> { format, accountNumber, receiverName, amount, isOwnAccount }
//   400 INVALID_QR / QR_CHECKSUM_MISMATCH / QR_NOT_SUPPORTED, 404 RECEIVER_NOT_FOUND
router.post('/decode', async (req, res) => {
  res.json(await qrService.decode(req.user.id, (req.body || {}).payload));
});

module.exports = router;
