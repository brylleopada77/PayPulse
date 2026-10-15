require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  webhookSecret: required('WEBHOOK_SECRET'),
  // Dev/QA only: enables /api/qa (latency, forced 500, freeze, reset) and the QA panel in the UI.
  // Never set this in production.
  qaSandbox: process.env.QA_SANDBOX === 'true',
  // Mock PESONet batch cut-offs: every N minutes (real PESONet has a few cut-offs per banking day).
  pesonetCutoffMinutes: Number(process.env.PESONET_CUTOFF_MINUTES) || 2,
  // The in-process PESONet batch worker; set PESONET_WORKER=false to run it separately
  // (node scripts/pesonet-worker.js) or not at all.
  pesonetWorker: process.env.PESONET_WORKER !== 'false',
};
