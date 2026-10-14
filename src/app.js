const express = require('express');
const { pool } = require('./db/pool');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const transferRoutes = require('./routes/transfers');
const webhookRoutes = require('./routes/webhooks');

const app = express();

app.use(
  express.json({
    limit: '100kb',
    // Keep the exact bytes so webhook signatures can be verified.
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'error', database: 'down' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/webhooks', webhookRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
