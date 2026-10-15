const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { pciMask } = require('../../middleware/pciMask');
const cardService = require('../../services/cardService');

const router = express.Router();

// Every card endpoint: logged in, PCI masking safety net, never cached.
router.use(requireAuth, pciMask);

// POST /api/v1/cards/generate  { mpin }  -> new tokenized virtual Visa card (masked)
router.post('/generate', idempotency, async (req, res) => {
  res.status(201).json(await cardService.generate(req.user.id, req.body || {}));
});

// GET /api/v1/cards -> my cards (token + masked PAN only)
router.get('/', async (req, res) => {
  res.json({ cards: await cardService.listCards(req.user.id) });
});

// GET /api/v1/cards/:token -> one card (masked)
router.get('/:token', async (req, res) => {
  res.json(await cardService.getCard(req.user.id, req.params.token));
});

// PATCH /api/v1/cards/:token  { status: "ACTIVE" | "FROZEN" }
router.patch('/:token', async (req, res) => {
  res.json(await cardService.setStatus(req.user.id, req.params.token, (req.body || {}).status));
});

// POST /api/v1/cards/:token/reveal  { mpin } -> full PAN, expiry and CVV for the cardholder only.
// The only route allowed to return card data; the response is never cached (Cache-Control: no-store).
router.post('/:token/reveal', async (req, res) => {
  const details = await cardService.reveal(req.user.id, req.params.token, req.body || {});
  res.locals.allowCardData = true;
  res.json(details);
});

module.exports = router;
