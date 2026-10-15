// QA Sandbox controls. Only mounted when the server runs with QA_SANDBOX=true (see app.js);
// otherwise every /api/qa route is a 404. Each call only affects the caller's own account.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const qaService = require('../services/qaService');

const router = express.Router();

router.use(requireAuth);

// GET /api/qa/state -> { slowNetwork, latencyMs, failNextTransaction, frozen, historyClearedAt, balance }
router.get('/state', async (req, res) => {
  res.json(await qaService.getState(req.user.id));
});

// PUT /api/qa/settings  { slowNetwork?, failNextTransaction?, frozen? }  (booleans)
router.put('/settings', async (req, res) => {
  res.json(await qaService.updateSettings(req.user.id, req.body || {}));
});

// POST /api/qa/reset -> balance ₱1,000, history hidden, limits restarted, all switches off
router.post('/reset', async (req, res) => {
  res.json(await qaService.reset(req.user.id));
});

module.exports = router;
