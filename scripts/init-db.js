// Creates the PayPulse tables. Safe to run more than once.
// Usage: npm run db:init
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema is ready.');
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to initialise database:', err.message);
  process.exit(1);
});
