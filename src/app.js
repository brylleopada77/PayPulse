const path = require('path');
const express = require('express');
const config = require('./config');
const { pool } = require('./db/pool');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const transferRoutes = require('./routes/transfers');
const webhookRoutes = require('./routes/webhooks');
const paymentRoutes = require('./routes/payments');
const qrRoutes = require('./routes/qr');
const qaRoutes = require('./routes/qa');

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

// Web UI (plain HTML/CSS/JS, no build step)
app.use(express.static(path.join(__dirname, '..', 'public')));
// QR image reader for "Scan QR" (served from node_modules, no CDN needed)
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

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
app.use('/api/payments', paymentRoutes);
app.use('/api/qr', qrRoutes);
// QA Sandbox: dev/CI only. Without QA_SANDBOX=true these routes don't exist (404).
if (config.qaSandbox) {
  app.use('/api/qa', qaRoutes);
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
