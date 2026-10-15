const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { enforceTransferLimits } = require('../middleware/transferLimits');
const { blockFrozenAccounts, simulateServerError } = require('../middleware/accountGuards');
const { amlMonitor } = require('../middleware/amlMonitor');
const { idempotency } = require('../middleware/idempotency');
const transferService = require('../services/transferService');
const limitsService = require('../services/limitsService');
const paymentSwitch = require('../services/paymentSwitch');
const pesonetService = require('../services/pesonetService');
const { BANKS, RAILS, BANK_TRANSFER_FEE_CENTS } = require('../services/banks');
const { fromCents } = require('../utils/money');

const router = express.Router();

// Every outgoing transfer passes, in order:
//   requireAuth -> idempotency (replay) -> blockFrozenAccounts (423) -> simulateServerError (QA 500)
//   -> amlMonitor (403 TRANSACTION_HELD_FOR_REVIEW) -> enforceTransferLimits (429 / 400)
// and then answers:
//   201 -> transfer completed (Bank Transfer via PESONet: status QUEUED until the cut-off)
//   202 -> amount is above ₱1,000: { otpRequired, challengeId, expiresInSeconds, demoCode };
//          repeat the same request with otpChallengeId + otp to complete it
// idempotency comes first after auth: a retry with the same Idempotency-Key replays the first answer.
const outgoingTransfer = [requireAuth, idempotency, blockFrozenAccounts, simulateServerError, amlMonitor, enforceTransferLimits];
const reply = (res, result) => res.status(result.otpRequired ? 202 : 201).json(result);

// POST /api/transfers  (Express Send, free)
//   { toAccountNumber | toMobileNumber, amount, description?, mpin, otpChallengeId?, otp? }
router.post('/', ...outgoingTransfer, async (req, res) => {
  reply(res, await transferService.transfer(req.user.id, req.body || {}));
});

// GET /api/transfers/banks  -> banks / e-wallets, rails and the fee
router.get('/banks', requireAuth, (req, res) => {
  res.json({
    fee: fromCents(BANK_TRANSFER_FEE_CENTS),
    feeCents: BANK_TRANSFER_FEE_CENTS,
    banks: BANKS,
    rails: Object.values(RAILS).map((r) => ({ ...r, max: r.maxCents === null ? null : fromCents(r.maxCents) })),
    pesonetNextCutoffAt: pesonetService.nextCutoff(),
  });
});

// GET /api/transfers/limits  -> daily limit used/remaining and the anti-spam rule
router.get('/limits', requireAuth, async (req, res) => {
  res.json(await limitsService.getLimits(req.user.id));
});

// GET /api/transfers/pesonet  -> my PESONet transfers (QUEUED / SETTLED) and the next cut-off
router.get('/pesonet', requireAuth, async (req, res) => {
  res.json(await pesonetService.getForUser(req.user.id));
});

// POST /api/transfers/bank  (Bank Transfer, ₱15 fee)
//   { bankCode, accountNumber, accountName, amount, rail?: "INSTAPAY" | "PESONET",
//     description?, mpin, otpChallengeId?, otp? }
router.post('/bank', ...outgoingTransfer, async (req, res) => {
  reply(res, await transferService.bankTransfer(req.user.id, req.body || {}));
});

// GET /api/transfers/bank/:transactionId/iso20022?format=json|xml
//   -> the outbound ISO 20022 pacs.008 message of one of my bank transfers
router.get('/bank/:transactionId/iso20022', requireAuth, async (req, res) => {
  const message = await paymentSwitch.getMessage(req.user.id, req.params.transactionId);
  if (req.query.format === 'xml') {
    res.type('application/xml').send(message.xml);
  } else {
    const { xml, ...json } = message;
    res.json(json);
  }
});

module.exports = router;
