/**
 * Command-line ledger check. Exits with code 1 if the money doesn't add up.
 * Usage: npm run db:check
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { checkLedgerIntegrity, DATABASE_URL } from './db';

const cents = (value: number) => (value / 100).toFixed(2);

async function main() {
  console.log(`Checking ledger integrity on ${DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}\n`);
  const report = await checkLedgerIntegrity();

  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/db-integrity.json', JSON.stringify(report, null, 2));

  const line = (pass: boolean, text: string) => console.log(`${pass ? 'PASS' : 'FAIL'}  ${text}`);

  line(report.totalBalanceCents === 0, `Sum of all balances is 0 (actual: ${cents(report.totalBalanceCents)})`);
  const expectedUsers = report.totalDepositsCents - report.bankOutflowCents + report.qaAdjustmentCents;
  line(
    report.userBalanceCents === expectedUsers,
    `User wallets (${cents(report.userBalanceCents)}) equal top-ups - bank transfers and fees + QA adjustments ` +
      `(${cents(report.totalDepositsCents)} - ${cents(report.bankOutflowCents)} + ${cents(report.qaAdjustmentCents)} = ${cents(expectedUsers)})`,
  );
  line(report.unbalancedTransactions.length === 0, `Unbalanced transactions: ${report.unbalancedTransactions.length}`);
  line(
    report.negativeAccounts.length === 0,
    `Overdrawn customer wallets (balance < 0): ${report.negativeAccounts.length}`,
  );
  if (report.negativeAccounts.length > 0) {
    console.log(`      e.g. ${report.negativeAccounts.slice(0, 5).join(', ')}`);
  }

  console.log(`\n${report.ok ? 'Ledger is consistent.' : 'LEDGER CHECK FAILED.'} Full report: reports/db-integrity.json`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('db-check failed:', err.message);
  process.exit(2);
});
