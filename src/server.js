const config = require('./config');
const app = require('./app');
const { pool } = require('./db/pool');
const pesonetWorker = require('./workers/pesonetWorker');

const server = app.listen(config.port, () => {
  console.log(`PayPulse API listening on http://localhost:${config.port}`);
});

// Settles queued PESONet transfers at each mock cut-off (PESONET_WORKER=false to run it elsewhere).
const stopWorker = config.pesonetWorker ? pesonetWorker.start() : () => {};

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  stopWorker();
  server.close(() => pool.end().then(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
