// Instant Loan: a pre-approved ₱50,000 credit line per customer.
//
// Disbursement:  DEBIT  Loans Receivable (GL 1030)        principal
//                CREDIT customer wallet (GL 2010)          principal
// Repayment:     DEBIT  customer wallet                    amount paid
//                CREDIT Interest Revenue (GL 4020)         interest part (paid first)
//                CREDIT Loans Receivable                   principal part
//
// Interest is a flat add-on fixed at disbursement (principal x 1.5% x months), repaid in equal
// monthly installments. One open loan per customer: the user row is locked while applying and a
// partial unique index (uq_loans_one_active) backs it up, so parallel applications can't both win.
const { pool, withTransaction } = require('../db/pool');
const { recordTransaction, getBalanceCents } = require('./ledgerService');
const { referenceFor } = require('./receiptService');
const mpinService = require('./mpinService');
const { badRequest, conflict, forbidden, locked, notFound, unprocessable } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');

const CREDIT_LINE_CENTS = 5_000_000; // ₱50,000.00
const MIN_LOAN_CENTS = 100_000; // ₱1,000.00
const MONTHLY_RATE_BPS = 150; // 1.50% per month, flat
const TERMS = [3, 6, 12];
const RECEIVABLE_ACCOUNT = 'SYS-LOANS-RECEIVABLE';
const INTEREST_ACCOUNT = 'SYS-LOAN-INTEREST';

/** Interest, total and monthly installment for a principal and term (all in cents). */
function quote(principalCents, termMonths) {
  const interestCents = Math.round((principalCents * MONTHLY_RATE_BPS * termMonths) / 10_000);
  const totalCents = principalCents + interestCents;
  return { interestCents, totalCents, installmentCents: Math.ceil(totalCents / termMonths) };
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Public view of a loan, with its installment schedule. */
function present(loan) {
  const principalCents = Number(loan.principal_cents);
  const interestCents = Number(loan.interest_cents);
  const installmentCents = Number(loan.installment_cents);
  const totalCents = principalCents + interestCents;
  const outstandingCents = Number(loan.principal_outstanding_cents) + Number(loan.interest_outstanding_cents);
  const paidCents = totalCents - outstandingCents;

  let cumulative = 0;
  const schedule = Array.from({ length: loan.term_months }, (_, i) => {
    const amountCents = i === loan.term_months - 1 ? totalCents - installmentCents * i : installmentCents;
    cumulative += amountCents;
    const remainingCents = Math.max(0, Math.min(amountCents, cumulative - paidCents));
    return {
      number: i + 1,
      dueDate: addMonths(loan.created_at, i + 1),
      amount: fromCents(amountCents),
      remaining: fromCents(remainingCents),
      status: remainingCents === 0 ? 'PAID' : 'DUE',
    };
  });
  const next = loan.status === 'ACTIVE' ? schedule.find((s) => s.status === 'DUE') : null;

  return {
    loanId: loan.id,
    status: loan.status,
    principal: fromCents(principalCents),
    termMonths: loan.term_months,
    monthlyRate: (loan.monthly_rate_bps / 100).toFixed(2),
    interest: fromCents(interestCents),
    totalRepayable: fromCents(totalCents),
    monthlyInstallment: fromCents(installmentCents),
    paid: fromCents(paidCents),
    outstanding: fromCents(outstandingCents),
    principalOutstanding: fromCents(Number(loan.principal_outstanding_cents)),
    interestOutstanding: fromCents(Number(loan.interest_outstanding_cents)),
    nextDue: next ? { dueDate: next.dueDate, amount: next.remaining } : null,
    schedule,
    createdAt: loan.created_at,
    closedAt: loan.closed_at,
  };
}

/** Credit line, offer terms and the customer's open loan (if any). */
async function getOverview(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM loans WHERE user_id = $1 ORDER BY (status = 'ACTIVE') DESC, id DESC LIMIT 1`,
    [userId],
  );
  const active = rows[0]?.status === 'ACTIVE' ? rows[0] : null;
  return {
    creditLimit: fromCents(CREDIT_LINE_CENTS),
    available: fromCents(active ? 0 : CREDIT_LINE_CENTS),
    minAmount: fromCents(MIN_LOAN_CENTS),
    maxAmount: fromCents(CREDIT_LINE_CENTS),
    monthlyRate: (MONTHLY_RATE_BPS / 100).toFixed(2),
    terms: TERMS,
    activeLoan: active ? present(active) : null,
  };
}

/** POST /api/v1/loans/quote: what a loan would cost, without taking it. */
function getQuote({ amount, termMonths } = {}) {
  const { principalCents, term } = validateOffer(amount, termMonths);
  const q = quote(principalCents, term);
  return {
    principal: fromCents(principalCents),
    termMonths: term,
    monthlyRate: (MONTHLY_RATE_BPS / 100).toFixed(2),
    interest: fromCents(q.interestCents),
    totalRepayable: fromCents(q.totalCents),
    monthlyInstallment: fromCents(q.installmentCents),
  };
}

function validateOffer(amount, termMonths) {
  const principalCents = toCents(amount);
  if (principalCents < MIN_LOAN_CENTS || principalCents > CREDIT_LINE_CENTS) {
    throw badRequest(
      'LOAN_AMOUNT_OUT_OF_RANGE',
      `Loan amount must be between ₱${fromCents(MIN_LOAN_CENTS)} and ₱${fromCents(CREDIT_LINE_CENTS)}`,
    ).withDetails({ minAmount: fromCents(MIN_LOAN_CENTS), maxAmount: fromCents(CREDIT_LINE_CENTS) });
  }
  const term = Number(termMonths);
  if (!TERMS.includes(term)) {
    throw badRequest('INVALID_LOAN_TERM', 'Term must be 3, 6 or 12 months').withDetails({ terms: TERMS });
  }
  return { principalCents, term };
}

const systemAccountId = async (client, accountNumber) =>
  (await client.query('SELECT id FROM accounts WHERE account_number = $1', [accountNumber])).rows[0].id;

/** Apply & Disburse: credits the principal to the wallet straight away. Needs the MPIN. */
async function apply(userId, { amount, termMonths, mpin } = {}) {
  const { principalCents, term } = validateOffer(amount, termMonths);
  await mpinService.verifyMpin(userId, mpin);
  const q = quote(principalCents, term);

  try {
    return await withTransaction(async (client) => {
      // Serialise all loan applications of this user.
      const { rows: [user] } = await client.query(
        'SELECT frozen, aml_status FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (user.frozen) throw locked('ACCOUNT_FROZEN', 'This account is frozen. New loans are blocked until it is unfrozen.');
      if (user.aml_status === 'UNDER_REVIEW') {
        throw forbidden('TRANSACTION_HELD_FOR_REVIEW', 'Transaction Held for Compliance Review').withDetails({
          rule: 'ACCOUNT_UNDER_REVIEW',
        });
      }
      const open = await client.query(`SELECT id FROM loans WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
      if (open.rows[0]) throw activeLoanError(open.rows[0].id);

      const wallet = await client.query('SELECT id FROM accounts WHERE user_id = $1', [userId]);
      if (!wallet.rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
      const transactionId = await recordTransaction(client, {
        type: 'LOAN_DISBURSEMENT',
        description: 'Loan Disbursement',
        entries: [
          { accountId: await systemAccountId(client, RECEIVABLE_ACCOUNT), direction: 'DEBIT', amountCents: principalCents },
          { accountId: wallet.rows[0].id, direction: 'CREDIT', amountCents: principalCents },
        ],
      });
      const { rows: [loan] } = await client.query(
        `INSERT INTO loans (user_id, principal_cents, term_months, monthly_rate_bps, interest_cents, installment_cents,
                            principal_outstanding_cents, interest_outstanding_cents, disbursement_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $2, $5, $7) RETURNING *`,
        [userId, principalCents, term, MONTHLY_RATE_BPS, q.interestCents, q.installmentCents, transactionId],
      );

      return {
        ...present(loan),
        transactionId,
        reference: await referenceFor(client, transactionId),
        balanceAfter: fromCents(await getBalanceCents(client, wallet.rows[0].id)),
      };
    });
  } catch (err) {
    // Lost a race the user-row lock didn't cover (e.g. a second server): the index still says no.
    if (err.code === '23505' && err.constraint === 'uq_loans_one_active') throw activeLoanError();
    throw err;
  }
}

function activeLoanError(loanId) {
  const err = conflict('LOAN_ALREADY_ACTIVE', 'You already have an Instant Loan. Repay it before taking a new one.');
  return loanId ? err.withDetails({ loanId }) : err;
}

/** Repay part or all of a loan from the wallet. Interest is paid first, then principal. */
async function repay(userId, loanId, { amount } = {}) {
  const amountCents = toCents(amount);

  return withTransaction(async (client) => {
    const wallet = await client.query('SELECT id FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!wallet.rows[0]) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    const walletId = wallet.rows[0].id;

    const { rows: [loan] } = await client.query('SELECT * FROM loans WHERE id = $1 AND user_id = $2 FOR UPDATE', [
      Number(loanId) || 0,
      userId,
    ]);
    if (!loan) throw notFound('LOAN_NOT_FOUND', 'Loan not found');
    if (loan.status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'This loan is already closed');

    const interestDue = Number(loan.interest_outstanding_cents);
    const principalDue = Number(loan.principal_outstanding_cents);
    if (amountCents > interestDue + principalDue) {
      throw badRequest('AMOUNT_EXCEEDS_BALANCE_DUE', 'Amount is more than you owe on this loan').withDetails({
        outstanding: fromCents(interestDue + principalDue),
      });
    }
    const walletBalance = await getBalanceCents(client, walletId);
    if (walletBalance < amountCents) {
      throw unprocessable('INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this amount');
    }

    const interestCents = Math.min(amountCents, interestDue);
    const principalCents = amountCents - interestCents;
    const entries = [{ accountId: walletId, direction: 'DEBIT', amountCents }];
    if (interestCents > 0) {
      entries.push({ accountId: await systemAccountId(client, INTEREST_ACCOUNT), direction: 'CREDIT', amountCents: interestCents });
    }
    if (principalCents > 0) {
      entries.push({ accountId: await systemAccountId(client, RECEIVABLE_ACCOUNT), direction: 'CREDIT', amountCents: principalCents });
    }
    const transactionId = await recordTransaction(client, {
      type: 'LOAN_REPAYMENT',
      description: 'Loan Repayment',
      entries,
    });
    await client.query(
      `INSERT INTO loan_payments (loan_id, kind, principal_cents, interest_cents, transaction_id)
       VALUES ($1, 'REPAYMENT', $2, $3, $4)`,
      [loan.id, principalCents, interestCents, transactionId],
    );
    const { rows: [updated] } = await client.query(
      `UPDATE loans
       SET interest_outstanding_cents = interest_outstanding_cents - $2,
           principal_outstanding_cents = principal_outstanding_cents - $3,
           status = CASE WHEN principal_outstanding_cents - $3 = 0 AND interest_outstanding_cents - $2 = 0
                         THEN 'PAID' ELSE status END,
           closed_at = CASE WHEN principal_outstanding_cents - $3 = 0 AND interest_outstanding_cents - $2 = 0
                            THEN now() ELSE closed_at END
       WHERE id = $1 RETURNING *`,
      [loan.id, interestCents, principalCents],
    );

    return {
      ...present(updated),
      payment: { amount: fromCents(amountCents), interest: fromCents(interestCents), principal: fromCents(principalCents) },
      transactionId,
      reference: await referenceFor(client, transactionId),
      balanceAfter: fromCents(walletBalance - amountCents),
    };
  });
}

/**
 * QA sandbox reset only: close the user's open loan without payment. The unpaid principal leaves
 * Loans Receivable against GL 3900 Sandbox Adjustments; interest not yet collected is never booked.
 * @param client  a client inside the reset's transaction
 */
async function writeOffForQa(client, userId, qaAccountId) {
  const { rows } = await client.query(`SELECT * FROM loans WHERE user_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [userId]);
  for (const loan of rows) {
    const principalCents = Number(loan.principal_outstanding_cents);
    const transactionId = await recordTransaction(client, {
      type: 'QA_ADJUSTMENT',
      description: 'QA sandbox reset: loan written off',
      entries: [
        { accountId: qaAccountId, direction: 'DEBIT', amountCents: principalCents },
        { accountId: await systemAccountId(client, RECEIVABLE_ACCOUNT), direction: 'CREDIT', amountCents: principalCents },
      ],
    });
    await client.query(
      `INSERT INTO loan_payments (loan_id, kind, principal_cents, interest_cents, transaction_id)
       VALUES ($1, 'WRITE_OFF', $2, 0, $3)`,
      [loan.id, principalCents, transactionId],
    );
    await client.query(`UPDATE loans SET status = 'WRITTEN_OFF', closed_at = now() WHERE id = $1`, [loan.id]);
  }
}

module.exports = {
  getOverview,
  getQuote,
  apply,
  repay,
  writeOffForQa,
  quote,
  CREDIT_LINE_CENTS,
  MIN_LOAN_CENTS,
  MONTHLY_RATE_BPS,
};
