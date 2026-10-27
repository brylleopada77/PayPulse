// Online purchases with the virtual Visa (mock card network: the merchant is simulated).
//
// Card payment:  DEBIT  customer wallet (GL 2010)                       amount
//                CREDIT Card Settlement - Payable to Merchants (GL 2050)  amount
//
// A locked (FROZEN) card is declined with 403 CARD_FROZEN, an expired one with 403 CARD_EXPIRED.
// The card row and the wallet are locked during the authorization (walletLock.js), so the balance,
// limit and AML checks can't be raced. Card payments count toward the daily limit, anti-spam and AML.
const crypto = require('crypto');
const { recordTransaction } = require('./ledgerService');
const { lockWallet, checkOutgoing, withPaymentTransaction } = require('./walletLock');
const mpinService = require('./mpinService');
const { referenceFor } = require('./receiptService');
const { AppError, badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const SETTLEMENT_ACCOUNT = 'SYS-CARD-SETTLEMENT';
const MERCHANTS = ['Lazada', 'Shopee', 'Netflix', 'Spotify', 'Grab', 'Steam', 'Online store'];
const maskPan = (bin, last4) => `${bin.slice(0, 4)} ${bin.slice(4, 6)}•• •••• ${last4}`;

function declined(code, message) {
  return new AppError(403, code, message, { details: { declined: true } });
}

/** POST /api/v1/cards/:token/payments { amount, merchant }: authorize and capture in one step. */
async function pay(userId, token, { amount, merchant, mpin } = {}) {
  const amountCents = toCents(amount);
  const shop = String(merchant ?? 'Online store').trim().replace(/\s+/g, ' ');
  if (shop.length < 2 || shop.length > 60) throw badRequest('INVALID_MERCHANT', 'Merchant name must be 2 to 60 characters');

  return withPaymentTransaction(async (client) => {
    const { rows: [card] } = await client.query(
      `SELECT vc.*, (make_date(vc.expiry_year, vc.expiry_month, 1) + interval '1 month') <= now() AS is_expired
       FROM virtual_cards vc WHERE vc.user_id = $1 AND vc.token = $2 FOR UPDATE`,
      [userId, String(token)],
    );
    if (!card) throw notFound('CARD_NOT_FOUND', 'Card not found');
    if (card.status === 'FROZEN') {
      throw declined('CARD_FROZEN', 'Payment declined: this card is locked. Unlock it in the Card tab to pay.');
    }
    if (card.is_expired) throw declined('CARD_EXPIRED', 'Payment declined: this card has expired.');
    // Money leaves the wallet: confirm it is the cardholder (a locked card is declined above first).
    await mpinService.verifyMpin(userId, mpin);

    const { balanceCents: balance } = await lockWallet(client, userId);
    await checkOutgoing(client, userId, amountCents, 'POST /api/v1/cards/:token/payments');
    if (balance < amountCents) throw unprocessable('INSUFFICIENT_FUNDS', 'Payment declined: your wallet balance is too low');

    const settlement = await client.query('SELECT id FROM accounts WHERE account_number = $1', [SETTLEMENT_ACCOUNT]);
    const transactionId = await recordTransaction(client, {
      type: 'CARD_PAYMENT',
      description: `Card payment - ${shop}`,
      entries: [
        { accountId: card.account_id, direction: 'DEBIT', amountCents },
        { accountId: settlement.rows[0].id, direction: 'CREDIT', amountCents },
      ],
    });
    const authCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    await client.query(
      `INSERT INTO card_payments (card_id, user_id, merchant, amount_cents, auth_code, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [card.id, userId, shop, amountCents, authCode, transactionId],
    );

    return {
      status: 'APPROVED',
      authCode,
      merchant: shop,
      amount: fromCents(amountCents),
      card: { token: card.token, maskedPan: maskPan(card.bin, card.last4), last4: card.last4 },
      transactionId,
      reference: await referenceFor(client, transactionId),
      balanceAfter: fromCents(balance - amountCents),
    };
  });
}

module.exports = { pay, MERCHANTS };
