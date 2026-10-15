# QA Notes: the intentional race-condition bug

> **Spoiler warning.** If you are practising bug hunting, stop reading here and try to
> find the bug yourself with the concurrency tests first.

## Where it is

`src/services/transferService.js`: `transfer()` calls `loadParties()` → `findSenderAccount()`.
The MPIN and OTP checks run before this and don't prevent the bug.
Bank transfers (`bankTransfer()` → `loadSender()`) read the balance the same way, so they have
the same bug: rapid duplicate bank transfers can spend more than the balance (amount + fee).

## What goes wrong

The transfer does this inside a database transaction:

1. `SELECT balance_cents FROM accounts WHERE user_id = $1` (a plain read, **no row lock**)
2. Checks `balance >= amount` in JavaScript
3. Writes the ledger entries
4. `UPDATE accounts SET balance_cents = $1` using the **value computed in JavaScript**
5. `UPDATE accounts SET balance_cents = balance_cents + $1` for the receiver

When several requests arrive at the same moment (a user double-clicking the MPIN "Confirm" button):

| Time | Request A | Request B |
|------|-----------|-----------|
| t1 | reads balance = 100 | reads balance = 100 |
| t2 | 100 ≥ 30 ✔ | 100 ≥ 30 ✔ |
| t3 | sets sender = **70** | waits for A's row lock |
| t4 | receiver += 30, commit | sets sender = **70** (overwrites A!) |
| t5 | | receiver += 30, commit |

Result: the sender paid 30 once but the receiver got 60. **Money was created.**
This is a classic *lost update*.

## Same root cause: the transfer limits can be bypassed

The daily ₱50,000 limit and the anti-spam rule (3 transfers / 10 seconds) in
`src/services/limitsService.js` also read the account's history **without a lock**. Sequential
requests are limited correctly, but a burst of simultaneous requests all read "0 transfers so far"
and all pass. In `concurrency.spec.ts` you'll typically see 7 to 10 of the 10 parallel requests
succeed (201) even though only 3 are allowed in 10 seconds, plus the money created by the race.

Locking the sender's account row (Option 1 below) fixes all three problems at once, as long as the
limit checks run inside the same transaction, after the lock.

## How the tests catch it

| Test | What it sees |
|------|--------------|
| `tests/api/concurrency.spec.ts` | More than 3 of 10 transfers succeed; sender + receiver > 100 |
| `tests/load/race-transfer.js` (k6) | `money_created_cents` and `overspent_transfers` thresholds fail |
| `npm run db:check` | Sum of all balances ≠ 0, cached balances ≠ ledger history |
| `npm run db:assert-ledger` | "Total money in system ≠ user balances + fees" with the exact amount created |

Tip: the QA Sandbox **Reset account state** rebuilds an account's balance from its ledger history,
so it also repairs a cached balance that the race bug broke (for that one account).

Note: the ledger itself still has balanced debits and credits for every transaction.
That's why the DB check also compares each account's **cached balance** with its
**ledger history**: that comparison is what exposes the lost update.

## How to fix it

Any one of these works. The first is the simplest:

**Option 1: lock the sender row** so concurrent transfers wait their turn:
```js
'SELECT id, account_number, balance_cents FROM accounts WHERE user_id = $1 FOR UPDATE'
```

**Option 2: atomic conditional update**: let the database do the check and the write together:
```sql
UPDATE accounts
SET balance_cents = balance_cents - $1
WHERE id = $2 AND balance_cents >= $1
RETURNING balance_cents;
-- 0 rows updated  ->  insufficient funds
```

**Option 3:** run the transaction at `SERIALIZABLE` isolation and retry on error `40001`.

## After fixing

1. Set `RACE_BUG_EXPECTED: "false"` in `.github/workflows/test.yml`.
2. Run locally with `RACE_BUG_EXPECTED=false npx playwright test`. The concurrency test should now pass.
3. `docker compose run --rm k6` should pass its thresholds.
