const config = require('./config');
const app = require('./app');
const { pool } = require('./db/pool');

const server = app.listen(config.port, () => {
  console.log(`PayPulse API listening on http://localhost:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => pool.end().then(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
