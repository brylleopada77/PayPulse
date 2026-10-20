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
  // Dev/QA/demo only: the mock payment provider behind "Add money" (POST /api/payments/mock-checkout).
  // Off by default: in production money only comes in through the signed payment webhook.
  mockPayments: process.env.MOCK_PAYMENTS === 'true',
  // Emails that are always ADMIN (comma-separated): promoted at start-up and at sign-up.
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  // Mock PESONet batch cut-offs: every N minutes (real PESONet has a few cut-offs per banking day).
  pesonetCutoffMinutes: Number(process.env.PESONET_CUTOFF_MINUTES) || 2,
  // The in-process PESONet batch worker; set PESONET_WORKER=false to run it separately
  // (node scripts/pesonet-worker.js) or not at all.
  pesonetWorker: process.env.PESONET_WORKER !== 'false',
  // The in-process daily savings interest job (or schedule jobs/daily-interest.js with cron instead).
  interestJob: process.env.INTEREST_JOB !== 'false',
};
