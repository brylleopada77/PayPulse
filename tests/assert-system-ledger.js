#!/usr/bin/env node
/**
 * Standalone system-ledger assertion for PayPulse (plain Node.js, no test runner needed).
 *
 * Main rule:
 *   total money in the system  ==  sum(user balances) + sum(collected fees)
 *
 * where "total money in the system" is worked out from the ledger history, independently of the
 * cached balances:  top-ups paid in  -  amounts paid out to banks  +  net QA sandbox adjustments.
 * (Bank fees stay inside PayPulse, so they are still part of the money in the system.)
 *
 * Extra checks: every transaction balances (debits = credits), all balances sum to 0, and each
 * account's cached balance equals its ledger history.
 *
 * Usage:   node tests/assert-system-ledger.js          (or: npm run db:assert-ledger)
 *          node tests/assert-system-ledger.js --json   (machine-readable output)
 * Env:     DATABASE_URL (read from .env if present)
 * Exit:    0 = all checks pass, 1 = a check failed, 2 = could not run
 */
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://paypulse:paypulse@localhost:5432/paypulse';
const asJson = process.argv.includes('--json');

const peso = (cents) =>
  `${cents < 0 ? '-' : ''}₱${(Math.abs(cents) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`
      WITH entries AS (
        SELECT le.amount_cents, le.direction, t.type, a.account_number, a.is_system
        FROM ledger_entries le
        JOIN transactions t ON t.id = le.transaction_id
        JOIN accounts a ON a.id = le.account_id
      )
      SELECT
        (SELECT COALESCE(SUM(balance_cents), 0) FROM accounts WHERE NOT is_system)              AS user_balances,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM accounts WHERE account_number = 'SYS-FEE-INCOME') AS fees_cached,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM accounts)                                  AS all_balances,
        COALESCE(SUM(amount_cents) FILTER (WHERE type = 'DEPOSIT' AND direction = 'CREDIT' AND NOT is_system), 0)
                                                                                                AS deposits_in,
        COALESCE(SUM(amount_cents) FILTER (WHERE account_number = 'SYS-BANK-SETTLEMENT' AND direction = 'CREDIT'), 0)
                                                                                                AS bank_payouts,
        COALESCE(SUM(amount_cents) FILTER (WHERE account_number = 'SYS-FEE-INCOME' AND direction = 'CREDIT'), 0)
                                                                                                AS fees_collected,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                 FILTER (WHERE type = 'QA_ADJUSTMENT' AND NOT is_system), 0)                    AS qa_net
      FROM entries`);
    const n = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));

    const unbalanced = await client.query(`
      SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END)
          <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END)`);
    const mismatched = await client.query(`
      SELECT a.account_number, a.balance_cents AS cached,
             COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END), 0) AS ledger
      FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
      GROUP BY a.id
      HAVING a.balance_cents <> COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END), 0)
      ORDER BY a.account_number`);

    const totalInSystem = n.deposits_in - n.bank_payouts + n.qa_net;
    const heldByUsersAndFees = n.user_balances + n.fees_collected;

    const checks = [
      {
        check: 'Total money in system = user balances + collected fees',
        expected: peso(totalInSystem),
        actual: peso(heldByUsersAndFees),
        difference: peso(heldByUsersAndFees - totalInSystem),
        pass: heldByUsersAndFees === totalInSystem,
      },
      {
        check: 'Fee account balance = fees collected in the ledger',
        expected: peso(n.fees_collected),
        actual: peso(n.fees_cached),
        difference: peso(n.fees_cached - n.fees_collected),
        pass: n.fees_cached === n.fees_collected,
      },
      {
        check: 'All account balances (users + system) sum to 0',
        expected: peso(0),
        actual: peso(n.all_balances),
        difference: peso(n.all_balances),
        pass: n.all_balances === 0,
      },
      {
        check: 'Every transaction balances (debits = credits)',
        expected: '0 unbalanced',
        actual: `${unbalanced.rowCount} unbalanced`,
        difference: '',
        pass: unbalanced.rowCount === 0,
      },
      {
        check: 'Cached balances match ledger history',
        expected: '0 accounts off',
        actual: `${mismatched.rowCount} accounts off`,
        difference: '',
        pass: mismatched.rowCount === 0,
      },
    ];
    const ok = checks.every((c) => c.pass);

    const breakdown = {
      topUpsPaidIn: peso(n.deposits_in),
      paidOutToBanks: peso(n.bank_payouts),
      qaAdjustmentsNet: peso(n.qa_net),
      totalMoneyInSystem: peso(totalInSystem),
      userBalances: peso(n.user_balances),
      feesCollected: peso(n.fees_collected),
    };

    if (asJson) {
      console.log(JSON.stringify({ ok, breakdown, checks, mismatchedAccounts: mismatched.rows }, null, 2));
    } else {
      console.log(`PayPulse system ledger check on ${DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}\n`);
      console.log('Money in the system, from the ledger history:');
      console.log(`  top-ups paid in          ${breakdown.topUpsPaidIn}`);
      console.log(`  - paid out to banks      ${breakdown.paidOutToBanks}`);
      console.log(`  + QA adjustments (net)   ${breakdown.qaAdjustmentsNet}`);
      console.log(`  = total money in system  ${breakdown.totalMoneyInSystem}`);
      console.log(`Held by: users ${breakdown.userBalances} + fees ${breakdown.feesCollected}\n`);
      for (const c of checks) {
        console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}`);
        if (!c.pass) console.log(`      expected ${c.expected}, actual ${c.actual}${c.difference ? ` (difference ${c.difference})` : ''}`);
      }
      for (const m of mismatched.rows.slice(0, 10)) {
        console.log(`      ${m.account_number}: cached ${peso(Number(m.cached))}, ledger ${peso(Number(m.ledger))}`);
      }
      console.log(`\n${ok ? 'SYSTEM LEDGER IS CONSISTENT.' : 'SYSTEM LEDGER IS NOT CONSISTENT.'}`);
    }
    return ok;
  } finally {
    await client.end();
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('assert-system-ledger failed to run:', err.message);
    process.exit(2);
  });
