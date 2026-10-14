const { Pool, types } = require('pg');
const config = require('../config');

// Postgres BIGINT (type id 20) comes back as a string by default.
// Our amounts are cents and stay far below Number.MAX_SAFE_INTEGER, so parse them.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));

const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Run `work(client)` inside a database transaction.
 * Commits if it resolves, rolls back if it throws.
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
