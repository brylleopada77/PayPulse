const express = require('express');
const authService = require('../services/authService');
const passwordResetService = require('../services/passwordResetService');

const router = express.Router();

// POST /api/auth/register  { email, password, fullName }
router.post('/register', async (req, res) => {
  const result = await authService.register(req.body || {});
  res.status(201).json(result);
});

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res) => {
  const result = await authService.login(req.body || {});
  res.json(result);
});

// POST /api/auth/password/forgot  { email }
//   -> { message, resetId, expiresInSeconds, demoCode }  (same answer for unknown emails)
router.post('/password/forgot', async (req, res) => {
  res.json(await passwordResetService.requestReset((req.body || {}).email));
});

// POST /api/auth/password/reset  { resetId, code, newPassword }  -> { message }
router.post('/password/reset', async (req, res) => {
  res.json(await passwordResetService.resetPassword(req.body || {}));
});

module.exports = router;
