const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const profileService = require('../../services/profileService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/profile -> KYC level + tiers, security preferences, linked accounts, support tickets
router.get('/', async (req, res) => {
  res.json(await profileService.getProfile(req.user.id));
});

// POST /api/v1/profile/kyc  { idType, idNumber, birthDate, selfieConfirmed } -> Level 2 (mock check)
router.post('/kyc', async (req, res) => {
  res.json(await profileService.verifyKyc(req.user.id, req.body || {}));
});

// POST /api/v1/profile/linked-accounts
//   { kind: "BANK", bankCode, accountNumber, holderName, mpin }
//   { kind: "CARD", cardNumber, expiry: "MM/YY", holderName, mpin }
router.post('/linked-accounts', async (req, res) => {
  res.status(201).json(await profileService.linkAccount(req.user.id, req.body || {}));
});

// DELETE /api/v1/profile/linked-accounts/:id
router.delete('/linked-accounts/:id', async (req, res) => {
  await profileService.unlinkAccount(req.user.id, req.params.id);
  res.status(204).end();
});

// PATCH /api/v1/profile/security  { smsTwoFactor?, biometricLogin?, mpin? (to turn SMS 2FA off) }
router.patch('/security', async (req, res) => {
  res.json(await profileService.updateSecurity(req.user.id, req.body || {}));
});

// POST /api/v1/profile/support/tickets  { category, subject, message }
router.post('/support/tickets', async (req, res) => {
  res.status(201).json(await profileService.createTicket(req.user.id, req.body || {}));
});

module.exports = router;
