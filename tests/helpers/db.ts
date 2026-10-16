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
  /** Sum of every account balance (customers + system accounts). Always 0 in double entry. */
  totalBalanceCents: number;
  /** Money held by customers (wallets GL 2010 + savings GL 2030). = top-ups - bank transfers + QA + interest. */
  userBalanceCents: number;
  /** Total of all successful top-ups that ever entered the system. */
  totalDepositsCents: number;
  /** Money that left customer wallets through bank transfers: amounts sent out plus fees. */
  bankOutflowCents: number;
  /** Net money QA sandbox resets added to (or removed from) customer wallets. */
  qaAdjustmentCents: number;
  /** Savings interest PayPulse paid into PayPulse Save vaults. */
  interestCents: number;
  /** Instant Loan money paid into wallets minus repayments taken out of them. */
  loanNetCents: number;
  /** Cashback paid into wallets minus bill payments taken out of them. */
  billsNetCents: number;
  /** Transactions whose debits do not equal their credits. */
  unbalancedTransactions: number[];
  /**
   * Kept for compatibility with older tests. Balances are now COMPUTED from the ledger (view
   * account_balances), so an account can no longer disagree with its own history: always [].
   */
  mismatchedAccounts: AccountMismatch[];
  /** Customer wallets below zero (an overdraft: the race-condition bug shows up here). */
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
      FROM account_balances`);

    const flows = await client.query(`
      SELECT
        COALESCE(SUM(le.amount_cents) FILTER (WHERE t.type = 'DEPOSIT' AND le.direction = 'CREDIT' AND NOT a.is_system), 0)
          AS deposits,
        COALESCE(SUM(le.amount_cents) FILTER (WHERE t.type = 'BANK_TRANSFER' AND le.direction = 'DEBIT' AND NOT a.is_system), 0)
          AS bank_outflow,
        COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END)
                 FILTER (WHERE t.type = 'QA_ADJUSTMENT' AND NOT a.is_system), 0)
          AS qa_adjustments,
        COALESCE(SUM(le.amount_cents) FILTER (WHERE t.type = 'INTEREST' AND le.direction = 'CREDIT' AND NOT a.is_system), 0)
          AS interest,
        COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END)
                 FILTER (WHERE t.type IN ('LOAN_DISBURSEMENT', 'LOAN_REPAYMENT') AND NOT a.is_system), 0)
          AS loans,
        COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END)
                 FILTER (WHERE t.type IN ('BILL_PAYMENT', 'CASHBACK') AND NOT a.is_system), 0)
          AS bills
      FROM ledger_entries le
      JOIN transactions t ON t.id = le.transaction_id
      JOIN accounts a ON a.id = le.account_id`);

    const unbalanced = await client.query(`
      SELECT transaction_id
      FROM ledger_entries
      GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END)
          <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END)
      ORDER BY transaction_id`);

    const filter = accountNumbers?.length ? 'AND account_number = ANY($1)' : '';
    const params = accountNumbers?.length ? [accountNumbers] : [];
    const negative = await client.query(
      `SELECT account_number FROM account_balances WHERE NOT is_system AND balance_cents < 0 ${filter}`,
      params,
    );

    const report: IntegrityReport = {
      ok: false,
      // SUM() returns NUMERIC, which pg gives back as a string: convert explicitly.
      totalBalanceCents: Number(totals.rows[0].total),
      userBalanceCents: Number(totals.rows[0].users),
      totalDepositsCents: Number(flows.rows[0].deposits),
      bankOutflowCents: Number(flows.rows[0].bank_outflow),
      qaAdjustmentCents: Number(flows.rows[0].qa_adjustments),
      interestCents: Number(flows.rows[0].interest),
      loanNetCents: Number(flows.rows[0].loans),
      billsNetCents: Number(flows.rows[0].bills),
      unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
      mismatchedAccounts: [],
      negativeAccounts: negative.rows.map((r) => r.account_number),
    };

    // The global totals only make sense when checking the whole database.
    const totalsOk = accountNumbers?.length
      ? true
      : report.totalBalanceCents === 0 &&
        report.userBalanceCents ===
          report.totalDepositsCents - report.bankOutflowCents + report.qaAdjustmentCents + report.interestCents +
            report.loanNetCents + report.billsNetCents;

    report.ok = totalsOk && report.unbalancedTransactions.length === 0 && report.negativeAccounts.length === 0;
    return report;
  });
}

/**
 * Test hook: move an account's outgoing transactions back in time (instead of waiting),
 * e.g. 11 seconds to get past the anti-spam window, or 1 day to make them "yesterday".
 * Transactions are immutable; the schema allows only this created_at change, and only in a
 * session that sets paypulse.allow_time_travel (tests only, never the app).
 */
export async function ageOutgoingTransactions(accountNumber: string, interval: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("SELECT set_config('paypulse.allow_time_travel', 'on', false)");
    await client.query(
      `UPDATE transactions SET created_at = created_at - $2::interval
       WHERE id IN (SELECT le.transaction_id FROM ledger_entries le
                    JOIN accounts a ON a.id = le.account_id
                    WHERE a.account_number = $1 AND le.direction = 'DEBIT')`,
      [accountNumber, interval],
    );
  });
}

/** Balance of an account straight from the ledger view (no stored balances exist). */
export async function ledgerBalanceCents(accountNumber: string): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query('SELECT balance_cents FROM account_balances WHERE account_number = $1', [
      accountNumber,
    ]);
    return Number(rows[0].balance_cents);
  });
}

/** Run a statement and return the database error message, or null if it was allowed. */
export async function tryStatement(sql: string, params: unknown[] = []): Promise<string | null> {
  return withClient(async (client) => {
    try {
      await client.query(sql, params);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
}

/** The GL account an account is mapped to. */
export async function glCodeOf(accountNumber: string): Promise<string> {
  return withClient(async (client) => {
    const { rows } = await client.query('SELECT gl_code FROM accounts WHERE account_number = $1', [accountNumber]);
    return rows[0].gl_code;
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

/** Test hook: give an account the ADMIN role (Add money, QA sandbox and chaos tools are admin-only). */
export async function makeAdmin(email: string): Promise<void> {
  await withClient((client) => client.query("UPDATE users SET role = 'ADMIN' WHERE email = $1", [email]));
}
