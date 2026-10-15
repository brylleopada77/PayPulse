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
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('TRANSFER', 'DEPOSIT', 'BANK_TRANSFER', 'QA_ADJUSTMENT', 'PESONET_SETTLEMENT'));

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
