const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const isoMessageService = require('../../services/isoMessageService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/transactions/:id/iso20022?format=json|xml
//   -> the ISO 20022 pacs.008.001.08 message of one of my transfers, bill payments or load
//      purchases (bank transfers: the message the payment switch sent; the rest: built from the
//      double-entry ledger entries). 404 if it is not my transaction, 422 if it is not a transfer.
router.get('/:id/iso20022', async (req, res) => {
  const message = await isoMessageService.getTransactionMessage(req.user.id, req.params.id);
  if (req.query.format === 'xml') {
    res.type('application/xml').send(message.xml);
  } else {
    res.json(message);
  }
});

module.exports = router;
