-- PayPulse database schema
-- Safe to run more than once (all statements are idempotent).
--
-- Money is always stored as BIGINT cents (no floating point).
--
-- Double-entry rules:
--   * Every money movement is a row in `transactions`.
--   * Each transaction has ledger entries whose DEBIT total equals its CREDIT total.
--   * An account's balance = SUM(credits) - SUM(debits) of its ledger entries.
--   * `accounts.balance_cents` is a cached copy of that number for fast reads.
--   * Money enters the system through the EXTERNAL_FUNDING system account, so the
--     sum of ALL account balances (users + system) must always be exactly 0.

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
  balance_cents  BIGINT      NOT NULL DEFAULT 0,
  currency       CHAR(3)     NOT NULL DEFAULT 'PHP',
  is_system      BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- User wallets can never go below zero. System accounts can.
  CONSTRAINT non_negative_user_balance CHECK (is_system OR balance_cents >= 0)
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
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('TRANSFER', 'DEPOSIT', 'BANK_TRANSFER', 'QA_ADJUSTMENT'));

INSERT INTO accounts (account_number, is_system)
VALUES ('SYS-QA-ADJUSTMENT', true)
ON CONFLICT (account_number) DO NOTHING;
