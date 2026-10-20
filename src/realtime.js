// Real-time notifications over Socket.IO.
//
// Flow: a ledger entry is inserted -> the database trigger trg_ledger_entries_notify sends
// pg_notify('paypulse_ledger', …) -> PostgreSQL delivers it only once that transaction COMMITS
// -> this module LISTENs on a dedicated connection, works out whose wallet it was, and emits a
// `transaction` event to that user's room ("user:<id>") only. Browsers join their room with the
// same JWT the API uses, so nobody can listen to someone else's money.
//
// Event: { transactionId, type, direction, amount, title, message, kind, balance, unreadCount }
//   kind: 'money-in' | 'money-out' | 'cashback'
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const config = require('./config');
const { pool } = require('./db/pool');
const notificationService = require('./services/notificationService');
const { fromCents } = require('./utils/money');

const CHANNEL = 'paypulse_ledger';
const RECONNECT_MS = 3000;
const room = (userId) => `user:${userId}`;
const peso = (cents) => `₱${(Number(cents) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Title and one-line message for a wallet entry, from the owner's point of view. */
async function describe(entry, tx) {
  const amount = peso(entry.amountCents);
  const incoming = entry.direction === 'CREDIT';
  const counterpart = async () => {
    const { rows } = await pool.query(
      `SELECT a.account_number FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.transaction_id = $1 AND le.direction = $2 LIMIT 1`,
      [entry.transactionId, incoming ? 'DEBIT' : 'CREDIT'],
    );
    return rows[0]?.account_number ?? 'another account';
  };

  switch (tx.type) {
    case 'TRANSFER':
      return incoming
        ? { kind: 'money-in', title: 'Money received', message: `Received ${amount} from Account ${await counterpart()}` }
        : { kind: 'money-out', title: 'Money sent', message: `Sent ${amount} to Account ${await counterpart()}` };
    case 'CASHBACK':
      return { kind: 'cashback', title: 'Cashback', message: `🎉 Earned ${amount} Cashback!` };
    case 'DEPOSIT':
      return { kind: 'money-in', title: 'Money added', message: `${amount} added to your wallet` };
    case 'LOAN_DISBURSEMENT':
      return { kind: 'money-in', title: 'Instant Loan', message: `${amount} loan credited to your Available Balance` };
    case 'BILL_PAYMENT':
      return { kind: 'money-out', title: 'Bill paid', message: `${tx.description}: ${amount}` };
    case 'LOAD_PURCHASE':
      return { kind: 'money-out', title: 'Load sent', message: `${tx.description}: ${amount}` };
    case 'CARD_PAYMENT':
      return { kind: 'money-out', title: 'Card payment', message: `${tx.description}: ${amount}` };
    case 'BANK_TRANSFER':
      return { kind: 'money-out', title: 'Bank transfer', message: `${tx.description}: ${amount}` };
    default:
      return {
        kind: incoming ? 'money-in' : 'money-out',
        title: tx.description || tx.type,
        message: `${incoming ? '+' : '−'}${amount} · ${tx.description || tx.type}`,
      };
  }
}

function attach(httpServer) {
  // Same origin as the web app, so no CORS settings are needed.
  const io = new Server(httpServer, { serveClient: true });

  io.use((socket, next) => {
    try {
      const payload = jwt.verify(String(socket.handshake.auth?.token ?? ''), config.jwtSecret);
      socket.data.userId = Number(payload.sub);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });
  io.on('connection', (socket) => socket.join(room(socket.data.userId)));

  async function handle(raw) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    // Only customer wallets (not system accounts or savings vaults) get notifications.
    const { rows: [owner] } = await pool.query('SELECT user_id FROM accounts WHERE id = $1', [entry.accountId]);
    const userId = owner?.user_id;
    if (!userId || !io.sockets.adapter.rooms.has(room(userId))) return; // nobody online: skip the work

    const { rows: [tx] } = await pool.query('SELECT type, description FROM transactions WHERE id = $1', [entry.transactionId]);
    if (!tx || tx.type === 'QA_ADJUSTMENT' || tx.type === 'SAVINGS_TRANSFER') return; // own sandbox / savings moves
    const [text, balance, notifications] = await Promise.all([
      describe(entry, tx),
      pool.query('SELECT balance_cents FROM account_balances WHERE account_id = $1', [entry.accountId]),
      notificationService.list(userId),
    ]);
    io.to(room(userId)).emit('transaction', {
      transactionId: entry.transactionId,
      type: tx.type,
      direction: entry.direction,
      amount: fromCents(Number(entry.amountCents)),
      ...text,
      balance: fromCents(Number(balance.rows[0]?.balance_cents ?? 0)),
      unreadCount: notifications.unreadCount,
    });
  }

  // A dedicated connection for LISTEN (pooled connections are shared and come and go).
  let listener = null;
  let stopped = false;
  async function listen() {
    if (stopped) return;
    const client = new Client({ connectionString: config.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL) handle(msg.payload).catch((err) => console.error('realtime:', err.message));
    });
    client.on('error', () => {}); // handled by 'end' below
    client.on('end', () => {
      listener = null;
      if (!stopped) setTimeout(listen, RECONNECT_MS);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
    } catch (err) {
      console.error('realtime: could not LISTEN, retrying:', err.message);
      client.end().catch(() => {});
    }
  }
  listen();

  return {
    io,
    close() {
      stopped = true;
      io.close();
      if (listener) listener.end().catch(() => {});
    },
  };
}

module.exports = { attach, describe };
