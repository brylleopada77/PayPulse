// QA Sandbox controls. Only mounted when the server runs with QA_SANDBOX=true (see app.js);
// otherwise every /api/qa route is a 404. Each call only affects the caller's own account.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const qaService = require('../services/qaService');
const pesonetService = require('../services/pesonetService');
const complianceService = require('../services/complianceService');

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

// POST /api/qa/pesonet/run-cutoff -> settle MY queued PESONet transfers now (instead of waiting)
router.post('/pesonet/run-cutoff', async (req, res) => {
  const batch = await pesonetService.runCutoff({ cutoffAt: new Date(), userId: req.user.id });
  res.json({ batch });
});

// POST /api/qa/compliance/clear -> act as the compliance officer: close MY alerts, release the hold
router.post('/compliance/clear', async (req, res) => {
  res.json(await complianceService.clear(req.user.id));
});

module.exports = router;
