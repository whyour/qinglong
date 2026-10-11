const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');
const tick = () => new Promise(setImmediate);
function gate() { let release; const promise = new Promise(r => release = r); return { promise, release }; }

async function fixture() {
  const logger = { info() {}, error() {}, warn() {} }, notices = [];
  const limit = load('back/shared/pLimit.ts', {
    '../data/system': { AuthDataType: { systemConfig: 'systemConfig' }, SystemModel: { sync: async () => {}, findOne: async () => ({ info: { cronConcurrency: 1 } }) } },
    '../loaders/logger': logger,
    '../services/notify': class {},
    '../shared/i18n': { t: s => s, tf: s => s },
    '../config': { grpcPort: 1 },
    '../protos/api': { ApiClient: class { systemNotify(value, cb) { notices.push(value); cb(); } } },
    '../config/grpcCerts': { getGrpcCerts: () => null },
  }).default;
  await tick();
  const spawned = [], records = new Map(), jobs = new Map();
  let readGate, killGate;
  const { runCron } = load('back/shared/runCron.ts', {
    'cross-spawn': { spawn: command => { spawned.push(command); return {}; } },
    './pLimit': limit,
    '../loaders/logger': logger,
    '../data/cron': { CrontabModel: { findOne: async ({ where }) => { const row = records.get(String(where.id)); if (readGate) await readGate.promise; return row; }, update: async () => {} }, CrontabStatus: { running: 0, queued: 3, idle: 1 } },
    '../data/runningInstance': { RunningInstanceModel: { update: async () => {} }, InstanceStatus: { running: 0, stopped: 2 } },
    '../config/util': { killTask: async () => { if (killGate) await killGate.promise; } },
    './childProcess': { observeChildProcess: () => ({ completed: Promise.resolve({ code: 0 }) }), asError: e => e },
  });
  const { addCron } = load('back/schedule/addCron.ts', {
    '../shared/cronScheduler': { createCronJob: (schedule, callback) => ({ start() {}, cancel() {}, fire: callback }) },
    '../shared/cronSchedule': { isValidCronSchedule: x => x !== 'invalid' },
    './data': { scheduleStacks: jobs }, '../shared/runCron': { runCron }, '../loaders/logger': logger,
    '../shared/i18n': { tf: s => s },
  });
  const { delCron } = load('back/schedule/delCron.ts', { './data': { scheduleStacks: jobs }, '../loaders/logger': logger });
  function add(id = '1', command = 'old', replace = false) {
    records.set(id, { isDisabled: 0, allow_multiple_instances: 1 });
    addCron({ request: { crons: [{ id, command, schedule: '* * * * * *' }], replace } }, err => assert.ifError(err));
    return jobs.get(id)[0];
  }
  function remove(id = '1') { delCron({ request: { ids: [id] } }, err => assert.ifError(err)); }
  async function block() { const g = gate(); const done = limit.runWithCronLimit({ id: 'blocker' }, async () => { await g.promise; }); await tick(); return { release: async () => { g.release(); await done; } }; }
  return { limit, spawned, records, jobs, add, remove, block, notices, setReadGate: g => readGate = g, setKillGate: g => killGate = g };
}

for (const operation of ['disable', 'delete', 'update', 'replace', 'disable-enable']) {
  test(`queued scheduled execution is invalidated by ${operation}`, async () => {
    const f = await fixture(), old = f.add(), blocker = await f.block();
    const queued = old.fire();
    if (operation === 'disable' || operation === 'disable-enable') { f.records.get('1').isDisabled = 1; f.remove(); }
    if (operation === 'delete') { f.records.delete('1'); f.remove(); }
    if (operation === 'update') f.add('1', 'new');
    if (operation === 'replace') f.add('1', 'new', true);
    if (operation === 'disable-enable') f.add('1', 'old');
    const next = f.jobs.get('1')?.[0].fire();
    await blocker.release(); await queued; await next;
    assert.deepEqual(f.spawned, ['update', 'replace'].includes(operation) ? ['new'] : operation === 'disable-enable' ? ['old'] : []);
    assert.equal(f.limit.cronLimitPendingCount, 0);
    assert.equal(f.limit.cronLimitActiveCount, 0);
  });
}

test('stale callbacks cannot re-enqueue after cancellation', async () => {
  const f = await fixture(), old = f.add(); f.remove(); await old.fire();
  assert.deepEqual(f.spawned, []);
});

test('invalidation during an asynchronous database read prevents spawning', async () => {
  const f = await fixture(), old = f.add(), pending = gate(); f.setReadGate(pending);
  const run = old.fire(); await tick(); f.remove(); pending.release(); await run;
  assert.deepEqual(f.spawned, []);
});

test('invalidation while replacing a running instance prevents the old spawn', async () => {
  const f = await fixture(), old = f.add(), pending = gate();
  f.records.set('1', { isDisabled: 0, allow_multiple_instances: 0, pid: 10, status: 0 }); f.setKillGate(pending);
  const run = old.fire(); await tick(); f.remove(); pending.release(); await run;
  assert.deepEqual(f.spawned, []);
});

test('database removal or disable is respected before scheduler RPC arrives', async () => {
  for (const disabled of [true, false]) {
    const f = await fixture(), old = f.add(), blocker = await f.block(); const run = old.fire();
    if (disabled) f.records.get('1').isDisabled = 1; else f.records.delete('1');
    await blocker.release(); await run; assert.deepEqual(f.spawned, []);
  }
});

test('five stale runs do not suppress the new revision or erase its repeat accounting', async () => {
  const f = await fixture(), old = f.add(), blocker = await f.block();
  const pending = Array.from({ length: 5 }, () => old.fire());
  const current = f.add('1', 'new'); pending.push(...Array.from({ length: 5 }, () => current.fire()));
  assert.equal(f.notices.length, 0);
  await blocker.release(); await Promise.all(pending);
  assert.deepEqual(f.spawned, Array(5).fill('new'));
  await current.fire(); assert.equal(f.spawned.length, 6);
});
