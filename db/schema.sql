-- PayPulse database schema
-- Safe to run more than once (all statements are idempotent).
--
-- Money is always stored as BIGINT cents (no floating point).
--
-- Double-entry General Ledger rules (see the "Core banking" section at the end):
--   * Every money movement is a row in `transactions` with `ledger_entries` whose
--     DEBIT total equals its CREDIT total.
--   * Every account is mapped to a General Ledger account (`gl_accounts`): customer wallet
--     liabilities, fee revenue, bank clearing, cash at bank, ...
--   * Balances are NEVER stored: they are computed by SQL aggregation of the ledger
--     (view `account_balances`, credits - debits). There is no balance column to edit.
--   * `ledger_entries` is immutable (UPDATE/DELETE/TRUNCATE are refused by a trigger);
--     a mistake is corrected with a new, reversing transaction.
--   * Money enters through the cash-at-bank account (SYS-EXTERNAL-FUNDING), so the sum of
--     ALL account balances (customers + system) is always exactly 0.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  full_name     TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS account_number_seq START 1000000001;

CREATE TABLE IF NOT EXISTS accounts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER     UNIQUE REFERENCES users (id),
  account_number TEXT        NOT NULL UNIQUE
                 DEFAULT 'PP' || nextval('account_number_seq')::text,
  currency       CHAR(3)     NOT NULL DEFAULT 'PHP',
  is_system      BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No balance column: balances come from the ledger (view account_balances).
);

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  type        TEXT        NOT NULL CHECK (type IN ('TRANSFER', 'DEPOSIT')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             SERIAL PRIMARY KEY,
  transaction_id INTEGER     NOT NULL REFERENCES transactions (id),
  account_id     INTEGER     NOT NULL REFERENCES accounts (id),
  direction      TEXT        NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries (transaction_id);

-- Payment provider callbacks (webhook). payment_id makes callbacks idempotent.
CREATE TABLE IF NOT EXISTS payments (
  id             SERIAL PRIMARY KEY,
  payment_id     TEXT        NOT NULL UNIQUE,
  account_id     INTEGER     NOT NULL REFERENCES accounts (id),
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents > 0),
  status         TEXT        NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  transaction_id INTEGER     REFERENCES transactions (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The system account that money comes from when a wallet is topped up.
INSERT INTO accounts (account_number, is_system)
VALUES ('SYS-EXTERNAL-FUNDING', true)
ON CONFLICT (account_number) DO NOTHING;

-- ---------- Transfer security: MPIN + OTP ----------

-- MPIN: a random 6-digit PIN given at sign-up (bcrypt hash). NULL = never set (older accounts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_locked_until TIMESTAMPTZ;
-- An MPIN is only valid for a few minutes after it is issued; then the user gets a new one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_expires_at TIMESTAMPTZ;

-- One-time codes for large transfers. Each code is bound to one recipient + amount.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id              UUID        PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES users (id),
  code_hash       TEXT        NOT NULL,
  to_account      TEXT        NOT NULL,
  amount_cents    BIGINT      NOT NULL CHECK (amount_cents > 0),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_user ON otp_challenges (user_id);

-- ---------- Forgot password ----------

-- Tokens issued before this moment are rejected, so a password change signs out old sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- One-time codes for resetting a password. user_id is NULL when the email was unknown:
-- the request is still stored so unknown and known emails behave the same (no account probing).
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID        PRIMARY KEY,
  user_id     INTEGER     REFERENCES users (id),
  code_hash   TEXT        NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Express Send by mobile number + Bank transfers ----------

-- Optional mobile number (format 09XXXXXXXXX) so others can send money to it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile_number ON users (mobile_number)
  WHERE mobile_number IS NOT NULL;

-- The allowed transaction types (incl. BANK_TRANSFER) are defined once, further down in the
-- QA sandbox section. Keep a single definition: re-adding an older, narrower list here would
-- fail on re-runs once newer transaction types exist.

-- Money that leaves PayPulse to an outside bank / e-wallet, and the fees PayPulse earns.
-- A bank transfer is: DEBIT user (amount + fee), CREDIT settlement (amount), CREDIT fees (fee).
INSERT INTO accounts (account_number, is_system)
VALUES ('SYS-BANK-SETTLEMENT', true), ('SYS-FEE-INCOME', true)
ON CONFLICT (account_number) DO NOTHING;

-- Details of each outgoing bank transfer (the ledger holds the money; this holds the "where").
CREATE TABLE IF NOT EXISTS bank_transfers (
  id              SERIAL PRIMARY KEY,
  reference       TEXT        NOT NULL UNIQUE,
  transaction_id  INTEGER     NOT NULL UNIQUE REFERENCES transactions (id),
  user_id         INTEGER     NOT NULL REFERENCES users (id),
  bank_code       TEXT        NOT NULL,
  account_number  TEXT        NOT NULL,
  account_name    TEXT        NOT NULL,
  amount_cents    BIGINT      NOT NULL CHECK (amount_cents > 0),
  fee_cents       BIGINT      NOT NULL CHECK (fee_cents >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Account freeze + QA sandbox ----------

-- A frozen account cannot send money (real rule; the QA sandbox can toggle it for testing).
ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT false;
-- QA sandbox switches (only used when the server runs with QA_SANDBOX=true).
ALTER TABLE users ADD COLUMN IF NOT EXISTS qa_latency_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qa_fail_next BOOLEAN NOT NULL DEFAULT false;
-- "Reset" hides history and restarts the transfer limits from this moment (rows are kept).
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_cleared_at TIMESTAMPTZ;

-- All allowed transaction types (the single definition; re-created so this file stays re-runnable).
-- QA_ADJUSTMENT: sandbox resets set a balance through the ledger, so debits still equal credits.
-- PESONET_SETTLEMENT: a PESONet batch leaving the clearing account at a cut-off.
-- SAVINGS_TRANSFER: wallet <-> PayPulse Save vault.  INTEREST: daily savings interest posting.
-- LOAN_DISBURSEMENT / LOAN_REPAYMENT: Instant Loan money out to / back from the wallet.
-- BILL_PAYMENT: Pay Bills (wallet -> biller settlement).  CASHBACK: bills cashback reward.
-- CARD_PAYMENT: an online purchase with the virtual Visa (wallet -> card settlement).
-- LOAD_PURCHASE: Buy Load / mobile prepaid top-up (wallet -> telco settlement).
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('TRANSFER', 'DEPOSIT', 'BANK_TRANSFER', 'QA_ADJUSTMENT', 'PESONET_SETTLEMENT',
                  'SAVINGS_TRANSFER', 'INTEREST', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT',
                  'BILL_PAYMENT', 'CASHBACK', 'CARD_PAYMENT', 'LOAD_PURCHASE'));

INSERT INTO accounts (account_number, is_system)
VALUES ('SYS-QA-ADJUSTMENT', true)
ON CONFLICT (account_number) DO NOTHING;

-- =====================================================================================
-- Core banking: General Ledger, immutable entries, computed balances
-- =====================================================================================

-- Chart of accounts. Sign convention in the views: balance = credits - debits, so accounts with
-- a DEBIT normal balance (assets) show negative numbers; `normal_balance` says how to read them.
CREATE TABLE IF NOT EXISTS gl_accounts (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  description    TEXT NOT NULL
);

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('1010', 'Cash at Bank - Settlement Account', 'ASSET', 'DEBIT',
   'PayPulse''s own bank account: customer top-ups arrive here'),
  ('1020', 'Bank Clearing - Settled Outbound Payments', 'ASSET', 'DEBIT',
   'Money paid out to other banks/e-wallets (InstaPay, settled PESONet batches)'),
  ('2010', 'Customer Wallet Liabilities', 'LIABILITY', 'CREDIT',
   'Money PayPulse owes its customers: the sum of all wallet balances'),
  ('2020', 'PESONet Clearing - Pending Outbound', 'LIABILITY', 'CREDIT',
   'PESONet transfers taken from wallets, waiting for the next batch cut-off'),
  ('3900', 'Sandbox Adjustments (non-production)', 'EQUITY', 'CREDIT',
   'QA sandbox balance resets (never used in production)'),
  ('4010', 'Fee Revenue - Bank Transfers', 'REVENUE', 'CREDIT',
   'Convenience fees charged on bank transfers')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system)
VALUES ('SYS-PESONET-CLEARING', true)
ON CONFLICT (account_number) DO NOTHING;

-- Every account (customer wallet or system account) belongs to one GL account.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS gl_code TEXT REFERENCES gl_accounts (code);
ALTER TABLE accounts ALTER COLUMN gl_code SET DEFAULT '2010';
UPDATE accounts SET gl_code = CASE account_number
    WHEN 'SYS-EXTERNAL-FUNDING' THEN '1010'
    WHEN 'SYS-BANK-SETTLEMENT'  THEN '1020'
    WHEN 'SYS-PESONET-CLEARING' THEN '2020'
    WHEN 'SYS-QA-ADJUSTMENT'    THEN '3900'
    WHEN 'SYS-FEE-INCOME'       THEN '4010'
    WHEN 'SYS-INTEREST-EXPENSE' THEN '5010'
    WHEN 'SYS-LOANS-RECEIVABLE' THEN '1030'
    WHEN 'SYS-LOAN-INTEREST'    THEN '4020'
    WHEN 'SYS-BILLER-SETTLEMENT' THEN '2040'
    WHEN 'SYS-CASHBACK-EXPENSE' THEN '5020'
    WHEN 'SYS-CARD-SETTLEMENT'  THEN '2050'
    WHEN 'SYS-TELCO-SETTLEMENT' THEN '2060'
    ELSE '2010' END
  WHERE gl_code IS NULL OR is_system;
ALTER TABLE accounts ALTER COLUMN gl_code SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_gl_code ON accounts (gl_code);

-- Older databases had a cached balance column; balances are now always computed (below).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS non_negative_user_balance;
ALTER TABLE accounts DROP COLUMN IF EXISTS balance_cents;

-- Balance of every account, computed from the ledger (credits - debits).
CREATE OR REPLACE VIEW account_balances AS
SELECT a.id AS account_id,
       a.account_number,
       a.user_id,
       a.is_system,
       a.gl_code,
       COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE -le.amount_cents END), 0)::bigint
         AS balance_cents
FROM accounts a
LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY a.id;

-- Trial balance per GL account. `balance_normal_cents` is shown on the account's normal side.
CREATE OR REPLACE VIEW gl_trial_balance AS
SELECT g.code,
       g.name,
       g.category,
       g.normal_balance,
       COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'DEBIT'), 0)::bigint  AS total_debits_cents,
       COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'CREDIT'), 0)::bigint AS total_credits_cents,
       (CASE WHEN g.normal_balance = 'CREDIT'
             THEN COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'CREDIT'), 0)
                - COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'DEBIT'), 0)
             ELSE COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'DEBIT'), 0)
                - COALESCE(SUM(le.amount_cents) FILTER (WHERE le.direction = 'CREDIT'), 0)
        END)::bigint AS balance_normal_cents
FROM gl_accounts g
LEFT JOIN accounts a ON a.gl_code = g.code
LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY g.code
ORDER BY g.code;

-- Immutability: ledger entries can only be inserted. Corrections are new, reversing entries.
CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is immutable: % is not allowed (post a reversing entry instead)', TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

DROP TRIGGER IF EXISTS trg_ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();

-- Transactions (the journal headers) can't be deleted or rewritten either. The single exception
-- is for automated tests: with `SET paypulse.allow_time_travel = 'on'` in their own session they
-- may move created_at (e.g. to test "yesterday" or a 10-second window without waiting).
CREATE OR REPLACE FUNCTION transactions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('paypulse.allow_time_travel', true) = 'on'
     AND NEW.id = OLD.id AND NEW.type = OLD.type
     AND NEW.description IS NOT DISTINCT FROM OLD.description THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transactions is immutable: % is not allowed', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transactions_guard ON transactions;
CREATE TRIGGER trg_transactions_guard
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_guard();

-- =====================================================================================
-- Payment switch: InstaPay / PESONet rails and ISO 20022 messages
-- =====================================================================================

-- INSTAPAY: real-time, settled immediately (up to ₱50,000).
-- PESONET:  batch; money waits in PESONet clearing (GL 2020) until the next cut-off.
ALTER TABLE bank_transfers ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'INSTAPAY';
ALTER TABLE bank_transfers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SETTLED';
ALTER TABLE bank_transfers ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE bank_transfers ADD COLUMN IF NOT EXISTS batch_id TEXT;
ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_rail_check;
ALTER TABLE bank_transfers ADD CONSTRAINT bank_transfers_rail_check CHECK (rail IN ('INSTAPAY', 'PESONET'));
ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_status_check;
ALTER TABLE bank_transfers ADD CONSTRAINT bank_transfers_status_check CHECK (status IN ('QUEUED', 'SETTLED'));
UPDATE bank_transfers SET settled_at = created_at WHERE status = 'SETTLED' AND settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transfers_queued ON bank_transfers (created_at) WHERE status = 'QUEUED';

-- Outbound ISO 20022 messages (pacs.008 FI-to-FI customer credit transfer), one per bank transfer.
CREATE TABLE IF NOT EXISTS payment_messages (
  id                SERIAL PRIMARY KEY,
  bank_transfer_id  INTEGER     NOT NULL UNIQUE REFERENCES bank_transfers (id),
  message_type      TEXT        NOT NULL DEFAULT 'pacs.008.001.08',
  msg_id            TEXT        NOT NULL UNIQUE,
  end_to_end_id     TEXT        NOT NULL,
  uetr              UUID        NOT NULL UNIQUE,
  rail              TEXT        NOT NULL,
  status            TEXT        NOT NULL CHECK (status IN ('ACCEPTED', 'QUEUED', 'SETTLED')),
  payload_json      JSONB       NOT NULL,
  payload_xml       TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per PESONet batch cut-off. The batch moves its total from clearing (GL 2020)
-- to settled outbound payments (GL 1020) in one ledger transaction.
CREATE TABLE IF NOT EXISTS pesonet_batches (
  id              SERIAL PRIMARY KEY,
  batch_id        TEXT        NOT NULL UNIQUE,
  cutoff_at       TIMESTAMPTZ NOT NULL,
  item_count      INTEGER     NOT NULL,
  total_cents     BIGINT      NOT NULL,
  transaction_id  INTEGER     NOT NULL REFERENCES transactions (id),
  settled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================================
-- AML / compliance monitoring
-- =====================================================================================

-- UNDER_REVIEW: a rule fired; outgoing transfers are held until compliance clears the account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS aml_status TEXT NOT NULL DEFAULT 'CLEAR';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_aml_status_check;
ALTER TABLE users ADD CONSTRAINT users_aml_status_check CHECK (aml_status IN ('CLEAR', 'UNDER_REVIEW'));

CREATE TABLE IF NOT EXISTS compliance_alerts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users (id),
  rule          TEXT        NOT NULL CHECK (rule IN ('LARGE_TRANSFER', 'VELOCITY')),
  amount_cents  BIGINT      NOT NULL,
  endpoint      TEXT        NOT NULL,
  details       JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_compliance_alerts_user ON compliance_alerts (user_id, status);

-- =====================================================================================
-- End-of-day reconciliation runs (scripts/reconcile-eod.js)
-- =====================================================================================

CREATE TABLE IF NOT EXISTS eod_reconciliations (
  id             SERIAL PRIMARY KEY,
  business_date  DATE        NOT NULL,
  run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT        NOT NULL CHECK (status IN ('BALANCED', 'EXCEPTIONS')),
  exceptions     INTEGER     NOT NULL,
  summary        JSONB       NOT NULL,
  audit_log_path TEXT
);

-- =====================================================================================
-- PayPulse Save: savings vault with daily interest
-- =====================================================================================

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('2030', 'Customer Savings Deposits', 'LIABILITY', 'CREDIT',
   'PayPulse Save vaults: money customers keep in savings'),
  ('5010', 'Interest Expense - Savings', 'EXPENSE', 'DEBIT',
   'Interest PayPulse pays on PayPulse Save balances')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system, gl_code)
VALUES ('SYS-INTEREST-EXPENSE', true, '5010')
ON CONFLICT (account_number) DO NOTHING;

-- A savings vault is an ordinary ledger account (GL 2030) owned through savings_owner_id.
-- accounts.user_id stays reserved for the main wallet (one per user), so every wallet lookup
-- (WHERE user_id = ...) keeps finding exactly the wallet.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS savings_owner_id INTEGER UNIQUE REFERENCES users (id);
-- Annual interest rate in basis points (600 = 6.00%).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS interest_rate_bps INTEGER;

CREATE SEQUENCE IF NOT EXISTS savings_account_seq START 5000000001;

-- One row per savings account per business day. interest_exact keeps the fractions of a
-- centavo; posted_cents is what was actually credited (whole centavos), so the remainder
-- carries over to the next day instead of being lost to rounding.
CREATE TABLE IF NOT EXISTS savings_interest_accruals (
  id                     SERIAL PRIMARY KEY,
  account_id             INTEGER        NOT NULL REFERENCES accounts (id),
  accrual_date           DATE           NOT NULL,
  closing_balance_cents  BIGINT         NOT NULL,
  rate_bps               INTEGER        NOT NULL,
  interest_exact         NUMERIC(20, 6) NOT NULL,
  posted_cents           BIGINT         NOT NULL,
  transaction_id         INTEGER        REFERENCES transactions (id),
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE (account_id, accrual_date)
);

-- Scheduled job runs (e.g. daily-interest for a business date): makes each run idempotent.
CREATE TABLE IF NOT EXISTS job_runs (
  id             SERIAL PRIMARY KEY,
  job            TEXT        NOT NULL,
  business_date  DATE        NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  summary        JSONB,
  UNIQUE (job, business_date)
);

-- =====================================================================================
-- Virtual cards (PCI-DSS style storage)
-- =====================================================================================

-- The full card number (PAN) is stored ONLY encrypted (AES-256-GCM). The CVV is never
-- stored: it is derived on demand from the PAN and expiry with a secret key, like an HSM does.
-- Everything outside this table refers to a card by its token.
CREATE TABLE IF NOT EXISTS virtual_cards (
  id               SERIAL PRIMARY KEY,
  token            TEXT        NOT NULL UNIQUE,
  user_id          INTEGER     NOT NULL REFERENCES users (id),
  account_id       INTEGER     NOT NULL REFERENCES accounts (id),
  brand            TEXT        NOT NULL DEFAULT 'VISA',
  bin              TEXT        NOT NULL,
  last4            TEXT        NOT NULL,
  pan_encrypted    TEXT        NOT NULL,
  pan_fingerprint  TEXT        NOT NULL UNIQUE,
  expiry_month     INTEGER     NOT NULL,
  expiry_year      INTEGER     NOT NULL,
  cardholder_name  TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_user ON virtual_cards (user_id);

-- =====================================================================================
-- Idempotency keys: a retried POST (same Idempotency-Key) replays the first answer
-- =====================================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       INTEGER     NOT NULL REFERENCES users (id),
  key           TEXT        NOT NULL,
  endpoint      TEXT        NOT NULL,
  request_hash  TEXT        NOT NULL,
  status_code   INTEGER,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- =====================================================================================
-- Top-up controls (mock checkout / "Add money")
-- =====================================================================================

-- TOPUP_VELOCITY: more than 5 top-ups within a minute (possible abuse of the top-up channel).
ALTER TABLE compliance_alerts DROP CONSTRAINT IF EXISTS compliance_alerts_rule_check;
ALTER TABLE compliance_alerts ADD CONSTRAINT compliance_alerts_rule_check
  CHECK (rule IN ('LARGE_TRANSFER', 'VELOCITY', 'TOPUP_VELOCITY'));

-- =====================================================================================
-- Roles (role-based access control)
-- =====================================================================================

-- CUSTOMER: normal user.  ADMIN: operator; the only role allowed to use "Add money" (mock top-ups)
-- and the QA sandbox / chaos tools. Set with ADMIN_EMAILS or `npm run admin:set -- <email> ADMIN`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'ADMIN'));

-- =====================================================================================
-- Instant Loan: a ₱50,000 credit line per customer
-- =====================================================================================

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('1030', 'Loans Receivable - Instant Loan', 'ASSET', 'DEBIT',
   'Loan principal customers still owe PayPulse'),
  ('4020', 'Interest Revenue - Instant Loan', 'REVENUE', 'CREDIT',
   'Interest collected on Instant Loan repayments')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system, gl_code)
VALUES ('SYS-LOANS-RECEIVABLE', true, '1030'), ('SYS-LOAN-INTEREST', true, '4020')
ON CONFLICT (account_number) DO NOTHING;

-- One row per loan. Interest is a flat add-on: principal x monthly rate x months, fixed at
-- disbursement. *_outstanding_cents go down with every repayment (interest first, then principal).
CREATE TABLE IF NOT EXISTS loans (
  id                            SERIAL PRIMARY KEY,
  user_id                       INTEGER     NOT NULL REFERENCES users (id),
  principal_cents               BIGINT      NOT NULL CHECK (principal_cents > 0),
  term_months                   INTEGER     NOT NULL CHECK (term_months IN (3, 6, 12)),
  monthly_rate_bps              INTEGER     NOT NULL,
  interest_cents                BIGINT      NOT NULL CHECK (interest_cents >= 0),
  installment_cents             BIGINT      NOT NULL CHECK (installment_cents > 0),
  principal_outstanding_cents   BIGINT      NOT NULL CHECK (principal_outstanding_cents >= 0),
  interest_outstanding_cents    BIGINT      NOT NULL CHECK (interest_outstanding_cents >= 0),
  status                        TEXT        NOT NULL DEFAULT 'ACTIVE'
                                            CHECK (status IN ('ACTIVE', 'PAID', 'WRITTEN_OFF')),
  disbursement_transaction_id   INTEGER     NOT NULL REFERENCES transactions (id),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                     TIMESTAMPTZ
);
-- At most one open loan per customer, enforced by the database too (not only by the service).
CREATE UNIQUE INDEX IF NOT EXISTS uq_loans_one_active ON loans (user_id) WHERE status = 'ACTIVE';

-- Every repayment, and every QA sandbox write-off, with its principal / interest split.
CREATE TABLE IF NOT EXISTS loan_payments (
  id               SERIAL PRIMARY KEY,
  loan_id          INTEGER     NOT NULL REFERENCES loans (id),
  kind             TEXT        NOT NULL CHECK (kind IN ('REPAYMENT', 'WRITE_OFF')),
  principal_cents  BIGINT      NOT NULL CHECK (principal_cents >= 0),
  interest_cents   BIGINT      NOT NULL CHECK (interest_cents >= 0),
  transaction_id   INTEGER     NOT NULL REFERENCES transactions (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON loan_payments (loan_id);

-- =====================================================================================
-- Pay Bills with the ₱5.00 bills cashback
-- =====================================================================================

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('2040', 'Biller Settlement - Payable to Billers', 'LIABILITY', 'CREDIT',
   'Bill payments collected from customers, owed to the billers (Meralco, PLDT, SSS, ...)'),
  ('5020', 'Marketing Expense - Cashback', 'EXPENSE', 'DEBIT',
   'Cashback rewards PayPulse pays customers on bill payments')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system, gl_code)
VALUES ('SYS-BILLER-SETTLEMENT', true, '2040'), ('SYS-CASHBACK-EXPENSE', true, '5020')
ON CONFLICT (account_number) DO NOTHING;

-- One row per bill payment. account_ref is what the receipt shows: masked for card billers
-- (only the last 4 digits of a credit card number are ever stored).
CREATE TABLE IF NOT EXISTS bill_payments (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER     NOT NULL REFERENCES users (id),
  biller_code               TEXT        NOT NULL,
  account_ref               TEXT        NOT NULL,
  account_name              TEXT        NOT NULL,
  amount_cents              BIGINT      NOT NULL CHECK (amount_cents > 0),
  fee_cents                 BIGINT      NOT NULL DEFAULT 0,
  cashback_cents            BIGINT      NOT NULL DEFAULT 0 CHECK (cashback_cents >= 0),
  transaction_id            INTEGER     NOT NULL UNIQUE REFERENCES transactions (id),
  cashback_transaction_id   INTEGER     UNIQUE REFERENCES transactions (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bill_payments_user ON bill_payments (user_id, created_at);

-- =====================================================================================
-- My Profile: KYC level, security preferences, linked accounts, support tickets
-- =====================================================================================

-- KYC tier: 1 = Basic (email + mobile), 2 = Fully Verified (government ID + selfie, mock check).
-- The tier sets the daily send limit (limitsService). Only the last 4 characters of the ID are kept.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_level_check;
ALTER TABLE users ADD CONSTRAINT users_kyc_level_check CHECK (kyc_level IN (1, 2));
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_id_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_id_last4 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ;

-- Security preferences. sms_2fa_all: ask for an SMS code on EVERY Send / Bank Transfer (the code
-- above ₱1,000 is always required). biometric_login: preference only (simulated on the web).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_2fa_all BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS biometric_login BOOLEAN NOT NULL DEFAULT false;

-- Linked bank accounts and cards (mock: nothing is debited from them). Only the last 4 digits are
-- stored; card CVVs are never asked for.
CREATE TABLE IF NOT EXISTS linked_accounts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER     NOT NULL REFERENCES users (id),
  kind           TEXT        NOT NULL CHECK (kind IN ('BANK', 'CARD')),
  institution    TEXT        NOT NULL,
  last4          TEXT        NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  holder_name    TEXT        NOT NULL,
  expiry         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, institution, last4)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users (id),
  category    TEXT        NOT NULL CHECK (category IN ('TRANSFER', 'BILLS', 'LOAN', 'CARD', 'ACCOUNT', 'OTHER')),
  subject     TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, created_at DESC);

-- =====================================================================================
-- Notifications: which announcements / activity items each customer has read
-- =====================================================================================

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id          INTEGER     NOT NULL REFERENCES users (id),
  notification_id  TEXT        NOT NULL,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

-- =====================================================================================
-- Virtual card payments (online purchases with the virtual Visa)
-- =====================================================================================

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('2050', 'Card Settlement - Payable to Merchants', 'LIABILITY', 'CREDIT',
   'Virtual card purchases taken from wallets, owed to merchants through the card network')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system, gl_code)
VALUES ('SYS-CARD-SETTLEMENT', true, '2050')
ON CONFLICT (account_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS card_payments (
  id               SERIAL PRIMARY KEY,
  card_id          INTEGER     NOT NULL REFERENCES virtual_cards (id),
  user_id          INTEGER     NOT NULL REFERENCES users (id),
  merchant         TEXT        NOT NULL,
  amount_cents     BIGINT      NOT NULL CHECK (amount_cents > 0),
  auth_code        TEXT        NOT NULL,
  transaction_id   INTEGER     NOT NULL UNIQUE REFERENCES transactions (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_card_payments_user ON card_payments (user_id, created_at);

-- =====================================================================================
-- Real-time notifications
-- =====================================================================================

-- Every ledger entry is announced on the paypulse_ledger channel. PostgreSQL delivers NOTIFY
-- only when the transaction COMMITS (and never if it rolls back), so the app's live toasts can
-- never announce money that didn't actually move. src/realtime.js LISTENs and pushes the
-- events to the owner's browser over Socket.IO.
CREATE OR REPLACE FUNCTION notify_ledger_entry() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('paypulse_ledger', json_build_object(
    'transactionId', NEW.transaction_id,
    'accountId', NEW.account_id,
    'direction', NEW.direction,
    'amountCents', NEW.amount_cents
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_notify ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_notify
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION notify_ledger_entry();

-- =====================================================================================
-- Buy Load (mobile prepaid top-up) with the ₱5.00 load cashback
-- =====================================================================================

INSERT INTO gl_accounts (code, name, category, normal_balance, description) VALUES
  ('2060', 'Telco Settlement - Payable to Telcos', 'LIABILITY', 'CREDIT',
   'Prepaid load sold to customers, owed to Globe, Smart, DITO and GOMO')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category,
  normal_balance = EXCLUDED.normal_balance, description = EXCLUDED.description;

INSERT INTO accounts (account_number, is_system, gl_code)
VALUES ('SYS-TELCO-SETTLEMENT', true, '2060')
ON CONFLICT (account_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS load_purchases (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER     NOT NULL REFERENCES users (id),
  mobile_number             TEXT        NOT NULL CHECK (mobile_number ~ '^09[0-9]{9}$'),
  brand                     TEXT        NOT NULL CHECK (brand IN ('GLOBE', 'TM', 'SMART', 'TNT', 'DITO', 'GOMO')),
  network                   TEXT        NOT NULL,
  product_code              TEXT        NOT NULL,
  product_name              TEXT        NOT NULL,
  amount_cents              BIGINT      NOT NULL CHECK (amount_cents > 0),
  cashback_cents            BIGINT      NOT NULL DEFAULT 0 CHECK (cashback_cents >= 0),
  transaction_id            INTEGER     NOT NULL UNIQUE REFERENCES transactions (id),
  cashback_transaction_id   INTEGER     UNIQUE REFERENCES transactions (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_load_purchases_user ON load_purchases (user_id, created_at);

-- =====================================================================================
-- Over-the-counter (OTC) cash-in: a 12-digit payment code the customer pays at a partner
-- (pawnshop, convenience store, mall, pharmacy). The partner confirms the payment and the wallet
-- is credited once (a DEPOSIT from SYS-EXTERNAL-FUNDING: the partner remits the cash to PayPulse's
-- bank). The counter fee is paid to the partner on top of the amount, so it never enters this ledger.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS otc_cash_in_codes (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER     NOT NULL REFERENCES users (id),
  partner_code   TEXT        NOT NULL,
  reference      CHAR(12)    NOT NULL UNIQUE CHECK (reference ~ '^[0-9]{12}$'),
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents > 0),
  fee_cents      BIGINT      NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  status         TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'EXPIRED')),
  expires_at     TIMESTAMPTZ NOT NULL,
  paid_at        TIMESTAMPTZ,
  partner_txn_id TEXT,
  transaction_id INTEGER     UNIQUE REFERENCES transactions (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otc_cash_in_codes_user ON otc_cash_in_codes (user_id, created_at);
