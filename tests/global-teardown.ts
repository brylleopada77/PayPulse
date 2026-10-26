/**
 * Runs once after every Playwright run: the system ledger invariant check (scripts/assert-ledger.js).
 * Debits must equal credits and total system cash must equal user balances + fees + reserves, or
 * the run fails, so no E2E flow can leave the database in an unbalanced state unnoticed.
 * Skipped when the tests target a remote BASE_URL whose database we can't reach (SKIP_LEDGER_ASSERT=true).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default function globalTeardown() {
  if (process.env.SKIP_LEDGER_ASSERT === 'true') return;
  const script = path.join(__dirname, '..', 'scripts', 'assert-ledger.js');
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Ledger invariant check failed (scripts/assert-ledger.js exited ${result.status})`);
  }
}
