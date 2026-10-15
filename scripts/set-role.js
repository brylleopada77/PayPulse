#!/usr/bin/env node
// Give an account a role.
//   npm run admin:set -- you@example.com ADMIN
//   npm run admin:set -- someone@example.com CUSTOMER
require('dotenv').config({ quiet: true });
const { pool } = require('../src/db/pool');
const roleService = require('../src/services/roleService');

const [email, role = 'ADMIN'] = process.argv.slice(2);

(async () => {
  if (!email) throw new Error('Usage: npm run admin:set -- <email> [ADMIN|CUSTOMER]');
  const user = await roleService.setRole(email, role.toUpperCase());
  console.log(`${user.email} is now ${user.role}`);
})()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
