# QA Notes: the intentional race-condition bug

> **Spoiler warning.** If you are practising bug hunting, stop reading here and try to
> find the bug yourself with the concurrency tests first.

## Where it is

`src/services/transferService.js`: `transfer()` and `bankTransfer()` call `findSenderAccount()`,
which reads the sender's balance from the view `account_balances` (an aggregation of the ledger)
**without any lock**, then checks `balance >= amount` in JavaScript before posting the journal.
The MPIN, OTP, AML and limit checks all run before this and don't prevent the bug.

## What goes wrong

Balances are computed from the immutable ledger, so the system can't *create* money any more.
But two transfers that run at the same moment both read the balance **before either has posted**:

| Time | Request A | Request B |
|------|-----------|-----------|
| t1 | reads balance = 100 | reads balance = 100 |
| t2 | 100 ≥ 30 ✔ | 100 ≥ 30 ✔ |
| t3 | posts DEBIT 30 / CREDIT 30, commit | posts DEBIT 30 / CREDIT 30, commit |
| ... | (8 more requests do the same) | |

Result: 7 to 10 of 10 transfers of ₱30 succeed from a ₱100 wallet. Every journal balances and the
total money is unchanged, but the sender is **overdrawn** (e.g. **-₱110** or **-₱200**). This is a
classic *check-then-act* race: the check and the write are not atomic.

(Before the General Ledger restructure, balances were a stored column updated from a value computed
in JavaScript, so the same race *created* money through a lost update. Moving to computed balances
turned it into an overdraft, which is what real ledgers without locking suffer from.)

## Same root cause: limits and AML velocity can be bypassed

The daily ₱50,000 limit, the anti-spam rule (3 transfers / 10 seconds) and the AML velocity rule
(5 transfers / minute) also read the account's history **without a lock**. Sequential requests are
limited correctly, but a burst of simultaneous requests all read "0 transfers so far" and all pass.

## How the tests catch it

| Test | What it sees |
|------|--------------|
| `tests/api/concurrency.spec.ts` | More than 3 of 10 transfers succeed; the sender's balance is below 0 |
| `tests/load/race-transfer.js` (k6) | `overspent_transfers` and `overdrawn_cents` thresholds fail |
| `npm run db:check` | "Overdrawn customer wallets (balance < 0)" |
| `npm run db:assert-ledger` | "No customer wallet is overdrawn" fails, listing the accounts |
| `npm run eod:reconcile` | Exception `OD-1` in the end-of-day audit log, with every overdrawn wallet |

All the money checks (trial balance, sum of balances = 0, customer liability = sum of wallets) keep
passing: that is exactly why an overdraft check is needed.

Tip: the QA Sandbox **Reset account state** posts a `QA_ADJUSTMENT` journal that brings one
account back to ₱1,000, so an overdrawn test wallet can be reused.

## How to fix it

Any one of these works. The first is the simplest:

**Option 1: lock the sender's account row** at the start of the transfer's database transaction,
so concurrent transfers for the same wallet wait their turn, then read the balance:
```sql
SELECT id FROM accounts WHERE user_id = $1 FOR UPDATE;
SELECT balance_cents FROM account_balances WHERE account_id = $1;
```
Run the limit and AML checks inside the same transaction, after the lock, to close those gaps too.

**Option 2: per-wallet advisory lock**: `SELECT pg_advisory_xact_lock(<account id>)` at the
start of the transaction (same effect, no row lock needed).

**Option 3:** run the transaction at `SERIALIZABLE` isolation and retry on error `40001`.

## After fixing

1. Set `RACE_BUG_EXPECTED: "false"` in `.github/workflows/test.yml`.
2. Run locally with `RACE_BUG_EXPECTED=false npx playwright test`. The concurrency test should now pass.
3. `docker compose run --rm k6`, `npm run db:check`, `npm run db:assert-ledger` and
   `npm run eod:reconcile` should pass (on a fresh database).
