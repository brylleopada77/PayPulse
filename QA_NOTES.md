# QA Notes: the race-condition bug (found, fixed, guarded)

> **Status: FIXED** with row-level locking (`src/services/walletLock.js`). PayPulse shipped with this
> bug on purpose as a target for the automation; this page is the write-up: what was wrong, how the
> tests proved it, how it was fixed, and what guards it now.

## Where it was

`src/services/transferService.js`: `transfer()` and `bankTransfer()` called `findSenderAccount()`,
which read the sender's balance from the view `account_balances` (an aggregation of the ledger)
**without any lock**, then checked `balance >= amount` in JavaScript before posting the journal.
The MPIN, OTP, AML and limit checks all ran before this and didn't prevent the bug.

## What went wrong

Balances are computed from the immutable ledger, so the system can't *create* money. But two
transfers that ran at the same moment both read the balance **before either had posted**:

| Time | Request A | Request B |
|------|-----------|-----------|
| t1 | reads balance = 100 | reads balance = 100 |
| t2 | 100 ≥ 30 ✔ | 100 ≥ 30 ✔ |
| t3 | posts DEBIT 30 / CREDIT 30, commit | posts DEBIT 30 / CREDIT 30, commit |
| ... | (8 more requests do the same) | |

Result: 7 to 10 of 10 transfers of ₱30 succeeded from a ₱100 wallet. Every journal balanced and the
total money was unchanged, but the sender was **overdrawn** (e.g. **-₱110** or **-₱200**): a classic
*check-then-act* race, because the check and the write were not atomic.

**Same root cause, limits and AML:** the daily ₱50,000 limit, the anti-spam rule (3 transfers / 10
seconds) and the AML velocity rule (5 transfers / minute) also read the account's history without a
lock. A burst of simultaneous requests all read "0 transfers so far" and all passed.

## How the tests caught it

| Test | What it saw (before the fix) |
|------|------------------------------|
| `tests/api/concurrency.spec.ts` | More than 3 of 10 transfers succeeded; the sender's balance below 0 |
| k6 (`tests/load/race-transfer.js`, now `concurrency-test.js`) | The overspent / overdrawn thresholds failed (report: wallet at -₱200) |
| `npm run db:check`, `npm run db:assert-ledger` | "No customer wallet is overdrawn" failed, listing the accounts |
| `npm run eod:reconcile` | Exception `OD-1` in the end-of-day audit log |

All the money checks (trial balance, sum of balances = 0, customer liability = sum of wallets) kept
passing. That is exactly why an overdraft check is needed.

## The fix: row-level locking

`src/services/walletLock.js`, used by every payment out of a wallet: Express Send, Bank Transfer, Pay
Bills, Buy Load and card payments. Each runs in **one database transaction**:

```sql
BEGIN;
SELECT id FROM accounts WHERE user_id = $1 FOR UPDATE;              -- 1. lock the payer's wallet row
SELECT balance_cents FROM account_balances WHERE account_id = $2;   -- 2. read the balance under the lock
-- 3. AML screen + daily limit + anti-spam, on the SAME connection
-- 4. balance check; any failure -> ROLLBACK (no ledger entry is written)
INSERT INTO transactions ...; INSERT INTO ledger_entries ... DEBIT / CREDIT;  -- 5. post the journal
COMMIT;                                                              -- the lock is released here
```

- Simultaneous payments from one wallet now **queue on the row lock**: each reads the balance and the
  counters only after the previous one committed or rolled back.
- `withTransaction` (`src/db/pool.js`) runs `BEGIN` / `COMMIT`, and `ROLLBACK` on any thrown error.
- The checks under the lock use the transaction's own connection. A second pool connection could wait
  forever while every connection waits on the lock (pool starvation).
- An AML hold found under the lock can't write its alert inside the transaction being rolled back.
  The error carries the alert, and `withPaymentTransaction` opens it after the rollback.
- Lock order is always the wallet first, and a payment locks only one wallet, so payments can't
  deadlock each other. Savings moves lock both accounts in id order.
- The middlewares (`amlMonitor`, `enforceTransferLimits`) still run first, to fail fast.

**Why `FOR UPDATE`:**
- It is what Pay Bills, cards and savings already did, so every payment now locks the same way.
- A per-wallet `pg_advisory_xact_lock` would work too.
- `SERIALIZABLE` + retry on `40001` would add retries to every payment.

## Results after the fix

| Scenario | Result |
|----------|--------|
| 10 identical ₱60 transfers from ₱100 (API test and k6 gate) | **exactly 1** `201`, 9 × `422 INSUFFICIENT_FUNDS`, sender ₱40.00 |
| 10 × ₱30 from ₱100 | 3 succeed, sender ₱10.00, never below 0 |
| 10 × ₱10 from ₱1,000 (anti-spam burst) | exactly 3 succeed, 7 × `429 TOO_MANY_TRANSFERS` |
| Two simultaneous transfers at the AML velocity edge | 1 succeeds, 1 `403 TRANSACTION_HELD_FOR_REVIEW`; the alert is opened after the rollback |
| Bank Transfer / Pay Bills / Buy Load bursts | exactly 1 succeeds when the balance covers 1 |

The k6 step in CI runs `npm run test:concurrency`: the k6 concurrency test, then the system ledger
assertion (`SUM(debit) - SUM(credit) = 0`, cash = balances + fees + reserves, no overdrawn wallet).
The ledger assertion also runs after every Playwright run. Every one of these is a hard gate.

## Data remediation

The fix stops new overdrafts, but wallets overdrawn before it stay below zero (a ledger is never
edited). `npm run db:remediate-overdrafts` lists them. `npm run db:remediate-overdrafts -- --apply`
posts one balanced `QA_ADJUSTMENT` journal per wallet, which brings it back to ₱0.00:

- DEBIT GL 3900 Sandbox Adjustments;
- CREDIT the wallet.

This is the same journal the QA sandbox reset posts, so the system-cash equation still balances.
Demo/QA databases only: play money.
