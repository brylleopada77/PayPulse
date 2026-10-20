const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const { pciMask } = require('../../middleware/pciMask');
const cardService = require('../../services/cardService');
const cardPaymentService = require('../../services/cardPaymentService');
const { blockFrozenAccounts, simulateServerError } = require('../../middleware/accountGuards');
const { amlMonitor } = require('../../middleware/amlMonitor');
const { enforceTransferLimits } = require('../../middleware/transferLimits');

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

// POST /api/v1/cards/:token/payments  { amount, merchant? }  -> online purchase with the virtual card
//   201 APPROVED (wallet debited) | 403 CARD_FROZEN / CARD_EXPIRED (declined) | 422 INSUFFICIENT_FUNDS
// Same guards as a transfer: frozen account, QA forced errors, AML, daily limit / anti-spam.
router.post('/:token/payments', idempotency, blockFrozenAccounts, simulateServerError, amlMonitor, enforceTransferLimits, async (req, res) => {
  res.status(201).json(await cardPaymentService.pay(req.user.id, req.params.token, req.body || {}));
});

// POST /api/v1/cards/:token/reveal  { mpin } -> full PAN, expiry and CVV for the cardholder only.
// The only route allowed to return card data; the response is never cached (Cache-Control: no-store).
router.post('/:token/reveal', async (req, res) => {
  const details = await cardService.reveal(req.user.id, req.params.token, req.body || {});
  res.locals.allowCardData = true;
  res.json(details);
});

module.exports = router;
