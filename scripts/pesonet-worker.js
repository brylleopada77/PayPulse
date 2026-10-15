#!/usr/bin/env node
// Standalone PESONet batch worker (for running it as its own process, e.g. with PESONET_WORKER=false
// on the API servers).
//   node scripts/pesonet-worker.js          keep running, settle at every cut-off
//   node scripts/pesonet-worker.js --once   run one cut-off now (items queued before the last cut-off)
require('dotenv').config({ quiet: true });
const { pool } = require('../src/db/pool');
const worker = require('../src/workers/pesonetWorker');

if (process.argv.includes('--once')) {
  worker
    .tick()
    .then((batch) => console.log(batch ? JSON.stringify(batch, null, 2) : 'Nothing queued before the last cut-off.'))
    .catch((err) => {
      console.error('PESONet cut-off failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
} else {
  const stop = worker.start();
  setInterval(() => {}, 1 << 30); // keep the process alive (the worker timer is unref'd)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stop();
      pool.end().then(() => process.exit(0));
    });
  }
}
