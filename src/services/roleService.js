// Roles: CUSTOMER (default) and ADMIN (operator: "Add money", QA sandbox, chaos tools).
const config = require('../config');
const { pool } = require('../db/pool');
const { badRequest, notFound } = require('../utils/errors');

const ROLES = ['CUSTOMER', 'ADMIN'];

/** Role for a new sign-up: ADMIN when the email is listed in ADMIN_EMAILS. */
function roleForNewUser(email) {
  return config.adminEmails.includes(String(email).trim().toLowerCase()) ? 'ADMIN' : 'CUSTOMER';
}

/** Make every existing account listed in ADMIN_EMAILS an ADMIN (run at start-up). */
async function promoteConfiguredAdmins() {
  if (config.adminEmails.length === 0) return [];
  const { rows } = await pool.query(
    `UPDATE users SET role = 'ADMIN' WHERE lower(email) = ANY($1) AND role <> 'ADMIN' RETURNING email`,
    [config.adminEmails],
  );
  return rows.map((r) => r.email);
}

async function setRole(email, role) {
  if (!ROLES.includes(role)) throw badRequest('INVALID_ROLE', `role must be one of ${ROLES.join(', ')}`);
  const { rows } = await pool.query('UPDATE users SET role = $2 WHERE lower(email) = lower($1) RETURNING email, role', [
    email,
    role,
  ]);
  if (!rows[0]) throw notFound('USER_NOT_FOUND', `No user with email ${email}`);
  return rows[0];
}

module.exports = { roleForNewUser, promoteConfiguredAdmins, setRole, ROLES };
