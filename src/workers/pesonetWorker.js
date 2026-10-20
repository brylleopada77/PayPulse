// PESONet batch worker: at every mock cut-off (every PESONET_CUTOFF_MINUTES, on the clock) it
// settles the PESONet transfers queued before that cut-off. Safe to run in several processes at
// once: runCutoff() takes a PostgreSQL advisory lock and skips rows another worker has locked.
const pesonetService = require('../services/pesonetService');

const CHECK_EVERY_MS = 10_000;

function log(message) {
  console.log(`[pesonet-worker ${new Date().toISOString()}] ${message}`);
}

/** Settle everything queued before the most recent cut-off. Returns the batch or null. */
async function tick() {
  const cutoffAt = pesonetService.lastCutoff();
  const batch = await pesonetService.runCutoff({ cutoffAt });
  if (batch) {
    log(`batch ${batch.batchId}: ${batch.itemCount} transfer(s), PHP ${batch.total} settled (cut-off ${cutoffAt.toISOString()})`);
  }
  return batch;
}

/** Start checking for cut-offs in the background. Returns a stop() function. */
function start() {
  log(`started; next cut-off ${pesonetService.nextCutoff().toISOString()}`);
  const timer = setInterval(() => {
    tick().catch((err) => log(`cut-off failed: ${err.message}`));
  }, CHECK_EVERY_MS);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}

module.exports = { start, tick };
