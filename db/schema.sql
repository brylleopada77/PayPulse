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
