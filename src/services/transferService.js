const crypto = require('crypto');
const { pool } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const mpinService = require('./mpinService');
const otpService = require('./otpService');
const paymentSwitch = require('./paymentSwitch');
const { nextCutoff } = require('./pesonetService');
const { BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, RAILS, findBank } = require('./banks');
const { badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');
const { normalizeMobile, requireMobile } = require('../utils/mobile');
const { maskAccount, shortName } = require('../utils/privacy');
const { referenceFor } = require('./receiptService');
const { lockWallet, checkOutgoing, withPaymentTransaction } = require('./walletLock');

// Transfers ABOVE this amount (₱1,000.00) need a one-time code on top of the MPIN.
const OTP_THRESHOLD_CENTS = 100_000;
const SETTLEMENT_ACCOUNT = 'SYS-BANK-SETTLEMENT'; // GL 1020 Bank Clearing - Settled Outbound Payments
const PESONET_CLEARING_ACCOUNT = 'SYS-PESONET-CLEARING'; // GL 2020 PESONet Clearing - Pending Outbound
const FEE_ACCOUNT = 'SYS-FEE-INCOME'; // GL 4010 Fee Revenue - Bank Transfers

const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

// ---------- Lookups ----------

/**
 * The sender's wallet with its balance COMPUTED from the ledger (view account_balances).
 *
 * Inside a transfer this runs after lockWallet() (runSecured), so the balance can't change before
 * the ledger postings commit. (Before that lock, two simultaneous transfers both read the same
 * balance and overdrew the wallet: QA_NOTES.md.) Without the lock it is only the OTP step's
 * fail-fast preview.
 */
async function findSenderAccount(db, userId) {
  const { rows } = await db.query(
    `SELECT ab.account_id AS id, ab.account_number, ab.balance_cents, u.full_name
     FROM account_balances ab JOIN users u ON u.id = ab.user_id
     WHERE ab.user_id = $1`,
    [userId],
  );
  if (!rows[0]) {
    throw notFound('ACCOUNT_NOT_FOUND', 'Sender account not found');
  }
  return rows[0];
}

/** Find the receiving wallet by PayPulse account number or by mobile number. */
async function findReceiver(db, recipient) {
  const { rows } = recipient.mobileNumber
    ? await db.query(
        `SELECT a.id, a.account_number, u.full_name
         FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE u.mobile_number = $1 AND a.is_system = false`,
        [recipient.mobileNumber],
      )
    : await db.query(
        `SELECT a.id, a.account_number, u.full_name
         FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE a.account_number = $1 AND a.is_system = false`,
        [recipient.accountNumber],
      );
  if (!rows[0]) {
    throw notFound(
      'RECEIVER_NOT_FOUND',
      recipient.mobileNumber ? 'No PayPulse account uses this mobile number' : 'Receiver account does not exist',
    );
  }
  return rows[0];
}

async function systemAccountId(db, accountNumber) {
  const { rows } = await db.query('SELECT id FROM accounts WHERE account_number = $1', [accountNumber]);
  return rows[0].id;
}

/** Load the sender's wallet and check its (computed) balance covers `totalCents`. */
async function loadSender(db, userId, totalCents, insufficientMessage) {
  const sender = await findSenderAccount(db, userId);
  if (sender.balance_cents < totalCents) {
    throw unprocessable('INSUFFICIENT_FUNDS', insufficientMessage || 'Insufficient balance for this transfer');
  }
  return sender;
}

// ---------- Shared security pipeline ----------

/**
 * MPIN for every transfer, plus an OTP above ₱1,000. The OTP is bound to `destinationKey`
 * and `amountCents`, so a code can't be reused for another recipient or amount.
 *
 * Without an OTP yet (and above the threshold), `preflight` runs the usual checks and the call
 * returns { otpRequired: true, ... } instead of moving money. Otherwise `execute(client)` runs
 * inside one database transaction that first locks the sender's wallet row (SELECT ... FOR UPDATE)
 * and re-runs the AML and limit checks under that lock: simultaneous transfers from one wallet run
 * one after the other, and any failed check rolls everything back.
 */
async function runSecured(userId, { destinationKey, amountCents, mpin, otpChallengeId, otp, endpoint }, { preflight, execute }) {
  await mpinService.verifyMpin(userId, mpin);

  // Above ₱1,000 always; for every amount when the user turned on "SMS 2FA on every transfer".
  const { rows: [prefs] } = await pool.query('SELECT sms_2fa_all FROM users WHERE id = $1', [userId]);
  const needsOtp = amountCents > OTP_THRESHOLD_CENTS || prefs?.sms_2fa_all === true;
  if (needsOtp && !otpChallengeId) {
    await preflight(pool); // fail fast (unknown receiver, insufficient funds, ...) before sending a code
    const challenge = await otpService.issue(userId, { toAccountNumber: destinationKey, amountCents });
    return { otpRequired: true, ...challenge };
  }
  if (needsOtp) {
    await otpService.verify(userId, { challengeId: otpChallengeId, code: otp, toAccountNumber: destinationKey, amountCents });
  }

  return withPaymentTransaction(async (client) => {
    await lockWallet(client, userId);
    await checkOutgoing(client, userId, amountCents, endpoint);
    if (needsOtp) await otpService.consume(client, otpChallengeId);
    return execute(client);
  });
}

// ---------- Express Send (PayPulse to PayPulse, free) ----------

function parseRecipient({ toAccountNumber, toMobileNumber }) {
  if (toMobileNumber !== undefined && toMobileNumber !== null && toMobileNumber !== '') {
    const mobileNumber = requireMobile(toMobileNumber);
    return { mobileNumber, key: `MOBILE:${mobileNumber}` };
  }
  if (typeof toAccountNumber !== 'string' || toAccountNumber.trim() === '') {
    throw badRequest('INVALID_ACCOUNT_NUMBER', 'toAccountNumber or toMobileNumber is required');
  }
  const accountNumber = toAccountNumber.trim();
  return { accountNumber, key: accountNumber };
}

/**
 * Express Send: move money to another PayPulse wallet (by account number or mobile number).
 * No fee. Posts one balanced journal: DEBIT sender wallet, CREDIT receiver wallet (both GL 2010).
 * Balances are never edited: they follow from these ledger entries.
 */
async function transfer(userId, input) {
  const recipient = parseRecipient(input);
  const amountCents = toCents(input.amount);

  const checkParties = async (db) => {
    const sender = await findSenderAccount(db, userId);
    const receiver = await findReceiver(db, recipient);
    if (sender.id === receiver.id) {
      throw badRequest('SAME_ACCOUNT', 'You cannot transfer money to your own account');
    }
    if (sender.balance_cents < amountCents) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'Insufficient balance for this transfer');
    }
    return { sender, receiver };
  };

  return runSecured(userId, { ...input, destinationKey: recipient.key, amountCents, endpoint: 'POST /api/transfers' }, {
    preflight: checkParties,
    execute: async (client) => {
      const { sender, receiver } = await checkParties(client);

      const transactionId = await recordTransaction(client, {
        type: 'TRANSFER',
        description: input.description || `Transfer to ${receiver.account_number}`,
        entries: [
          { accountId: sender.id, direction: 'DEBIT', amountCents },
          { accountId: receiver.id, direction: 'CREDIT', amountCents },
        ],
      });

      return {
        method: 'EXPRESS',
        transactionId,
        reference: await referenceFor(client, transactionId),
        from: sender.account_number,
        to: receiver.account_number,
        receiverName: shortName(receiver.full_name),
        amount: fromCents(amountCents),
        amountCents,
        fee: fromCents(0),
        feeCents: 0,
        totalDeducted: fromCents(amountCents),
        totalDeductedCents: amountCents,
        balanceAfter: fromCents(sender.balance_cents - amountCents),
      };
    },
  });
}

// ---------- Bank Transfer (to an outside bank / e-wallet, ₱15 fee) ----------

function parseBankDestination({ bankCode, accountNumber, accountName, rail = 'INSTAPAY' }) {
  const bank = findBank(typeof bankCode === 'string' ? bankCode.trim().toUpperCase() : bankCode);
  if (!bank) {
    throw badRequest('INVALID_BANK', 'Choose a bank or e-wallet from the list (GET /api/transfers/banks)');
  }

  const railInfo = RAILS[typeof rail === 'string' ? rail.trim().toUpperCase() : rail];
  if (!railInfo) {
    throw badRequest('INVALID_RAIL', 'rail must be "INSTAPAY" or "PESONET"');
  }
  if (!bank.rails.includes(railInfo.code)) {
    throw badRequest('RAIL_NOT_SUPPORTED', `${bank.name} receives ${bank.rails.map((r) => RAILS[r].name).join(' or ')} transfers only`)
      .withDetails({ bankCode: bank.code, rail: railInfo.code, supportedRails: bank.rails });
  }

  let account;
  if (bank.accountType === 'MOBILE') {
    account = normalizeMobile(accountNumber);
    if (!account) {
      throw badRequest('INVALID_BANK_ACCOUNT', `Enter the recipient's ${bank.name} mobile number, e.g. 09171234567`);
    }
  } else {
    account = typeof accountNumber === 'string' ? accountNumber.replace(/[\s-]/g, '') : '';
    if (!BANK_ACCOUNT_PATTERN.test(account)) {
      throw badRequest('INVALID_BANK_ACCOUNT', `Enter a valid ${bank.name} account number (10 to 16 digits)`);
    }
  }

  const name = typeof accountName === 'string' ? accountName.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 100) {
    throw badRequest('INVALID_ACCOUNT_NAME', "Enter the account holder's name");
  }
  return { bank, account, name, rail: railInfo };
}

/**
 * Bank Transfer: send money out of PayPulse through InstaPay (instant) or PESONet (batch).
 * The user pays amount + ₱15 fee. One balanced journal:
 *   DEBIT  customer wallet (GL 2010)                    amount + fee
 *   CREDIT bank clearing  (GL 1020, InstaPay)  or
 *          PESONet clearing (GL 2020, until the cut-off) amount
 *   CREDIT fee revenue (GL 4010)                        fee
 * The payment switch then records the outbound ISO 20022 pacs.008 message.
 */
async function bankTransfer(userId, input) {
  const { bank, account, name, rail } = parseBankDestination(input);
  const amountCents = toCents(input.amount);
  if (rail.maxCents !== null && amountCents > rail.maxCents) {
    throw badRequest(
      'INSTAPAY_LIMIT_EXCEEDED',
      `InstaPay transfers are limited to ${peso(rail.maxCents)} each. Use PESONet for larger amounts.`,
    );
  }
  const feeCents = BANK_TRANSFER_FEE_CENTS;
  const totalCents = amountCents + feeCents;
  const insufficient =
    `Insufficient balance: this transfer needs ${peso(totalCents)} ` +
    `(${peso(amountCents)} + ${peso(feeCents)} fee)`;

  const destinationKey = `BANK:${rail.code}:${bank.code}:${account}`;
  return runSecured(userId, { ...input, destinationKey, amountCents, endpoint: 'POST /api/transfers/bank' }, {
    preflight: (db) => loadSender(db, userId, totalCents, insufficient),
    execute: async (client) => {
      const sender = await loadSender(client, userId, totalCents, insufficient);
      const isPesonet = rail.code === 'PESONET';
      const outboundId = await systemAccountId(client, isPesonet ? PESONET_CLEARING_ACCOUNT : SETTLEMENT_ACCOUNT);
      const feeAccountId = await systemAccountId(client, FEE_ACCOUNT);

      const transactionId = await recordTransaction(client, {
        type: 'BANK_TRANSFER',
        description: `Bank Transfer to ${bank.name}`,
        entries: [
          { accountId: sender.id, direction: 'DEBIT', amountCents: totalCents },
          { accountId: outboundId, direction: 'CREDIT', amountCents },
          { accountId: feeAccountId, direction: 'CREDIT', amountCents: feeCents },
        ],
      });
      const reference = await referenceFor(client, transactionId);

      const bankReference = `BT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const inserted = await client.query(
        `INSERT INTO bank_transfers
           (reference, transaction_id, user_id, bank_code, account_number, account_name, amount_cents, fee_cents,
            rail, status, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 = 'SETTLED' THEN now() END)
         RETURNING id`,
        [bankReference, transactionId, userId, bank.code, account, name, amountCents, feeCents,
          rail.code, isPesonet ? 'QUEUED' : 'SETTLED'],
      );

      const message = await paymentSwitch.submitOutbound(client, {
        bankTransferId: inserted.rows[0].id,
        rail: rail.code,
        reference,
        bankReference,
        amountCents,
        feeCents,
        debtor: { name: sender.full_name, account: sender.account_number },
        creditor: { name, account, bic: bank.bic },
        remittance: input.description || `PayPulse ${reference}`,
      });

      return {
        method: 'BANK',
        transactionId,
        reference,
        bankReference,
        from: sender.account_number,
        bank: { code: bank.code, name: bank.name },
        accountNumber: maskAccount(account),
        accountName: name,
        rail: rail.code,
        status: message.status,
        expectedSettlementAt: isPesonet ? nextCutoff() : new Date(),
        iso20022: { messageType: 'pacs.008.001.08', msgId: message.msgId, uetr: message.uetr },
        amount: fromCents(amountCents),
        amountCents,
        fee: fromCents(feeCents),
        feeCents,
        totalDeducted: fromCents(totalCents),
        totalDeductedCents: totalCents,
        balanceAfter: fromCents(sender.balance_cents - totalCents),
      };
    },
  });
}

module.exports = { transfer, bankTransfer, OTP_THRESHOLD_CENTS };
