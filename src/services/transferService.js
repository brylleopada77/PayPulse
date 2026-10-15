const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const mpinService = require('./mpinService');
const otpService = require('./otpService');
const { BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, findBank } = require('./banks');
const { badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');
const { normalizeMobile, requireMobile } = require('../utils/mobile');

// Transfers ABOVE this amount (₱1,000.00) need a one-time code on top of the MPIN.
const OTP_THRESHOLD_CENTS = 100_000;
const SETTLEMENT_ACCOUNT = 'SYS-BANK-SETTLEMENT';
const FEE_ACCOUNT = 'SYS-FEE-INCOME';

// ---------- Lookups ----------

async function findSenderAccount(db, userId) {
  const { rows } = await db.query(
    'SELECT id, account_number, balance_cents FROM accounts WHERE user_id = $1',
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

/**
 * Load the sender's wallet and check it can cover `totalCents`.
 * NOTE: a plain read without a row lock: this is the intentional race condition (QA_NOTES.md).
 */
async function loadSender(db, userId, totalCents, insufficientMessage) {
  const sender = await findSenderAccount(db, userId);
  if (sender.balance_cents < totalCents) {
    throw unprocessable('INSUFFICIENT_FUNDS', insufficientMessage || 'Insufficient balance for this transfer');
  }
  return sender;
}

/** "Maria Santos" -> "Maria S." (enough to confirm the recipient without exposing the full name). */
function shortName(fullName) {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.pop();
  return last ? `${first} ${last[0]}.` : first;
}

// ---------- Shared security pipeline ----------

/**
 * MPIN for every transfer, plus an OTP above ₱1,000. The OTP is bound to `destinationKey`
 * and `amountCents`, so a code can't be reused for another recipient or amount.
 *
 * Without an OTP yet (and above the threshold), `preflight` runs the usual checks and the call
 * returns { otpRequired: true, ... } instead of moving money. Otherwise `execute(client)` runs
 * inside one database transaction.
 */
async function runSecured(userId, { destinationKey, amountCents, mpin, otpChallengeId, otp }, { preflight, execute }) {
  await mpinService.verifyMpin(userId, mpin);

  const needsOtp = amountCents > OTP_THRESHOLD_CENTS;
  if (needsOtp && !otpChallengeId) {
    await preflight(pool); // fail fast (unknown receiver, insufficient funds, ...) before sending a code
    const challenge = await otpService.issue(userId, { toAccountNumber: destinationKey, amountCents });
    return { otpRequired: true, ...challenge };
  }
  if (needsOtp) {
    await otpService.verify(userId, { challengeId: otpChallengeId, code: otp, toAccountNumber: destinationKey, amountCents });
  }

  return withTransaction(async (client) => {
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
 * No fee. Writes a balanced pair of ledger entries and updates both cached balances.
 */
async function transfer(userId, input) {
  const recipient = parseRecipient(input);
  const amountCents = toCents(input.amount);

  // NOTE: the sender is read without a row lock: this is the intentional race condition (QA_NOTES.md).
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

  return runSecured(userId, { ...input, destinationKey: recipient.key, amountCents }, {
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

      const senderNewBalance = sender.balance_cents - amountCents;
      await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2', [senderNewBalance, sender.id]);
      await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [
        amountCents,
        receiver.id,
      ]);

      return {
        method: 'EXPRESS',
        transactionId,
        from: sender.account_number,
        to: receiver.account_number,
        receiverName: shortName(receiver.full_name),
        amount: fromCents(amountCents),
        amountCents,
        fee: fromCents(0),
        feeCents: 0,
        totalDeducted: fromCents(amountCents),
        totalDeductedCents: amountCents,
        balanceAfter: fromCents(senderNewBalance),
      };
    },
  });
}

// ---------- Bank Transfer (to an outside bank / e-wallet, ₱15 fee) ----------

function parseBankDestination({ bankCode, accountNumber, accountName }) {
  const bank = findBank(typeof bankCode === 'string' ? bankCode.trim().toUpperCase() : bankCode);
  if (!bank) {
    throw badRequest('INVALID_BANK', 'Choose one of: GCash, Maya, BDO, BPI, Metrobank');
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
  return { bank, account, name };
}

function maskAccount(account) {
  return `••••${account.slice(-4)}`;
}

/**
 * Bank Transfer: send money out of PayPulse. The user pays amount + ₱15 fee.
 * Ledger: DEBIT user (amount + fee), CREDIT bank settlement (amount), CREDIT fee income (fee).
 */
async function bankTransfer(userId, input) {
  const { bank, account, name } = parseBankDestination(input);
  const amountCents = toCents(input.amount);
  const feeCents = BANK_TRANSFER_FEE_CENTS;
  const totalCents = amountCents + feeCents;
  const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
  const insufficient =
    `Insufficient balance: this transfer needs ${peso(totalCents)} ` +
    `(${peso(amountCents)} + ${peso(feeCents)} fee)`;

  return runSecured(userId, { ...input, destinationKey: `BANK:${bank.code}:${account}`, amountCents }, {
    preflight: (db) => loadSender(db, userId, totalCents, insufficient),
    execute: async (client) => {
      const sender = await loadSender(client, userId, totalCents, insufficient);
      const settlementId = await systemAccountId(client, SETTLEMENT_ACCOUNT);
      const feeAccountId = await systemAccountId(client, FEE_ACCOUNT);

      const transactionId = await recordTransaction(client, {
        type: 'BANK_TRANSFER',
        description: `Bank Transfer to ${bank.name}`,
        entries: [
          { accountId: sender.id, direction: 'DEBIT', amountCents: totalCents },
          { accountId: settlementId, direction: 'CREDIT', amountCents },
          { accountId: feeAccountId, direction: 'CREDIT', amountCents: feeCents },
        ],
      });

      const senderNewBalance = sender.balance_cents - totalCents;
      await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2', [senderNewBalance, sender.id]);
      await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [
        amountCents,
        settlementId,
      ]);
      await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [
        feeCents,
        feeAccountId,
      ]);

      const reference = `BT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await client.query(
        `INSERT INTO bank_transfers
           (reference, transaction_id, user_id, bank_code, account_number, account_name, amount_cents, fee_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [reference, transactionId, userId, bank.code, account, name, amountCents, feeCents],
      );

      return {
        method: 'BANK',
        transactionId,
        reference,
        from: sender.account_number,
        bank: { code: bank.code, name: bank.name },
        accountNumber: maskAccount(account),
        accountName: name,
        amount: fromCents(amountCents),
        amountCents,
        fee: fromCents(feeCents),
        feeCents,
        totalDeducted: fromCents(totalCents),
        totalDeductedCents: totalCents,
        balanceAfter: fromCents(senderNewBalance),
      };
    },
  });
}

module.exports = { transfer, bankTransfer, OTP_THRESHOLD_CENTS, maskAccount };
