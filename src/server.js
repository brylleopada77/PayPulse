const config = require('./config');
const app = require('./app');
const { pool } = require('./db/pool');
const pesonetWorker = require('./workers/pesonetWorker');
const interestScheduler = require('./workers/interestScheduler');
const roleService = require('./services/roleService');
const realtime = require('./realtime');

const server = app.listen(config.port, () => {
  console.log(`PayPulse API listening on http://localhost:${config.port}`);
});

// Real-time notifications (Socket.IO on the same port, fed by PostgreSQL LISTEN/NOTIFY).
const live = realtime.attach(server);

// Accounts listed in ADMIN_EMAILS get the ADMIN role.
roleService
  .promoteConfiguredAdmins()
  .then((emails) => emails.length && console.log(`Admin role granted to: ${emails.join(', ')}`))
  .catch((err) => console.error('Could not apply ADMIN_EMAILS:', err.message));

// Settles queued PESONet transfers at each mock cut-off (PESONET_WORKER=false to run it elsewhere).
const stopWorker = config.pesonetWorker ? pesonetWorker.start() : () => {};
// Accrues yesterday's savings interest once, shortly after midnight (INTEREST_JOB=false to disable).
const stopInterest = config.interestJob ? interestScheduler.start() : () => {};

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  stopWorker();
  stopInterest();
  live.close();
  server.close(() => pool.end().then(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
