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
};
