import pg from 'pg';

// BIGINT -> number (amounts are cents, well within safe integer range)
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://paypulse:paypulse@localhost:5432/paypulse';

export interface AccountMismatch {
  accountNumber: string;
  cachedBalanceCents: number;
  ledgerBalanceCents: number;
}

export interface IntegrityReport {
  ok: boolean;
  /** Sum of every account balance, including the system funding account. Must be 0. */
  totalBalanceCents: number;
  /** Money held in user wallets. Must equal total successful top-ups. */
  userBalanceCents: number;
  /** Total of all successful top-ups that ever entered the system. */
  totalDepositsCents: number;
  /** Transactions whose debits do not equal their credits. */
  unbalancedTransactions: number[];
  /** Accounts whose cached balance disagrees with their ledger history. */
  mismatchedAccounts: AccountMismatch[];
  /** User wallets below zero. */
  negativeAccounts: string[];
}

async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Verify the double-entry ledger rules across the whole database.
 * Pass accountNumbers to limit the per-account checks to specific wallets
 * (useful when other tests are running against the same database).
 */
export async function checkLedgerIntegrity(accountNumbers?: string[]): Promise<IntegrityReport> {
  return withClient(async (client) => {
    const totals = await client.query(`
      SELECT
        COALESCE(SUM(balance_cents), 0)                                  AS total,
        COALESCE(SUM(balance_cents) FILTER (WHERE NOT is_system), 0)     AS users
      FROM accounts`);

    const deposits = await client.query(`
      SELECT COALESCE(SUM(le.amount_cents), 0) AS total
      FROM ledger_entries le
      JOIN transactions t ON t.id = le.transaction_id
      WHERE t.type = 'DEPOSIT' AND le.direction = 'CREDIT'`);

    const unbalanced = await client.query(`
      SELECT transaction_id
      FROM ledger_entries
      GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END)
          <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END)
      ORDER BY transaction_id`);

    const filter = accountNumbers?.length ? 'AND a.account_number = ANY($1)' : '';
    const params = accountNumbers?.length ? [accountNumbers] : [];

    const mismatched = await client.query(
      `SELECT a.account_number,
              a.balance_cents AS cached,
              COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents
                                ELSE -le.amount_cents END), 0) AS ledger
       FROM accounts a
       LEFT JOIN ledger_entries le ON le.account_id = a.id
       WHERE true ${filter}
       GROUP BY a.id
       HAVING a.balance_cents <> COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents
                                                   ELSE -le.amount_cents END), 0)
       ORDER BY a.account_number`,
      params,
    );

    const negative = await client.query(
      `SELECT a.account_number FROM accounts a
       WHERE NOT a.is_system AND a.balance_cents < 0 ${filter}`,
      params,
    );

    const report: IntegrityReport = {
      ok: false,
      totalBalanceCents: totals.rows[0].total,
      userBalanceCents: totals.rows[0].users,
      totalDepositsCents: deposits.rows[0].total,
      unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
      mismatchedAccounts: mismatched.rows.map((r) => ({
        accountNumber: r.account_number,
        cachedBalanceCents: r.cached,
        ledgerBalanceCents: r.ledger,
      })),
      negativeAccounts: negative.rows.map((r) => r.account_number),
    };

    // The global totals only make sense when checking the whole database.
    const totalsOk = accountNumbers?.length
      ? true
      : report.totalBalanceCents === 0 && report.userBalanceCents === report.totalDepositsCents;

    report.ok =
      totalsOk &&
      report.unbalancedTransactions.length === 0 &&
      report.mismatchedAccounts.length === 0 &&
      report.negativeAccounts.length === 0;

    return report;
  });
}

/** Test hook: make an OTP challenge expire now instead of waiting 30 seconds. */
export async function expireOtpChallenge(challengeId: string): Promise<void> {
  await withClient((client) =>
    client.query("UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [challengeId]),
  );
}

/** Test hook: simulate an account created before MPINs existed (no MPIN set). */
export async function clearMpin(email: string): Promise<void> {
  await withClient((client) => client.query('UPDATE users SET mpin_hash = NULL WHERE email = $1', [email]));
}

/** Test hook: make a user's MPIN expire now instead of waiting 5 minutes. */
export async function expireMpin(email: string): Promise<void> {
  await withClient((client) =>
    client.query("UPDATE users SET mpin_expires_at = now() - interval '1 second' WHERE email = $1", [email]),
  );
}

/** Test hook: make a password-reset code expire now instead of waiting 10 minutes. */
export async function expirePasswordReset(resetId: string): Promise<void> {
  await withClient((client) =>
    client.query("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE id = $1", [resetId]),
  );
}
