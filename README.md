# PayPulse

A small e-wallet backend (Node.js + Express + PostgreSQL) built for **QA and test-automation practice**.

- User registration, login (JWT) and balance check
- Wallet-to-wallet transfers recorded in a **double-entry ledger**
- A mock **payment webhook** that tops up wallets
- A Playwright + k6 test suite and a GitHub Actions pipeline

> ⚠️ This app contains an **intentional race-condition bug** in the transfer endpoint, for QA
> training. Never use it with real money. Details (spoilers!) are in [QA_NOTES.md](QA_NOTES.md).

---

## 1. Prerequisites

| Tool | Needed for | Get it |
|------|------------|--------|
| Docker Desktop | Running the app + database | https://www.docker.com/products/docker-desktop/ |
| Node.js 20+ | Running the tests (and the app without Docker) | https://nodejs.org |
| Git | Getting the code | https://git-scm.com |

## 2. Quick start with Docker (recommended)

```bash
git clone https://github.com/brylleopada77/PayPulse.git
cd PayPulse

# Build and start the API + PostgreSQL in the background
docker compose up -d --build --wait
```

Verify that everything is running:

```bash
docker compose ps                     # both services should say "running (healthy)"
curl http://localhost:3000/health     # {"status":"ok","database":"up"}
docker compose logs -f app            # follow the API logs (Ctrl+C to stop following)
```

> On Windows PowerShell use `curl.exe` instead of `curl`.

Stop everything:

```bash
docker compose down        # stop containers, keep data
docker compose down -v     # stop containers AND delete the database
```

## 3. Run without Docker (optional)

You need a PostgreSQL 14+ server running locally.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL if needed
npm run db:init               # create tables
npm run dev                   # start API on http://localhost:3000 (auto-restarts on changes)
```

## 4. Running the tests

Start the app with Docker first (step 2), then:

```bash
npm install                    # once

npx playwright test            # API test suite
npx playwright show-report     # open the HTML report

docker compose run --rm k6     # k6 concurrency test (10 simultaneous transfers)

npm run db:check               # verify the whole ledger is balanced
```

Because of the intentional bug, expect these results:

| Command | Result while the bug exists |
|---------|-----------------------------|
| `npx playwright test` | All pass. The concurrency test is marked as an *expected failure* |
| `docker compose run --rm k6` | Thresholds **fail** (money was created) |
| `npm run db:check` | **FAIL** after the concurrency tests have run |

## 5. API reference

All bodies are JSON. Amounts are decimal numbers or strings with up to 2 decimals (e.g. `25`, `"25.50"`).

| Method | Path | Auth | Body |
|--------|------|------|------|
| GET | `/health` | – | – |
| POST | `/api/auth/register` | – | `{ email, password, fullName }` |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token }` |
| GET | `/api/accounts/me` | Bearer | – → balance |
| GET | `/api/accounts/me/transactions` | Bearer | – → ledger history |
| POST | `/api/transfers` | Bearer | `{ toAccountNumber, amount, description? }` |
| POST | `/api/webhooks/payments` | HMAC signature | `{ paymentId, accountNumber, amount, status }` |

### Try it by hand

```bash
# Register and log in
curl -X POST localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d '{"email":"ana@test.com","password":"Sup3rSecret!","fullName":"Ana"}'
curl -X POST localhost:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"ana@test.com","password":"Sup3rSecret!"}'

# Check balance (paste the token from login)
curl localhost:3000/api/accounts/me -H "Authorization: Bearer <token>"
```

### Payment webhook

Money enters the system only through the webhook (a mock payment provider calling back).
The `X-PayPulse-Signature` header must be the hex **HMAC-SHA256** of the raw body using
`WEBHOOK_SECRET` (default `dev-webhook-secret`).

```bash
BODY='{"paymentId":"pay_001","accountNumber":"PP1000000001","amount":500,"status":"SUCCESS"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "dev-webhook-secret" | sed 's/^.* //')
curl -X POST localhost:3000/api/webhooks/payments \
  -H "Content-Type: application/json" -H "X-PayPulse-Signature: $SIG" -d "$BODY"
```

- `SUCCESS` credits the wallet; `PENDING` and `FAILED` do not.
- The same `paymentId` is only ever credited once, even if the callback is retried.

### Error format

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient balance for this transfer" } }
```

| Status | Codes |
|--------|-------|
| 400 | `INVALID_AMOUNT`, `INVALID_ACCOUNT_NUMBER`, `SAME_ACCOUNT`, `INVALID_EMAIL`, `INVALID_PASSWORD`, `INVALID_NAME`, `INVALID_STATUS`, `INVALID_JSON` |
| 401 | `UNAUTHORIZED` |
| 404 | `RECEIVER_NOT_FOUND`, `ACCOUNT_NOT_FOUND` |
| 409 | `EMAIL_TAKEN` |
| 422 | `INSUFFICIENT_FUNDS` |

## 6. How the ledger works

- Every money movement is a `transactions` row with `ledger_entries` where **debits = credits**.
- A wallet's balance = its credits − its debits. `accounts.balance_cents` caches that value.
- Top-ups move money **from** the system account `SYS-EXTERNAL-FUNDING` **to** the wallet,
  so the sum of **all** account balances is always exactly **0**.
- Money is stored as integer cents. No floating point.

## 7. Project structure

```
PayPulse/
├── src/
│   ├── app.js / server.js     Express app and entry point
│   ├── config.js              Environment variables
│   ├── db/pool.js             PostgreSQL pool + transaction helper
│   ├── middleware/            Auth (JWT) and error handling
│   ├── routes/                HTTP endpoints
│   ├── services/              Business logic (auth, accounts, transfers, payments, ledger)
│   └── utils/                 Errors and money helpers
├── db/schema.sql              Database tables
├── scripts/init-db.js         Creates tables (non-Docker setup)
├── tests/
│   ├── api/                   Playwright API tests
│   ├── load/                  k6 concurrency test
│   └── helpers/               API + database helpers, ledger checker
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/test.yml CI pipeline
```

## 8. CI/CD

`.github/workflows/test.yml` runs on every pull request:

1. Starts the app + database with Docker Compose
2. Runs the Playwright API tests
3. Runs the k6 concurrency test
4. Runs the database ledger check
5. On failure, uploads the Playwright HTML report, JUnit XML, k6 summary, DB report and container logs
   as the **paypulse-test-reports** artifact

While `RACE_BUG_EXPECTED` is `"true"`, the known bug doesn't block pull requests. See
[QA_NOTES.md](QA_NOTES.md) for what to change once it's fixed.
