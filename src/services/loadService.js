// Buy Load (mobile prepaid top-up) with the PayPulse ₱5.00 load cashback.
//
// Load purchase: DEBIT  customer wallet (GL 2010)                      amount
//                CREDIT Telco Settlement - Payable to Telcos (GL 2060)  amount
// Cashback:      DEBIT  Marketing Expense - Cashback (GL 5020)           ₱5.00
//                CREDIT customer wallet                                  ₱5.00
//
// Both journals are written in ONE database transaction under a lock on the wallet (no overdraft,
// a purchase never ends up without its cashback). Cashback guardrails: loads of ₱50 or more, at
// most 3 load cashbacks per customer per day (Manila); separate from the Pay Bills cashback.
const { pool } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { lockWallet, checkOutgoing, withPaymentTransaction } = require('./walletLock');
const { formatReference } = require('./receiptService');
const mpinService = require('./mpinService');
const telcos = require('./telcos');
const { badRequest, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const CASHBACK_CENTS = 500; // ₱5.00
const CASHBACK_MIN_CENTS = 5_000; // ₱50.00
const CASHBACK_DAILY_MAX = 3;
const TIME_ZONE = 'Asia/Manila';
const SETTLEMENT_ACCOUNT = 'SYS-TELCO-SETTLEMENT';
const CASHBACK_ACCOUNT = 'SYS-CASHBACK-EXPENSE';

/** REF-LOAD-<date in Manila>-<transaction id> */
const loadReference = (transactionId, createdAt) => formatReference(transactionId, createdAt).replace(/^REF-/, 'REF-LOAD-');

async function cashbacksToday(db, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM load_purchases lp JOIN users u ON u.id = lp.user_id
     WHERE lp.user_id = $1 AND lp.cashback_cents > 0
       AND lp.created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
       AND lp.created_at > COALESCE(u.history_cleared_at, '-infinity')`,
    [userId, TIME_ZONE],
  );
  return rows[0].n;
}

const cashbackStatus = (usedToday) => ({
  amount: fromCents(CASHBACK_CENTS),
  minAmount: fromCents(CASHBACK_MIN_CENTS),
  dailyMax: CASHBACK_DAILY_MAX,
  usedToday,
  remainingToday: Math.max(0, CASHBACK_DAILY_MAX - usedToday),
});

/** GET /api/v1/load: networks, brands, amounts, promos and today's cashback status. */
async function getCatalog(userId) {
  return { ...telcos.catalog(), cashback: cashbackStatus(await cashbacksToday(pool, userId)) };
}

/** GET /api/v1/load/detect?mobile=0917…: the network for a number. */
function detect(mobile) {
  const number = telcos.normalizeMobile(mobile);
  if (!number) throw badRequest('INVALID_MOBILE', 'Enter an 11-digit mobile number, e.g. 09171234567');
  const network = telcos.detectNetwork(number);
  return {
    mobileNumber: number,
    detected: Boolean(network),
    network: network ? { code: network.code, name: network.name, brands: network.brands } : null,
  };
}

function validate({ mobileNumber, brand: brandCode, productType, amount, promoCode }) {
  const number = telcos.normalizeMobile(mobileNumber);
  if (!number) throw badRequest('INVALID_MOBILE', 'Enter an 11-digit mobile number, e.g. 09171234567');
  const brand = telcos.findBrand(brandCode);
  if (!brand) throw badRequest('INVALID_BRAND', 'Choose the mobile network brand (Globe, TM, Smart, TNT, DITO or GOMO)');

  if (productType === 'PROMO') {
    const promo = telcos.findPromo(promoCode);
    if (!promo) throw badRequest('UNKNOWN_PROMO', 'Choose a promo from the list');
    if (promo.brand !== brand.code) {
      throw badRequest('PROMO_NOT_FOR_BRAND', `${promo.name} is a ${telcos.BRANDS[promo.brand].name} promo, not ${brand.name}`);
    }
    return { number, brand, productCode: promo.code, productName: promo.name, amountCents: promo.price * 100 };
  }
  if (productType === 'REGULAR') {
    const amountCents = toCents(amount);
    if (amountCents % 100 !== 0 || amountCents < telcos.CUSTOM_MIN * 100 || amountCents > telcos.CUSTOM_MAX * 100) {
      throw badRequest('INVALID_LOAD_AMOUNT', `Regular load is a whole amount from ₱${telcos.CUSTOM_MIN} to ₱${telcos.CUSTOM_MAX.toLocaleString('en-PH')}`)
        .withDetails({ min: fromCents(telcos.CUSTOM_MIN * 100), max: fromCents(telcos.CUSTOM_MAX * 100) });
    }
    return { number, brand, productCode: 'REGULAR', productName: `Regular Load ₱${amountCents / 100}`, amountCents };
  }
  throw badRequest('INVALID_PRODUCT_TYPE', 'productType must be REGULAR or PROMO');
}

const systemAccountId = async (client, accountNumber) =>
  (await client.query('SELECT id FROM accounts WHERE account_number = $1', [accountNumber])).rows[0].id;

/** POST /api/v1/load/purchase: buy the load, then credit the cashback if it applies. Needs the MPIN. */
async function purchase(userId, body = {}) {
  const { number, brand, productCode, productName, amountCents } = validate(body);
  await mpinService.verifyMpin(userId, body.mpin);

  return withPaymentTransaction(async (client) => {
    const { id: walletId, balanceCents: balanceBefore } = await lockWallet(client, userId);
    await checkOutgoing(client, userId, amountCents, 'POST /api/v1/load/purchase');
    if (balanceBefore < amountCents) throw unprocessable('INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this load');

    const transactionId = await recordTransaction(client, {
      type: 'LOAD_PURCHASE',
      description: `Buy Load - ${brand.name} (${number})`,
      entries: [
        { accountId: walletId, direction: 'DEBIT', amountCents },
        { accountId: await systemAccountId(client, SETTLEMENT_ACCOUNT), direction: 'CREDIT', amountCents },
      ],
    });

    const usedToday = await cashbacksToday(client, userId);
    let cashbackReason = null;
    if (amountCents < CASHBACK_MIN_CENTS) cashbackReason = 'BELOW_MINIMUM';
    else if (usedToday >= CASHBACK_DAILY_MAX) cashbackReason = 'DAILY_LIMIT_REACHED';
    let cashbackTransactionId = null;
    if (!cashbackReason) {
      cashbackTransactionId = await recordTransaction(client, {
        type: 'CASHBACK',
        description: 'Cashback Reward - Buy Load',
        entries: [
          { accountId: await systemAccountId(client, CASHBACK_ACCOUNT), direction: 'DEBIT', amountCents: CASHBACK_CENTS },
          { accountId: walletId, direction: 'CREDIT', amountCents: CASHBACK_CENTS },
        ],
      });
    }
    const cashbackCents = cashbackTransactionId ? CASHBACK_CENTS : 0;

    const { rows: [row] } = await client.query(
      `INSERT INTO load_purchases (user_id, mobile_number, brand, network, product_code, product_name,
                                   amount_cents, cashback_cents, transaction_id, cashback_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
      [userId, number, brand.code, brand.network, productCode, productName, amountCents, cashbackCents, transactionId, cashbackTransactionId],
    );
    const { rows: [tx] } = await client.query('SELECT created_at FROM transactions WHERE id = $1', [transactionId]);

    return {
      loadPurchaseId: row.id,
      reference: loadReference(transactionId, tx.created_at),
      status: 'SUCCESSFUL',
      mobileNumber: number,
      brand: { code: brand.code, name: brand.name, network: brand.network },
      product: { type: productCode === 'REGULAR' ? 'REGULAR' : 'PROMO', code: productCode, name: productName },
      amount: fromCents(amountCents),
      cashback: {
        ...cashbackStatus(usedToday + (cashbackCents > 0 ? 1 : 0)),
        earned: cashbackCents > 0,
        amount: fromCents(cashbackCents),
        reason: cashbackReason,
      },
      transactionId,
      cashbackTransactionId,
      balanceAfter: fromCents(balanceBefore - amountCents + cashbackCents),
      createdAt: row.created_at,
    };
  });
}

module.exports = { getCatalog, detect, validate, purchase, loadReference, CASHBACK_CENTS, CASHBACK_MIN_CENTS, CASHBACK_DAILY_MAX };
