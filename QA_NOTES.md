# QA Notes: the intentional race-condition bug

> **Spoiler warning.** If you are practising bug hunting, stop reading here and try to
> find the bug yourself with the concurrency tests first.

## Where it is

`src/services/transferService.js`, in `transfer()`.

## What goes wrong

The transfer does this inside a database transaction:

1. `SELECT balance_cents FROM accounts WHERE user_id = $1` (a plain read, **no row lock**)
2. Checks `balance >= amount` in JavaScript
3. Writes the ledger entries
4. `UPDATE accounts SET balance_cents = $1` using the **value computed in JavaScript**
5. `UPDATE accounts SET balance_cents = balance_cents + $1` for the receiver

When several requests arrive at the same moment (a user double-clicking "Send"):

| Time | Request A | Request B |
|------|-----------|-----------|
| t1 | reads balance = 100 | reads balance = 100 |
| t2 | 100 ≥ 30 ✔ | 100 ≥ 30 ✔ |
| t3 | sets sender = **70** | waits for A's row lock |
| t4 | receiver += 30, commit | sets sender = **70** (overwrites A!) |
| t5 | | receiver += 30, commit |

Result: the sender paid 30 once but the receiver got 60. **Money was created.**
This is a classic *lost update*.

## How the tests catch it

| Test | What it sees |
|------|--------------|
| `tests/api/concurrency.spec.ts` | More than 3 of 10 transfers succeed; sender + receiver > 100 |
| `tests/load/race-transfer.js` (k6) | `money_created_cents` and `overspent_transfers` thresholds fail |
| `npm run db:check` | Sum of all balances ≠ 0, cached balances ≠ ledger history |

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
