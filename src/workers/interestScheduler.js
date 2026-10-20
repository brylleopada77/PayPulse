// In-process scheduler for the daily interest job: shortly after midnight (Manila) it accrues
// yesterday's interest, once. Several servers can run it: each vault/day is accrued only once.
const interestService = require('../services/interestService');

const CHECK_EVERY_MS = 15 * 60_000;

function log(message) {
  console.log(`[interest-scheduler ${new Date().toISOString()}] ${message}`);
}

async function tick() {
  const yesterday = interestService.previousDate(interestService.manilaDate());
  if (await interestService.hasRun(yesterday)) return null;
  const summary = await interestService.runDailyJob(yesterday);
  log(`${yesterday}: ${summary.vaultsAccrued} vault(s), PHP ${(summary.postedCents / 100).toFixed(2)} posted`);
  return summary;
}

function start() {
  log('started (runs the daily interest job for yesterday when it has not run yet)');
  const run = () => tick().catch((err) => log(`failed: ${err.message}`));
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, tick };
