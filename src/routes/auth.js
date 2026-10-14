const express = require('express');
const authService = require('../services/authService');

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

module.exports = router;
