const { withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');
const { badRequest, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

async function findSenderAccount(client, userId) {
  const { rows } = await client.query(
    'SELECT id, account_number, balance_cents FROM accounts WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) {
    throw notFound('ACCOUNT_NOT_FOUND', 'Sender account not found');
  }
  return rows[0];
}

async function findReceiverAccount(client, accountNumber) {
  const { rows } = await client.query(
    'SELECT id, account_number FROM accounts WHERE account_number = $1 AND is_system = false',
    [accountNumber],
  );
  if (!rows[0]) {
    throw notFound('RECEIVER_NOT_FOUND', 'Receiver account does not exist');
  }
  return rows[0];
}

/**
 * Move money from the logged-in user's wallet to another wallet.
 * Writes a balanced pair of ledger entries and updates both cached balances.
 */
async function transfer(userId, { toAccountNumber, amount, description }) {
  if (typeof toAccountNumber !== 'string' || toAccountNumber.trim() === '') {
    throw badRequest('INVALID_ACCOUNT_NUMBER', 'toAccountNumber is required');
  }
  const amountCents = toCents(amount);

  return withTransaction(async (client) => {
    const sender = await findSenderAccount(client, userId);
    const receiver = await findReceiverAccount(client, toAccountNumber.trim());

    if (sender.id === receiver.id) {
      throw badRequest('SAME_ACCOUNT', 'You cannot transfer money to your own account');
    }
    if (sender.balance_cents < amountCents) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'Insufficient balance for this transfer');
    }

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

module.exports = { transfer };
