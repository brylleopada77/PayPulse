#!/usr/bin/env node
/**
 * Daily savings interest job (PayPulse Save).
 *
 * Accrues interest on every savings vault for one business date (Asia/Manila) and posts the whole
 * centavos to the ledger (DEBIT interest expense GL 5010, CREDIT the vault GL 2030). Safe to run
 * more than once for the same date: each vault is accrued at most once per day.
 *
 * Usage:  node jobs/daily-interest.js                    accrue yesterday (run just after midnight)
 *         node jobs/daily-interest.js --date 2026-10-14  accrue a specific day (e.g. a catch-up)
 *         node jobs/daily-interest.js --date 2026-10-14 --account SV5000000001
 *                                                        re-run one vault only (ops / tests)
 *
 * Schedule it with cron, e.g.   5 0 * * *   cd /app && node jobs/daily-interest.js
 * (the API server also runs it automatically each night unless INTEREST_JOB=false).
 */
require('dotenv').config({ quiet: true });
const { pool } = require('../src/db/pool');
const interestService = require('../src/services/interestService');

const args = process.argv.slice(2);
const date = args.includes('--date')
  ? args[args.indexOf('--date') + 1]
  : interestService.previousDate(interestService.manilaDate());
const accountNumber = args.includes('--account') ? args[args.indexOf('--account') + 1] : null;

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  let summary;
  if (accountNumber) {
    // One vault only: not recorded as the day's job run.
    const { rows } = await pool.query('SELECT id FROM accounts WHERE account_number = $1 AND savings_owner_id IS NOT NULL', [
      accountNumber,
    ]);
    if (!rows[0]) throw new Error(`No savings vault ${accountNumber}`);
    summary = await interestService.accrueForDate(date, { accountIds: [rows[0].id] });
  } else {
    summary = await interestService.runDailyJob(date);
  }
  console.log(
    `[daily-interest] ${summary.businessDate}: ${summary.vaultsAccrued} of ${summary.vaultsChecked} vault(s) accrued, ` +
      `PHP ${(summary.postedCents / 100).toFixed(2)} posted`,
  );
}

main()
  .catch((err) => {
    console.error('[daily-interest] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
