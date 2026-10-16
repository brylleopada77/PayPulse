#!/usr/bin/env node
/**
 * Standalone system-ledger assertion for PayPulse (plain Node.js, no test runner needed).
 *
 * Main rule:
 *   total money in the system  ==  sum(user balances) + sum(collected fees) + PESONet pending
 *
 * "Total money in the system" is worked out from the ledger *flows*:
 *   top-ups paid in  -  amounts paid out to banks (settled)  +  net QA sandbox adjustments
 *   +  savings interest paid by PayPulse.
 * (User balances include PayPulse Save vaults.)
 * The other side comes from the balances, which are themselves computed from the ledger
 * (view account_balances; nothing is stored). Bank fees stay inside PayPulse, and PESONet
 * transfers waiting for their batch cut-off are still inside PayPulse too.
 *
 * Extra checks: every transaction balances (debits = credits), all balances sum to 0, the
 * trial balance debits equal its credits, and no customer wallet is overdrawn (< 0).
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
      WITH balances AS (SELECT * FROM account_balances),
           flows AS (
             SELECT le.amount_cents, le.direction, t.type, a.account_number, a.is_system
             FROM ledger_entries le
             JOIN transactions t ON t.id = le.transaction_id
             JOIN accounts a ON a.id = le.account_id
           )
      SELECT
        (SELECT COALESCE(SUM(balance_cents), 0) FROM balances WHERE NOT is_system)                          AS user_balances,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM balances WHERE account_number = 'SYS-FEE-INCOME')       AS fees,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM balances WHERE account_number = 'SYS-PESONET-CLEARING') AS pesonet_pending,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM balances)                                               AS all_balances,
        (SELECT COUNT(*) FROM balances WHERE NOT is_system AND balance_cents < 0)                            AS overdrawn,
        (SELECT COALESCE(SUM(total_debits_cents), 0) FROM gl_trial_balance)                                  AS tb_debits,
        (SELECT COALESCE(SUM(total_credits_cents), 0) FROM gl_trial_balance)                                 AS tb_credits,
        COALESCE(SUM(amount_cents) FILTER (WHERE type = 'DEPOSIT' AND direction = 'CREDIT' AND NOT is_system), 0)
                                                                                                               AS deposits_in,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                 FILTER (WHERE account_number = 'SYS-BANK-SETTLEMENT'), 0)                                    AS bank_payouts,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                 FILTER (WHERE type = 'QA_ADJUSTMENT' AND NOT is_system), 0)                                   AS qa_net,
        COALESCE(SUM(amount_cents) FILTER (WHERE type = 'INTEREST' AND direction = 'CREDIT' AND NOT is_system), 0)
                                                                                                               AS interest_paid,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                 FILTER (WHERE type IN ('LOAN_DISBURSEMENT', 'LOAN_REPAYMENT') AND NOT is_system), 0)        AS loans_net,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                 FILTER (WHERE type IN ('BILL_PAYMENT', 'CASHBACK') AND NOT is_system), 0)                    AS bills_net
      FROM flows`);
    const n = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));

    const unbalanced = await client.query(`
      SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END)
          <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END)`);
    const overdrawn = await client.query(`
      SELECT account_number, balance_cents FROM account_balances
      WHERE NOT is_system AND balance_cents < 0 ORDER BY balance_cents LIMIT 10`);

    const totalInSystem = n.deposits_in - n.bank_payouts + n.qa_net + n.interest_paid + n.loans_net + n.bills_net;
    const heldInside = n.user_balances + n.fees + n.pesonet_pending;

    const checks = [
      {
        check: 'Total money in system = user balances + collected fees + PESONet pending',
        expected: peso(totalInSystem),
        actual: peso(heldInside),
        difference: peso(heldInside - totalInSystem),
        pass: heldInside === totalInSystem,
      },
      {
        check: 'All account balances (users + system) sum to 0',
        expected: peso(0),
        actual: peso(n.all_balances),
        difference: peso(n.all_balances),
        pass: n.all_balances === 0,
      },
      {
        check: 'Trial balance: total debits = total credits',
        expected: peso(n.tb_debits),
        actual: peso(n.tb_credits),
        difference: peso(n.tb_credits - n.tb_debits),
        pass: n.tb_debits === n.tb_credits,
      },
      {
        check: 'Every transaction balances (debits = credits)',
        expected: '0 unbalanced',
        actual: `${unbalanced.rowCount} unbalanced`,
        difference: '',
        pass: unbalanced.rowCount === 0,
      },
      {
        check: 'No customer wallet is overdrawn (balance < 0)',
        expected: '0 overdrawn',
        actual: `${n.overdrawn} overdrawn`,
        difference: '',
        pass: n.overdrawn === 0,
      },
    ];
    const ok = checks.every((c) => c.pass);

    const breakdown = {
      topUpsPaidIn: peso(n.deposits_in),
      paidOutToBanks: peso(n.bank_payouts),
      qaAdjustmentsNet: peso(n.qa_net),
      savingsInterestPaid: peso(n.interest_paid),
      totalMoneyInSystem: peso(totalInSystem),
      userBalances: peso(n.user_balances),
      feesCollected: peso(n.fees),
      pesonetPending: peso(n.pesonet_pending),
    };

    if (asJson) {
      console.log(JSON.stringify({ ok, breakdown, checks, overdrawnAccounts: overdrawn.rows }, null, 2));
    } else {
      console.log(`PayPulse system ledger check on ${DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}\n`);
      console.log('Money in the system, from the ledger flows:');
      console.log(`  top-ups paid in          ${breakdown.topUpsPaidIn}`);
      console.log(`  - paid out to banks      ${breakdown.paidOutToBanks}`);
      console.log(`  + QA adjustments (net)   ${breakdown.qaAdjustmentsNet}`);
      console.log(`  + savings interest paid  ${breakdown.savingsInterestPaid}`);
      console.log(`  = total money in system  ${breakdown.totalMoneyInSystem}`);
      console.log(
        `Held by: users ${breakdown.userBalances} + fees ${breakdown.feesCollected} + PESONet pending ${breakdown.pesonetPending}\n`,
      );
      for (const c of checks) {
        console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}`);
        if (!c.pass) console.log(`      expected ${c.expected}, actual ${c.actual}${c.difference ? ` (difference ${c.difference})` : ''}`);
      }
      for (const o of overdrawn.rows) console.log(`      ${o.account_number}: ${peso(Number(o.balance_cents))}`);
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
