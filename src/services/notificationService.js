// Notifications panel: announcements for everyone (announcements.js) plus personal activity
// (money received, cashback, Instant Loan installments due soon). Read state is kept per user
// in notification_reads, so it follows the customer to any device.
const { pool } = require('../db/pool');
const { ANNOUNCEMENTS } = require('./announcements');
const { badRequest } = require('../utils/errors');
const { shortName } = require('../utils/privacy');

const ACTIVITY_DAYS = 30;
const ACTIVITY_LIMIT = 15;
const LOAN_DUE_SOON_DAYS = 7;
const peso = (cents) => `₱${(Number(cents) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/** Money that came INTO the wallet recently (after a QA reset), newest first. */
async function activityFor(userId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.created_at, le.amount_cents,
            other.account_number AS from_account, ou.full_name AS from_name
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     JOIN accounts a ON a.id = le.account_id
     JOIN users u ON u.id = a.user_id
     LEFT JOIN LATERAL (
       SELECT oa.account_number, oa.user_id FROM ledger_entries ole
       JOIN accounts oa ON oa.id = ole.account_id
       WHERE ole.transaction_id = t.id AND ole.direction = 'DEBIT' LIMIT 1
     ) other ON true
     LEFT JOIN users ou ON ou.id = other.user_id
     WHERE a.user_id = $1 AND le.direction = 'CREDIT'
       AND t.type IN ('TRANSFER', 'DEPOSIT', 'CASHBACK')
       AND t.created_at > now() - make_interval(days => $2)
       AND t.created_at > COALESCE(u.history_cleared_at, '-infinity')
     ORDER BY t.id DESC LIMIT $3`,
    [userId, ACTIVITY_DAYS, ACTIVITY_LIMIT],
  );
  return rows.map((r) => {
    const amount = peso(r.amount_cents);
    if (r.type === 'TRANSFER') {
      return {
        id: `tx-${r.id}`,
        title: `You received ${amount}`,
        body: `From ${r.from_name ? shortName(r.from_name) : 'a PayPulse user'} (${r.from_account}).`,
        date: r.created_at,
        action: { label: 'View receipt', target: 'receipt', transactionId: r.id },
      };
    }
    if (r.type === 'CASHBACK') {
      return {
        id: `tx-${r.id}`,
        title: `${amount} cashback credited`,
        body: 'Your Pay Bills cashback is in your Available Balance.',
        date: r.created_at,
        action: { label: 'View receipt', target: 'receipt', transactionId: r.id },
      };
    }
    return {
      id: `tx-${r.id}`,
      title: `${amount} added to your wallet`,
      body: 'Your top-up was successful.',
      date: r.created_at,
      action: { label: 'View receipt', target: 'receipt', transactionId: r.id },
    };
  });
}

/** "Installment due" reminder for an open Instant Loan due within a week (or overdue). */
async function loanReminderFor(userId) {
  const { rows } = await pool.query(`SELECT * FROM loans WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
  const loan = rows[0];
  if (!loan) return [];
  const total = Number(loan.principal_cents) + Number(loan.interest_cents);
  const paid = total - Number(loan.principal_outstanding_cents) - Number(loan.interest_outstanding_cents);
  const installment = Number(loan.installment_cents);
  const number = Math.min(loan.term_months, Math.floor(paid / installment) + 1);
  const due = new Date(loan.created_at);
  due.setMonth(due.getMonth() + number);
  const daysLeft = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > LOAN_DUE_SOON_DAYS) return [];
  const amountDue = Math.min(installment * number - paid, total - paid);
  return [{
    id: `loan-${loan.id}-${number}`,
    title: daysLeft < 0 ? 'Loan installment overdue' : 'Loan installment due soon',
    body: `Installment ${number} of ${loan.term_months}: ${peso(amountDue)} due ${due.toISOString().slice(0, 10)}.`,
    date: new Date(Math.min(Date.now(), due.getTime())).toISOString(),
    action: { label: 'Pay now', target: 'loan' },
  }];
}

/** GET /api/v1/notifications */
async function list(userId) {
  const now = Date.now();
  const announcements = ANNOUNCEMENTS.filter((a) => new Date(a.publishedAt).getTime() <= now).map((a) => ({
    id: a.id,
    category: a.category,
    title: a.title,
    body: a.body,
    date: a.publishedAt,
    eventDate: a.eventDate ?? null,
    eventEnd: a.eventEnd ?? null,
    action: a.action ?? null,
  }));
  const personal = [...(await loanReminderFor(userId)), ...(await activityFor(userId))].map((n) => ({
    category: 'ACTIVITY',
    eventDate: null,
    eventEnd: null,
    ...n,
  }));

  const items = [...personal, ...announcements].sort((a, b) => new Date(b.date) - new Date(a.date));
  const { rows } = await pool.query(
    'SELECT notification_id FROM notification_reads WHERE user_id = $1 AND notification_id = ANY($2)',
    [userId, items.map((i) => i.id)],
  );
  const read = new Set(rows.map((r) => r.notification_id));
  const withRead = items.map((i) => ({ ...i, read: read.has(i.id) }));
  const unread = withRead.filter((i) => !i.read);
  return {
    unreadCount: unread.length,
    unreadByCategory: Object.fromEntries(
      ['UPDATE', 'FEATURE', 'EVENT', 'ACTIVITY'].map((c) => [c, unread.filter((i) => i.category === c).length]),
    ),
    items: withRead,
  };
}

/** POST /api/v1/notifications/read  { ids: [...] } or { all: true } */
async function markRead(userId, { ids, all } = {}) {
  let targets;
  if (all === true) {
    targets = (await list(userId)).items.map((i) => i.id);
  } else if (Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every((id) => typeof id === 'string' && id.length <= 64)) {
    targets = ids;
  } else {
    throw badRequest('INVALID_NOTIFICATIONS', 'Send { ids: [...] } (1 to 100 notification ids) or { all: true }');
  }
  await pool.query(
    `INSERT INTO notification_reads (user_id, notification_id)
     SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [userId, targets],
  );
  const { unreadCount, unreadByCategory } = await list(userId);
  return { unreadCount, unreadByCategory };
}

module.exports = { list, markRead };
