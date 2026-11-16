// Run real panel operations in a separate process. The parent replaces public
// files and runs two independent publishers while this worker is at the barrier.
const fs = require('node:fs');
const path = require('node:path');
const [operation, stage, side, id] = process.argv.slice(2);
const root = process.env.QL_DATA_DIR;
const load = require('./load-security-module.cjs');
const db = load('back/data/index.ts', { '../config/index': { dbPath: root } }).sequelize;
const { TriggerHistory } = require('../../back/shared/triggerHistory');
const history = new TriggerHistory(db);
const stats = load('back/data/cronStats.ts', { '.': { sequelize: db } });
const running = load('back/data/runningInstance.ts', { '.': { sequelize: db } });
const Retention = load('back/services/retention.ts', {
  '../data': { sequelize: db }, '../data/cronStats': stats, '../data/runningInstance': running,
  '../data/system': {}, '../config': {},
}).default;

function barrier() {
  const ready = path.join(root, 'at-barrier');
  fs.writeFileSync(ready + '.tmp', stage + '/' + side);
  fs.renameSync(ready + '.tmp', ready);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const statements = {
  booking: 'INSERT OR IGNORE INTO CronLegacyExitBookings',
  claim: 'UPDATE CronTriggers SET counted=1',
  increment: 'INSERT INTO "CrontabStats"',
  dispute: 'INSERT OR IGNORE INTO CronBoundExitConflicts',
  debit: 'UPDATE CrontabStats SET run_count=run_count-1',
  commit: 'COMMIT',
  deleteDay: 'DELETE FROM CrontabStats WHERE date',
  cutoff: 'INSERT INTO CronStatRetention',
  historyCutoff: 'INSERT INTO CronHistoryRetention',
  deleteHistory: 'DELETE FROM CronTriggers WHERE',
  pruneBooking: 'DELETE FROM CronLegacyExitBookings WHERE day',
};
function intercept(object, method, matches) {
  const original = object[method].bind(object);
  object[method] = async (...args) => {
    const matched = matches(...args);
    if (matched && side === 'before') barrier();
    const result = await original(...args);
    if (matched && side === 'after') barrier();
    return result;
  };
}
const captured = file => path.basename(file).startsWith('.pending.' + id + '.r-');
if (stage === 'readClaim') {
  const open = fs.promises.open.bind(fs.promises);
  fs.promises.open = async (file, ...options) => {
    const handle = await open(file, ...options);
    if (captured(file)) {
      if (side === 'before') barrier();
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (side === 'after') barrier(); };
    }
    return handle;
  };
} else if (stage === 'move') intercept(fs.promises, 'rename', (src) => path.basename(src) === id);
else if (stage === 'unlink') intercept(fs.promises, 'unlink', captured);
else intercept(db, 'query', sql => String(sql).replace(/[`"]/g, '').startsWith(statements[stage].replace(/"/g, '')));

(async () => {
  if (operation === 'prune') await new Retention().cleanup({ runningInstanceRetentionDays: 1, cronStatRetentionDays: 1 });
  else await history.complete(id, 'unknown', null, null);
  throw Error('Expected barrier was never reached: ' + operation + '/' + stage);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
