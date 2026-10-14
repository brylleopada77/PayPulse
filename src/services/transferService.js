const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const mpinService = require('./mpinService');
const otpService = require('./otpService');
const { badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

// Transfers ABOVE this amount (₱1,000.00) need a one-time code on top of the MPIN.
const OTP_THRESHOLD_CENTS = 100_000;

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

async function findReceiverAccount(db, accountNumber) {
  const { rows } = await db.query(
    'SELECT id, account_number FROM accounts WHERE account_number = $1 AND is_system = false',
    [accountNumber],
  );
  if (!rows[0]) {
    throw notFound('RECEIVER_NOT_FOUND', 'Receiver account does not exist');
  }
  return rows[0];
}

/** Load both wallets and check the transfer is allowed. `db` is the pool or a transaction client. */
async function loadParties(db, userId, toAccountNumber, amountCents) {
  const sender = await findSenderAccount(db, userId);
  const receiver = await findReceiverAccount(db, toAccountNumber);

  if (sender.id === receiver.id) {
    throw badRequest('SAME_ACCOUNT', 'You cannot transfer money to your own account');
  }
  if (sender.balance_cents < amountCents) {
    throw unprocessable('INSUFFICIENT_FUNDS', 'Insufficient balance for this transfer');
  }
  return { sender, receiver };
}

/**
 * Move money from the logged-in user's wallet to another wallet.
 *
 * Security steps before any money moves:
 *   1. The user's 6-digit MPIN must be correct.
 *   2. Above ₱1,000 the first call returns { otpRequired: true, challengeId, ... } instead of
 *      transferring; the client repeats the call with { otpChallengeId, otp }.
 *
 * Writes a balanced pair of ledger entries and updates both cached balances.
 */
async function transfer(userId, { toAccountNumber, amount, description, mpin, otpChallengeId, otp }) {
  if (typeof toAccountNumber !== 'string' || toAccountNumber.trim() === '') {
    throw badRequest('INVALID_ACCOUNT_NUMBER', 'toAccountNumber is required');
  }
  const receiverNumber = toAccountNumber.trim();
  const amountCents = toCents(amount);

  await mpinService.verifyMpin(userId, mpin);

  const needsOtp = amountCents > OTP_THRESHOLD_CENTS;
  if (needsOtp && !otpChallengeId) {
    // Fail fast (unknown receiver, insufficient funds, ...) before sending a code.
    await loadParties(pool, userId, receiverNumber, amountCents);
    const challenge = await otpService.issue(userId, { toAccountNumber: receiverNumber, amountCents });
    return { otpRequired: true, ...challenge };
  }
  if (needsOtp) {
    await otpService.verify(userId, {
      challengeId: otpChallengeId,
      code: otp,
      toAccountNumber: receiverNumber,
      amountCents,
    });
  }

  return withTransaction(async (client) => {
    if (needsOtp) {
      await otpService.consume(client, otpChallengeId);
    }
    const { sender, receiver } = await loadParties(client, userId, receiverNumber, amountCents);

    const transactionId = await recordTransaction(client, {
      type: 'TRANSFER',
      description: description || `Transfer to ${receiver.account_number}`,
      entries: [
        { accountId: sender.id, direction: 'DEBIT', amountCents },
        { accountId: receiver.id, direction: 'CREDIT', amountCents },
      ],
    });

    const senderNewBalance = sender.balance_cents - amountCents;
    await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2', [
      senderNewBalance,
      sender.id,
    ]);
    await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [
      amountCents,
      receiver.id,
    ]);

    return {
      transactionId,
      from: sender.account_number,
      to: receiver.account_number,
      amount: fromCents(amountCents),
      amountCents,
      balanceAfter: fromCents(senderNewBalance),
    };
  });
}

module.exports = { transfer, OTP_THRESHOLD_CENTS };
