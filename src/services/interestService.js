// Daily savings interest (PayPulse Save, 6.00% p.a. by default, compounded daily).
//
// For every savings vault and business date D (Asia/Manila):
//   closing balance  = ledger balance at the end of D
//   interest_exact   = closing balance x rate / 365          (kept to 6 decimals of a centavo)
//   posted           = floor(all interest_exact so far) - all posted so far
// so fractions of a centavo carry over instead of being lost. Whole centavos are posted as an
// INTEREST journal: DEBIT SYS-INTEREST-EXPENSE (GL 5010), CREDIT the vault (GL 2030).
// Each (vault, date) is accrued at most once (unique key), so re-running a day is harmless.
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction } = require('./ledgerService');

const TIME_ZONE = 'Asia/Manila';
const EXPENSE_ACCOUNT = 'SYS-INTEREST-EXPENSE';

const manilaDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);

/** "2026-10-15" -> "2026-10-14" */
function previousDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Accrue (and post) one vault's interest for one business date. Returns the accrual or null. */
async function accrueAccount(accountId, businessDate) {
  return withTransaction(async (client) => {
    // Lock the vault so a concurrent run for the same vault waits, then check it isn't done yet.
    const vault = await client.query(
      'SELECT id, interest_rate_bps FROM accounts WHERE id = $1 AND savings_owner_id IS NOT NULL FOR UPDATE',
      [accountId],
    );
    if (!vault.rows[0]) return null;
    const done = await client.query(
      'SELECT 1 FROM savings_interest_accruals WHERE account_id = $1 AND accrual_date = $2',
      [accountId, businessDate],
    );
    if (done.rowCount) return null;

    const { rows } = await client.query(
      `WITH closing AS (
         SELECT COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END), 0) AS cents
         FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
         WHERE le.account_id = $1 AND t.created_at < (($2::date + 1)::timestamp AT TIME ZONE $4)
       ), so_far AS (
         SELECT COALESCE(SUM(interest_exact), 0) AS exact, COALESCE(SUM(posted_cents), 0) AS posted
         FROM savings_interest_accruals WHERE account_id = $1
       )
       SELECT closing.cents AS closing_cents,
              ROUND(closing.cents::numeric * $3 / 10000 / 365, 6) AS interest_exact,
              FLOOR(so_far.exact + ROUND(closing.cents::numeric * $3 / 10000 / 365, 6)) - so_far.posted AS to_post
       FROM closing, so_far`,
      [accountId, businessDate, vault.rows[0].interest_rate_bps, TIME_ZONE],
    );
    const closingCents = Number(rows[0].closing_cents);
    if (closingCents <= 0) return null;
    const toPost = Math.max(0, Number(rows[0].to_post));

    let transactionId = null;
    if (toPost > 0) {
      const expense = await client.query('SELECT id FROM accounts WHERE account_number = $1', [EXPENSE_ACCOUNT]);
      transactionId = await recordTransaction(client, {
        type: 'INTEREST',
        description: `Savings interest for ${businessDate}`,
        entries: [
          { accountId: expense.rows[0].id, direction: 'DEBIT', amountCents: toPost },
          { accountId, direction: 'CREDIT', amountCents: toPost },
        ],
      });
    }
    await client.query(
      `INSERT INTO savings_interest_accruals
         (account_id, accrual_date, closing_balance_cents, rate_bps, interest_exact, posted_cents, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, businessDate, closingCents, vault.rows[0].interest_rate_bps, rows[0].interest_exact, toPost, transactionId],
    );
    return { accountId, businessDate, closingCents, interestExact: rows[0].interest_exact, postedCents: toPost, transactionId };
  });
}

/** Accrue interest for every vault (or only `accountIds`) for one business date. */
async function accrueForDate(businessDate, { accountIds = null } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM accounts WHERE savings_owner_id IS NOT NULL AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY id`,
    [accountIds],
  );
  const results = [];
  for (const { id } of rows) {
    const accrual = await accrueAccount(id, businessDate);
    if (accrual) results.push(accrual);
  }
  return {
    businessDate,
    vaultsChecked: rows.length,
    vaultsAccrued: results.length,
    postedCents: results.reduce((sum, r) => sum + r.postedCents, 0),
    accruals: results,
  };
}

/** The scheduled job: accrue a business date for all vaults and record the run in job_runs. */
async function runDailyJob(businessDate = previousDate(manilaDate())) {
  await pool.query(
    `INSERT INTO job_runs (job, business_date) VALUES ('daily-interest', $1)
     ON CONFLICT (job, business_date) DO UPDATE SET started_at = now(), finished_at = NULL`,
    [businessDate],
  );
  const summary = await accrueForDate(businessDate);
  const { accruals, ...totals } = summary;
  await pool.query(
    `UPDATE job_runs SET finished_at = now(), summary = $2 WHERE job = 'daily-interest' AND business_date = $1`,
    [businessDate, totals],
  );
  return summary;
}

/** Has the daily job finished for this business date? (used by the in-process scheduler) */
async function hasRun(businessDate) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM job_runs WHERE job = 'daily-interest' AND business_date = $1 AND finished_at IS NOT NULL`,
    [businessDate],
  );
  return rowCount > 0;
}

/**
 * QA sandbox: simulate `days` days of interest on the user's own vault, starting the day after its
 * last accrual (or today). Future dates use the current balance as their closing balance.
 */
async function simulateDays(vaultId, days) {
  const last = await pool.query(
    'SELECT MAX(accrual_date)::text AS d FROM savings_interest_accruals WHERE account_id = $1',
    [vaultId],
  );
  const today = manilaDate();
  let date = last.rows[0].d && last.rows[0].d >= today ? nextDate(last.rows[0].d) : today;
  const accruals = [];
  for (let i = 0; i < days; i++) {
    const accrual = await accrueAccount(vaultId, date);
    if (accrual) accruals.push(accrual);
    date = nextDate(date);
  }
  return { days, postedCents: accruals.reduce((s, a) => s + a.postedCents, 0), accruals };
}

module.exports = { accrueForDate, runDailyJob, hasRun, simulateDays, manilaDate, previousDate };
