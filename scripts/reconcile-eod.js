#!/usr/bin/env node
/**
 * PayPulse End-of-Day (EOD) reconciliation.
 *
 * Builds the trial balance as of the end of a business day (Asia/Manila) and reconciles every
 * General Ledger control account against the records it should agree with:
 *
 *   1. Trial balance             total debits = total credits; every journal balances
 *   2. Customer liability        GL 2010 = sum of every customer wallet (sub-ledger)
 *   3. Wallet mapping            every customer wallet is mapped to GL 2010
 *   4. Accounting equation       Assets = Liabilities + Equity + Revenue
 *   5. Cash received             GL 1010 debits = successful top-up payments
 *   6. Outbound settlements      GL 1020 = settled bank transfers (InstaPay + PESONet batches)
 *   7. PESONet clearing          GL 2020 = PESONet transfers still queued at the cut-off
 *   8. Fee revenue               GL 4010 = fees on bank transfers
 *   9. Payment messages          every bank transfer has an ISO 20022 pacs.008 with the same status
 *  10. Overdrafts                no customer wallet below zero
 *
 * It writes an audit log (human-readable .log + machine-readable .json) to reports/eod/, records the
 * run in the eod_reconciliations table, and exits 0 when balanced, 1 with exceptions, 2 on error.
 * Meant to run unattended (cron / Task Scheduler / CI) after the business day closes.
 *
 * Usage:  node scripts/reconcile-eod.js                     today so far (Manila)
 *         node scripts/reconcile-eod.js --date 2026-10-14   as of the end of that day
 *         node scripts/reconcile-eod.js --json              print the JSON report to stdout
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://paypulse:paypulse@localhost:5432/paypulse';
const TIME_ZONE = 'Asia/Manila';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;

const peso = (cents) =>
  `${cents < 0 ? '-' : ''}PHP ${(Math.abs(cents) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayInManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

async function reconcile(client, businessDate) {
  // Everything up to the end of the business day in Manila (or up to now for today).
  const { rows: [{ cutoff }] } = await client.query(
    `SELECT LEAST(now(), (($1::date + 1)::timestamp AT TIME ZONE $2)) AS cutoff`,
    [businessDate, TIME_ZONE],
  );
  const asOf = [cutoff];

  const trial = (
    await client.query(
      `SELECT g.code, g.name, g.category, g.normal_balance,
              COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'DEBIT'), 0)::bigint  AS debits,
              COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'CREDIT'), 0)::bigint AS credits
       FROM gl_accounts g
       LEFT JOIN accounts a ON a.gl_code = g.code
       LEFT JOIN (ledger_entries le JOIN transactions t ON t.id = le.transaction_id AND t.created_at <= $1)
              ON le.account_id = a.id
       GROUP BY g.code ORDER BY g.code`,
      asOf,
    )
  ).rows.map((r) => {
    const debits = Number(r.debits);
    const credits = Number(r.credits);
    return { ...r, debits, credits, balance: r.normal_balance === 'DEBIT' ? debits - credits : credits - debits };
  });
  const gl = Object.fromEntries(trial.map((r) => [r.code, r]));

  const one = async (sql) => Number((await client.query(sql, asOf)).rows[0].v);

  const walletSubledger = await one(`
    SELECT COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END), 0) AS v
    FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
    JOIN accounts a ON a.id = le.account_id
    WHERE a.user_id IS NOT NULL AND t.created_at <= $1`);
  const unmappedWallets = await one(`
    SELECT COUNT(*) AS v FROM accounts WHERE user_id IS NOT NULL AND gl_code <> '2010' AND created_at <= $1`);
  const unbalancedJournals = await one(`
    SELECT COUNT(*) AS v FROM (
      SELECT le.transaction_id FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
      WHERE t.created_at <= $1 GROUP BY le.transaction_id
      HAVING SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount_cents ELSE -le.amount_cents END) <> 0) x`);
  const topUps = await one(`
    SELECT COALESCE(SUM(p.amount_cents), 0) AS v FROM payments p JOIN transactions t ON t.id = p.transaction_id
    WHERE p.status = 'SUCCESS' AND t.created_at <= $1`);
  const settledOutbound = await one(`
    SELECT COALESCE(SUM(amount_cents), 0) AS v FROM bank_transfers
    WHERE status = 'SETTLED' AND COALESCE(settled_at, created_at) <= $1`);
  const queuedPesonet = await one(`
    SELECT COALESCE(SUM(amount_cents), 0) AS v FROM bank_transfers
    WHERE rail = 'PESONET' AND created_at <= $1 AND (status = 'QUEUED' OR settled_at > $1)`);
  const bankFees = await one(`
    SELECT COALESCE(SUM(fee_cents), 0) AS v FROM bank_transfers WHERE created_at <= $1`);
  const missingMessages = await one(`
    SELECT COUNT(*) AS v FROM bank_transfers bt LEFT JOIN payment_messages pm ON pm.bank_transfer_id = bt.id
    WHERE bt.created_at <= $1 AND pm.id IS NULL
      -- transfers made before the payment switch went live (first message ever) have none
      AND bt.created_at >= (SELECT COALESCE(MIN(created_at), 'infinity') FROM payment_messages)`);
  const statusMismatches = await one(`
    SELECT COUNT(*) AS v FROM bank_transfers bt JOIN payment_messages pm ON pm.bank_transfer_id = bt.id
    WHERE bt.created_at <= $1 AND bt.status <> pm.status`);
  const overdrawn = (
    await client.query(
      `SELECT a.account_number,
              SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END) AS balance
       FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id IS NOT NULL AND t.created_at <= $1
       GROUP BY a.account_number
       HAVING SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END) < 0
       ORDER BY balance`,
      asOf,
    )
  ).rows.map((r) => ({ accountNumber: r.account_number, balance: Number(r.balance) }));

  const sum = (category) => trial.filter((r) => r.category === category).reduce((s, r) => s + r.balance, 0);
  const totalDebits = trial.reduce((s, r) => s + r.debits, 0);
  const totalCredits = trial.reduce((s, r) => s + r.credits, 0);
  const assets = sum('ASSET');
  const liabilitiesEquityRevenue = sum('LIABILITY') + sum('EQUITY') + sum('REVENUE') - sum('EXPENSE');

  const check = (id, name, expected, actual, { money = true, note } = {}) => ({
    id,
    name,
    expected: money ? peso(expected) : String(expected),
    actual: money ? peso(actual) : String(actual),
    difference: money ? peso(actual - expected) : String(actual - expected),
    status: expected === actual ? 'MATCHED' : 'EXCEPTION',
    ...(note && { note }),
  });

  const checks = [
    check('TB-1', 'Trial balance: total debits = total credits', totalDebits, totalCredits),
    check('TB-2', 'Every journal balances (unbalanced journals)', 0, unbalancedJournals, { money: false }),
    check('LIAB-1', 'Customer liability: GL 2010 = sum of customer wallets', walletSubledger, gl['2010'].balance),
    check('LIAB-2', 'Customer wallets not mapped to GL 2010', 0, unmappedWallets, { money: false }),
    check('EQ-1', 'Accounting equation: Assets = Liabilities + Equity + Revenue', liabilitiesEquityRevenue, assets),
    check('CASH-1', 'Cash received: GL 1010 debits = successful top-ups', topUps, gl['1010'].debits),
    check('OUT-1', 'Outbound settled: GL 1020 = settled bank transfers', settledOutbound, -gl['1020'].balance),
    check('PSN-1', 'PESONet clearing: GL 2020 = transfers queued at cut-off', queuedPesonet, gl['2020'].balance),
    check('FEE-1', 'Fee revenue: GL 4010 = bank transfer fees', bankFees, gl['4010'].balance),
    check('MSG-1', 'Bank transfers without an ISO 20022 message (since the switch went live)', 0, missingMessages, { money: false }),
    check('MSG-2', 'Bank transfer vs pacs.008 status mismatches', 0, statusMismatches, { money: false }),
    check('OD-1', 'Overdrawn customer wallets (balance < 0)', 0, overdrawn.length, {
      money: false,
      note: overdrawn.length ? 'Typical cause: concurrent transfers (see QA_NOTES.md)' : undefined,
    }),
  ];
  const exceptions = checks.filter((c) => c.status === 'EXCEPTION').length;

  return {
    businessDate,
    asOf: cutoff,
    status: exceptions === 0 ? 'BALANCED' : 'EXCEPTIONS',
    exceptions,
    totals: {
      totalCustomerLiability: peso(gl['2010'].balance),
      customerWalletsSubledger: peso(walletSubledger),
      pesonetPending: peso(gl['2020'].balance),
      feeRevenue: peso(gl['4010'].balance),
      cashAtBank: peso(gl['1010'].balance),
      settledOutbound: peso(-gl['1020'].balance),
    },
    trialBalance: trial.map((r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      debits: peso(r.debits),
      credits: peso(r.credits),
      // A balance on the "wrong" side is shown on that side (e.g. an asset paid out: Cr).
      balance: `${peso(Math.abs(r.balance))} ${(r.normal_balance === 'DEBIT') === r.balance >= 0 ? 'Dr' : 'Cr'}`,
    })),
    checks,
    overdrawnAccounts: overdrawn.map((o) => ({ accountNumber: o.accountNumber, balance: peso(o.balance) })),
  };
}

function auditLog(report, runAt) {
  const lines = [];
  const pad = (text, width) => String(text).padEnd(width);
  lines.push('PAYPULSE END-OF-DAY RECONCILIATION');
  lines.push(`Business date : ${report.businessDate} (${TIME_ZONE})`);
  lines.push(`Ledger as of  : ${new Date(report.asOf).toISOString()}`);
  lines.push(`Run at        : ${runAt.toISOString()}`);
  lines.push(`Result        : ${report.status} (${report.exceptions} exception${report.exceptions === 1 ? '' : 's'})`);
  lines.push('');
  lines.push('TRIAL BALANCE');
  lines.push(`${pad('GL', 6)}${pad('Account', 44)}${pad('Debits', 20)}${pad('Credits', 20)}Balance`);
  for (const r of report.trialBalance) {
    lines.push(`${pad(r.code, 6)}${pad(r.name, 44)}${pad(r.debits, 20)}${pad(r.credits, 20)}${r.balance}`);
  }
  lines.push('');
  lines.push(`Total customer liability (GL 2010): ${report.totals.totalCustomerLiability}`);
  lines.push(`Customer wallets (sub-ledger)     : ${report.totals.customerWalletsSubledger}`);
  lines.push('');
  lines.push('RECONCILIATION CHECKS');
  for (const c of report.checks) {
    lines.push(`[${c.status === 'MATCHED' ? ' OK ' : 'FAIL'}] ${c.id.padEnd(7)} ${c.name}`);
    if (c.status === 'EXCEPTION') {
      lines.push(`               expected ${c.expected}, actual ${c.actual}, difference ${c.difference}`);
      if (c.note) lines.push(`               note: ${c.note}`);
    }
  }
  if (report.overdrawnAccounts.length) {
    lines.push('');
    lines.push('BALANCE MISMATCHES / EXCEPTIONS: OVERDRAWN WALLETS');
    for (const o of report.overdrawnAccounts) lines.push(`  ${o.accountNumber.padEnd(16)} ${o.balance}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const businessDate = dateArg || todayInManila();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error(`--date must be YYYY-MM-DD, got "${businessDate}"`);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const runAt = new Date();
    // One consistent snapshot for every check: transfers committing while the reconciliation runs
    // can't make one query see them and another not.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let report;
    try {
      report = await reconcile(client, businessDate);
    } finally {
      await client.query('COMMIT');
    }

    const dir = path.join(__dirname, '..', 'reports', 'eod');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = runAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const base = path.join(dir, `eod-${businessDate}-${stamp}`);
    const text = auditLog(report, runAt);
    fs.writeFileSync(`${base}.log`, text);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ runAt, ...report }, null, 2));

    await client.query(
      `INSERT INTO eod_reconciliations (business_date, status, exceptions, summary, audit_log_path)
       VALUES ($1, $2, $3, $4, $5)`,
      [businessDate, report.status, report.exceptions, { totals: report.totals, checks: report.checks }, `${base}.log`],
    );

    if (asJson) console.log(JSON.stringify({ runAt, auditLog: `${base}.log`, ...report }, null, 2));
    else console.log(`${text}\nAudit log: ${base}.log`);
    return report.status === 'BALANCED';
  } finally {
    await client.end();
  }
}

main()
  .then((balanced) => process.exit(balanced ? 0 : 1))
  .catch((err) => {
    console.error('EOD reconciliation failed to run:', err.message);
    process.exit(2);
  });
