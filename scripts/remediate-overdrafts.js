#!/usr/bin/env node
/**
 * One-time data remediation after the race-condition fix (wallet row lock, src/services/walletLock.js).
 *
 * Before the fix, simultaneous transfers could overdraw a wallet (QA_NOTES.md). The fix stops new
 * overdrafts, but wallets overdrawn earlier stay below zero, and scripts/assert-ledger.js now fails
 * on any overdrawn wallet. This script brings each one back to exactly ₱0.00 the way a ledger is
 * corrected: nothing is edited or deleted, one balanced QA_ADJUSTMENT journal per wallet
 *   DEBIT  SYS-QA-ADJUSTMENT (GL 3900 Sandbox Adjustments)   overdrawn amount
 *   CREDIT customer wallet                                   overdrawn amount
 * (the same journal the QA sandbox reset posts, so the system-cash equation stays balanced).
 *
 * Usage:  node scripts/remediate-overdrafts.js           list the overdrawn wallets (dry run)
 *         node scripts/remediate-overdrafts.js --apply   post the adjustments
 * Env:    DATABASE_URL (read from .env if present). Only for demo / QA databases: play money.
 */
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://paypulse:paypulse@localhost:5432/paypulse';
const apply = process.argv.includes('--apply');
const peso = (cents) => `${cents < 0 ? '-' : ''}₱${(Math.abs(cents) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Lock the overdrawn wallets (as a payment would), then read their balances under the lock.
    const { rows: wallets } = await client.query(
      `SELECT a.id, a.account_number FROM accounts a
       JOIN account_balances ab ON ab.account_id = a.id
       WHERE NOT ab.is_system AND ab.balance_cents < 0
       ORDER BY a.id FOR UPDATE OF a`,
    );
    const { rows: [qa] } = await client.query(`SELECT id FROM accounts WHERE account_number = 'SYS-QA-ADJUSTMENT'`);

    let totalCents = 0;
    for (const wallet of wallets) {
      const { rows: [{ balance_cents: balance }] } = await client.query(
        'SELECT balance_cents FROM account_balances WHERE account_id = $1',
        [wallet.id],
      );
      const amountCents = -Number(balance);
      if (amountCents <= 0) continue;
      totalCents += amountCents;
      console.log(`${wallet.account_number.padEnd(16)} ${peso(-amountCents).padStart(14)} -> ₱0.00`);
      if (!apply) continue;
      const { rows: [tx] } = await client.query(
        `INSERT INTO transactions (type, description) VALUES ('QA_ADJUSTMENT', $1) RETURNING id`,
        ['Overdraft remediation (pre-fix race condition)'],
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents)
         VALUES ($1, $2, 'DEBIT', $4), ($1, $3, 'CREDIT', $4)`,
        [tx.id, qa.id, wallet.id, amountCents],
      );
    }

    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    if (!wallets.length) console.log('No overdrawn wallets.');
    else if (apply) console.log(`\nPosted ${wallets.length} adjusting journals (${peso(totalCents)} in total).`);
    else console.log(`\n${wallets.length} overdrawn wallets (${peso(totalCents)}). Dry run: nothing changed. Run with --apply to post the adjustments.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Remediation failed: ${err.message}`);
  process.exit(2);
});
