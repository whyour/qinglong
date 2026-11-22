// Stable supervisor entry point. Receipt storage is a separate, service-free module.
const fs = require('node:fs');
const path = require('node:path');
const {
  parseExit,
  writeExit,
  receiptPath,
  storageFull,
} = require('../cron/settlement/exitReceipt.cjs');
const idPattern = /^[a-z0-9-]{1,120}$/;

if (require.main === module) {
  const id = process.env.QL_TRIGGER_ID;
  const exit = parseExit(id, JSON.parse(process.argv[2]));
  if (!idPattern.test(id || '') || !exit)
    throw new Error('Invalid supervisor exit receipt');
  const { code, signal, time } = exit;
  // An older supervisor may only have delivered this tuple in its message.
  // Journal it before waiting for the SQLite writer or loading the panel.
  let journaled = false;
  if (exit.version === 1) {
    try {
      writeExit(id, code, signal, time);
      journaled = Boolean(receiptPath(id));
    } catch (error) {
      console.error('[scheduler] Could not journal supervisor message:', error);
    }
  }
  // Development workers run TypeScript directly. Released panels load the
  // compiled module without starting another runtime on ordinary exits.
  if (!fs.existsSync(path.join(__dirname, '../cron/history.js'))) {
    process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
    require('ts-node/register/transpile-only');
  }
  const { triggerHistory } = require('../cron/history');
  triggerHistory()
    .complete(
      id,
      signal || code !== 0 ? 'failed' : 'finished',
      signal,
      code,
      time,
      exit.version === 1 ? exit : 'legacy',
    )
    .catch((error) => {
      if (journaled && storageFull(error)) return;
      console.error('[scheduler] Failed to settle orphaned command:', error);
      process.exitCode = storageFull(error) ? 75 : 1;
    })
    .finally(() => require('../data').sequelize.close());
}
