/**
 * Double-entry ledger helpers.
 * Every money movement goes through recordTransaction(), which refuses to write
 * a transaction whose debits and credits do not balance.
 */

/**
 * @param client  a pg client that is already inside a transaction
 * @param type    'TRANSFER' | 'DEPOSIT'
 * @param entries [{ accountId, direction: 'DEBIT' | 'CREDIT', amountCents }]
 * @returns the new transaction id
 */
async function recordTransaction(client, { type, description, entries }) {
  const total = (direction) =>
    entries.filter((e) => e.direction === direction).reduce((sum, e) => sum + e.amountCents, 0);

  if (entries.length < 2 || total('DEBIT') !== total('CREDIT')) {
    throw new Error('Ledger entries must balance: total debits must equal total credits');
  }

  const { rows } = await client.query(
    'INSERT INTO transactions (type, description) VALUES ($1, $2) RETURNING id',
    [type, description || null],
  );
  const transactionId = rows[0].id;

  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, entry.accountId, entry.direction, entry.amountCents],
    );
  }

  return transactionId;
}

module.exports = { recordTransaction };
