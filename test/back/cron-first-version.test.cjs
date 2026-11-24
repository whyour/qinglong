const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Sequelize, QueryTypes, Transaction } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const {
  TriggerHistory,
  installTriggerHistory,
  slotId,
  systemOwner,
} = require('../../back/cron/history');
const { upcomingSlots } = require('../../back/cron/scheduling/cronScheduler');
const { withNextRun } = require('../../back/cron/queries/cronPreview');
const { latestMissedSlot } = require('../../back/cron/scheduling/cronRecovery');
const { getTasks } = require('node-cron');
const logger = { info() {}, error() {}, warn() {} };

async function fixture(t, usePanelDatabase = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-triggers-'));
  const db = usePanelDatabase
    ? load('back/data/index.ts', { '../config/index': { dbPath: root } })
        .sequelize
    : new Sequelize({
        dialect: 'sqlite',
        storage: path.join(root, 'panel.sqlite'),
        logging: false,
        transactionType: Transaction.TYPES.IMMEDIATE,
      });
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const models = load('back/data/cron.ts', { '.': { sequelize: db } });
  load('back/data/runningInstance.ts', { '.': { sequelize: db } });
  load('back/data/system.ts', { '.': { sequelize: db } });
  const stats = load('back/data/cronStats.ts', { '.': { sequelize: db } });
  await db.sync();
  await db.transaction(async (transaction) => {
    await installTriggerHistory(db, transaction);
    await db.query(
      'CREATE TABLE SchemaMigrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
      { transaction },
    );
    await db.query(
      'INSERT INTO SchemaMigrations VALUES ($id,CURRENT_TIMESTAMP)',
      {
        bind: {
          id: require('../../back/data/schemaMigrations').prunedExitMigrationId,
        },
        transaction,
      },
    );
  });
  return { root, db, models, stats, history: new TriggerHistory(db) };
}

test('failed system install is reported for create, update and disable; retry replaces the installed snapshot', async (t) => {
  const { models } = await fixture(t);
  let file = '',
    installed = '',
    failures = 0,
    fail = true;
  const registrations = [];
  const client = {
    readiness: {
      invalidate() {
        failures++;
      },
    },
    addCron: async (crons) => {
      registrations.push(crons.map((c) => c.id));
    },
    delCron: async () => {},
  };
  const Service = load('back/services/cron.ts', {
    child_process: {
      execFileSync(command) {
        assert.equal(command, 'crontab');
        if (fail) throw Error('install failed');
        installed = file;
      },
    },
    '../data/cron': models,
    '../config': { crontabFile: '/test/crontab' },
    '../config/util': { isDemoEnv: () => false },
    '../cron/scheduling/schedulerMutationLock': {
      withSchedulerMutation: (fn) => fn(),
    },
    '../shared/utils': {
      writeFileWithLock: async (_, value) => {
        file = value;
      },
    },
    '../cron/execution/cronLimit': {},
    '../schedule/client': client,
    '../data/runningInstance': {},
    '../shared/logStreamManager': {},
    '../shared/i18n': { t: (key) => key },
  }).default;
  const svc = new Service(logger);
  Object.defineProperty(svc, 'schedulerMode', { value: 'system' });
  svc.getLogName = async () => 'test';
  svc.crontabs = async () => ({
    data: await models.CrontabModel.findAll({ raw: true }),
  });
  const read = () => models.CrontabModel.findOne();
  const rejected = (promise) =>
    assert.rejects(promise, (err) => err.status === 503);
  let pendingId;
  await assert.rejects(
    svc.create({
      name: 'backup',
      command: 'task backup.sh',
      schedule: '0 8 * * *',
    }),
    (err) => {
      pendingId = err.cronId;
      return err.status === 503 && Number.isInteger(pendingId);
    },
  );
  const { id, saved } = await read();
  assert.equal(pendingId, id);
  assert.equal(saved, false);
  assert.equal(installed, '');
  fail = false;
  await svc.autosave_crontab(true);
  assert.match(installed, /^0 8 /);
  fail = true;
  await rejected(svc.update({ id, schedule: '0 9 * * *' }));
  assert.equal((await read()).saved, false);
  assert.match(installed, /^0 8 /);
  fail = false;
  await svc.autosave_crontab(true);
  assert.match(installed, /^0 9 /);
  fail = true;
  await rejected(svc.disabled([id]));
  assert.equal((await read()).saved, false);
  assert.match(installed, /^0 9 /);
  fail = false;
  await svc.autosave_crontab(true);
  assert.match(installed, /^# /);
  assert.equal((await read()).saved, true);
  assert.equal(failures, 3);
  await svc.enabled([id]);
  assert.match(installed, /^0 9 /);
  fail = true;
  const before = registrations.length;
  await rejected(svc.update({ id, max_queue_wait: 15 }));
  assert.equal(
    registrations.length,
    before,
    'Node cannot start until crond relinquishes the task',
  );
  assert.match(installed, /^0 9 /);
  fail = false;
  await svc.create({ command: 'task other.sh', schedule: '0 7 * * *' });
  assert.equal(
    (await models.CrontabModel.findByPk(id)).saved,
    false,
    'another save cannot acknowledge this Node registration',
  );
  await svc.autosave_crontab(true);
  assert.deepEqual(registrations.at(-1), [String(id)]);
  const portable = await models.CrontabModel.findOne({
    where: { schedule: '0 7 * * *' },
  });
  assert.equal(portable.saved, true);
  fail = true;
  await rejected(svc.autosave_crontab(true));
  assert.equal(
    (await portable.reload()).saved,
    false,
    'a failed install on a new host invalidates old confirmations',
  );
  fail = false;
  await svc.autosave_crontab(true);
  assert.equal((await portable.reload()).saved, true);
  assert.match(installed, /^# 0 9 /);
  assert.equal((await models.CrontabModel.findByPk(id)).saved, true);
});

test('service previews use the registered calendar including midnight, extra rules and ineligible tasks', () => {
  const now = new Date(2026, 1, 27, 23, 59, 59).getTime();
  const before = getTasks().size;
  assert.equal(upcomingSlots('@midnight', now)[0], +new Date(2026, 1, 28));
  const cases = require('../fixtures/cron-calendar-boundaries.json').cases;
  for (const tz of ['UTC', 'Asia/Shanghai']) {
    // node-cron caches local timezone formatters for the lifetime of its worker.
    const script =
      "\n      const {upcomingSlots} = require('./back/cron/scheduling/cronScheduler');\n      for (const {schedule,currentDate,next} of JSON.parse(process.argv[1])) {\n        require('node:assert/strict').deepEqual(upcomingSlots(schedule, Date.parse(currentDate), next[process.env.TZ].length),\n          next[process.env.TZ].map(Date.parse), schedule);\n      }";
    require('node:child_process').execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        script,
        JSON.stringify(cases),
      ],
      { env: { ...process.env, TZ: tz } },
    );
  }
  const next = withNextRun({
    schedule: '@monthly',
    extra_schedules: [{ schedule: '@minutely' }],
  }).nextRunTime;
  assert.ok(next > Date.now() - 1000 && next <= Date.now() + 60000);
  for (const item of [
    { schedule: '@boot' },
    { schedule: '@once' },
    { schedule: '@midnight', saved: false },
    { schedule: '@midnight', isDisabled: 1 },
  ])
    assert.equal(withNextRun(item).nextRunTime, null);
  assert.equal(getTasks().size, before);
});

test('anonymous statistics replay before, during and after identified exits cannot count or settle another run', async (t) => {
  const { db, stats, history } = await fixture(t);
  const router = express.Router();
  load('back/api/dashboard.ts', {
    '../data/cronStats': stats,
    '../data/cron': {},
    '../data/runningInstance': {},
    '../shared/i18n': {},
  }).default(router);
  const handle = router.stack[0].handle.stack.find(
    (x) => x.route?.path === '/record',
  ).route.stack[0].handle;
  const post = async (id) => {
    let reply;
    await handle(
      {
        get: () => undefined,
        body: { ref_id: 1, code: 0, elapsed: 2, ...(id && { trigger_id: id }) },
      },
      {
        send(value) {
          reply = value;
        },
      },
    );
    assert.equal(reply.code, 200);
    return reply;
  };
  const replay = () => Promise.all(Array.from({ length: 6 }, () => post()));
  await replay();
  const totals = () =>
    db.query(
      'SELECT run_count,success_count,fail_count,total_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
  assert.deepEqual(await totals(), []);
  await history.shellReport('system-old', 1, true, true, 'old.log', 100);
  await history.enqueue('next', 1, 'manual', null);
  await history.start('next', Date.now(), true);
  // Lose the first HTTP response after the server handles it, then retry the same body.
  await post();
  await Promise.all([replay(), post('system-old'), post('system-old')]);
  assert.deepEqual(await totals(), [
    { run_count: 1, success_count: 1, fail_count: 0, total_time: 2000 },
  ]);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.id, r.state]),
    [
      ['next', 'running'],
      ['system-old', 'finished'],
    ],
  );
  await Promise.all([replay(), history.complete('next', 'failed', null, 17)]);
  await replay();
  const [row] = await totals();
  assert.deepEqual(
    [row.run_count, row.success_count, row.fail_count],
    [2, 1, 1],
  );
});

test('a restart distinguishes queued work from uncertain side effects and reclaims only the latest eligible slot', async (t) => {
  const { history } = await fixture(t);
  const id = slotId('1', 0, '@minutely', 60000);
  const owner = process.env.SERVICE_TYPE || 'http';
  assert.equal(await history.enqueue(id, 1, 'node', 60000, 60500), true);
  await history.interrupt(owner);
  assert.equal((await history.recent(1, 0))[0].state, 'skipped');
  assert.equal(await history.enqueue(id, 1, 'recovery', 60000, 62000), true);
  assert.equal(await history.start(id, 63500), true);
  await history.interrupt(owner);
  assert.equal(await history.enqueue(id, 1, 'recovery', 60000), false);
  const [row] = await history.recent(1, 0);
  assert.equal(row.state, 'unknown');
  assert.equal(row.exit_code, null);
  const metrics = await history.metrics(0);
  assert.equal(metrics.waitP95, 1500);
  assert.equal(latestMissedSlot('@minutely', 60000, 179999), 120000);
  assert.equal(latestMissedSlot('@minutely', 120000, 179999), null);
});

test('a wake burst settles every rejected slot without opening receipt transactions or losing a duplicate', async (t) => {
  const { db, models, history, root } = await fixture(t, true);
  const marker = path.join(root, 'launches');
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    allow_multiple_instances: 1,
  });
  const limit = load('back/cron/execution/cronLimit.ts', {
    '../../data/system': {
      SystemModel: { sync: async () => {}, findOne: async () => null },
      AuthDataType: {},
    },
    '../../loaders/logger': logger,
    '../../services/notify': class {},
    '../../config': {},
    '../../config/grpcCerts': {},
    '../../protos/api': {},
    // Isolate rejection bookkeeping from durable budget admission transactions.
    './globalCronBudget': {
      globalCronBudget: () => ({ run: (_id, fn) => fn() }),
    },
  }).default;
  limit.cronLimit.pause();
  limit._client = { systemNotify() {} };
  t.after(() => limit.cronLimit.start());
  const { runCron } = load('back/cron/execution/runCron.ts', {
    './cronLimit': limit,
    '../../data/cron': models,
    '../../loaders/logger': logger,
    '../history': { triggerHistory: () => history },
  });
  const rows = () =>
    db.query('SELECT * FROM CronTriggers', { type: QueryTypes.SELECT });
  const transaction = t.mock.method(db, 'transaction');
  const now = Date.now(),
    total = 120;
  const fire = (i) =>
    runCron('echo ran >> ' + marker, { id: '1' }, () => true, {
      id: 'wake-' + i,
      time: now - (total - i) * 60000,
      source: 'node',
    });
  const burst = Array.from({ length: total }, (_, i) => fire(i));
  const duplicates = Array.from({ length: total }, (_, i) => fire(i));
  try {
    // The five admitted commands stay paused. Every other callback must finish.
    await Promise.all([...burst.slice(5), ...duplicates]);
    const before = await rows();
    assert.equal(before.length, total);
    assert.equal(before.filter((r) => r.state === 'queued').length, 5);
    assert.equal(
      before.filter(
        (r) =>
          r.state === 'skipped' &&
          r.reason === 'capacity' &&
          r.started_at === null &&
          r.finished_at >= r.queued_at,
      ).length,
      total - 5,
    );
    assert.equal(transaction.mock.callCount(), 0);
  } finally {
    limit.cronLimit.start();
    await Promise.all(burst);
  }
  const final = await rows();
  assert.equal(
    final.filter((r) => r.state === 'finished' && r.exit_code === 0).length,
    5,
  );
  assert.equal(
    final.filter((r) => r.state === 'queued' || r.state === 'running').length,
    0,
  );
  assert.equal(
    (await fs.readFile(marker, 'utf8')).trim().split('\n').length,
    5,
  );
  await history.skipQueued('wake-0', 'capacity', now);
  assert.equal((await rows()).find((r) => r.id === 'wake-0').state, 'finished');
});

test('real scheduled admission records overlap, backlog and expiry, without launching rejected scripts', async (t) => {
  const { history, models } = await fixture(t);
  const notices = [];
  const spawned = [];
  const limit = load('back/cron/execution/cronLimit.ts', {
    '../../data/system': {
      SystemModel: { sync: async () => {}, findOne: async () => null },
      AuthDataType: {},
    },
    '../../loaders/logger': logger,
    '../../services/notify': class {},
    '../../config': {},
    '../../config/grpcCerts': {},
    '../../protos/api': {},
  }).default;
  const queue = limit.cronLimit;
  queue.concurrency = 1;
  queue.pause();
  limit._client = { systemNotify: (msg) => notices.push(msg) };
  const { runCron } = load('back/cron/execution/runCron.ts', {
    './cronLimit': limit,
    '../../data/cron': models,
    '../../data/runningInstance': {},
    '../../loaders/logger': logger,
    '../history': { triggerHistory: () => history },
    './cronCommandProcess': {
      spawnCronCommand: (cmd, triggerId) => {
        spawned.push(triggerId);
        return {};
      },
    },
    '../../shared/childProcess': {
      observeChildProcess: () => ({ completed: Promise.resolve({ code: 0 }) }),
    },
  });
  await models.CrontabModel.create({
    id: 1,
    command: 'test',
    isDisabled: 0,
    allow_multiple_instances: 0,
    status: 0,
    pid: process.pid,
  });
  const rule = { id: '1', command: 'test', schedule: '* * * * * *' };
  const queued = Array.from({ length: 6 }, (_, i) =>
    runCron('test', rule, () => true, {
      time: i * 1000,
      id: 'slot-' + i,
      source: 'node',
    }),
  );
  async function until(test) {
    const deadline = Date.now() + 4000;
    while (!(await test())) {
      if (Date.now() > deadline) throw Error('Timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await until(() => notices.length === 1);
  queue.start();
  await Promise.all(queued);
  const rows = await history.recent(1, 0);
  assert.equal(rows.filter((x) => x.reason === 'overlap').length, 5);
  assert.equal(rows.filter((x) => x.reason === 'capacity').length, 1);
  assert.deepEqual(spawned, []);
  await models.CrontabModel.update(
    { status: 1, pid: null },
    { where: { id: 1 } },
  );
  queue.pause();
  const waiting = runCron('test', { ...rule, max_queue_wait: 1 }, () => true, {
    time: 7000,
    id: 'expired',
    source: 'node',
  });
  await until(async () =>
    (await history.recent(1, 0)).some((row) => row.reason === 'queue_timeout'),
  );
  await waiting;
  assert.equal(queue.size, 0);
  const fresh = runCron(
    'test',
    { ...rule, skip_if_pending: true, max_queue_wait: 2 },
    () => true,
    {
      time: 8000,
      id: 'ok',
      source: 'node',
    },
  );
  await until(() => queue.size === 1);
  queue.start();
  await fresh;
  assert.deepEqual(spawned, ['ok']);
  assert.equal(
    (await history.recent(1, 0)).find((row) => row.id === 'ok').state,
    'finished',
  );
  queue.pause();
  const coalesced = { ...rule, skip_if_pending: true };
  const first = runCron('test', coalesced, () => true, {
    time: 9000,
    id: 'first',
    source: 'node',
  });
  await until(() => queue.size === 1);
  await runCron('test', coalesced, () => true, {
    time: 10000,
    id: 'duplicate',
    source: 'node',
  });
  assert.equal(queue.size, 1);
  assert.equal(
    (await history.recent(1, 0)).find((x) => x.id === 'duplicate').reason,
    'pending',
  );
  await models.CrontabModel.create({ id: 2, command: 'test', isDisabled: 0 });
  const other = runCron('test', { ...rule, id: '2' }, () => true, {
    time: 10000,
    id: 'other',
    source: 'node',
  });
  await until(() => queue.size === 2);
  queue.start();
  await Promise.all([first, other]);
  assert.deepEqual(spawned, ['ok', 'first', 'other']);
});

test('restoring a protobuf snapshot launches one real process for the latest missed slot and never replays its effects', async (t) => {
  const { root, history, models } = await fixture(t);
  const now = Date.UTC(2026, 10, 12, 8, 5, 30);
  t.mock.method(Date, 'now', () => now);
  const at = now - 30000;
  const id = slotId('1', 0, '@minutely', at);
  await models.CrontabModel.create({ id: 1, command: 'test', isDisabled: 0 });
  await history.enqueue(id, 1, 'node', at);
  await history.interrupt(process.env.SERVICE_TYPE || 'http');
  const marker = path.join(root, 'observed');
  const { runCron } = load('back/cron/execution/runCron.ts', {
    './cronLimit': { runWithCronLimit: (_, fn) => fn(), removeQueuedCron() {} },
    '../history': { triggerHistory: () => history },
    '../../data/cron': models,
    '../../data/runningInstance': {},
    '../../loaders/logger': logger,
  });
  const seen = [];
  const stacks = new Map();
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../cron/execution/runCron': {
      runCron: (...args) => {
        seen.push(runCron(...args));
        return seen.at(-1);
      },
    },
    '../loaders/logger': logger,
    '../cron/scheduling/cronScheduler': {
      ...require('../../back/cron/scheduling/cronScheduler'),
      createCronJob: () => ({ start() {}, cancel() {} }),
    },
  });
  const { AddCronRequest } = require('../../back/protos/cron');
  const cmd = 'printf "%s\\n" "$QL_TRIGGER_ID" >> ' + JSON.stringify(marker);
  const request = AddCronRequest.decode(
    AddCronRequest.encode({
      replace: true,
      crons: [
        {
          id: '1',
          schedule: '@minutely',
          command: cmd,
          name: 'test',
          extra_schedules: [],
          catchup_seconds: 600,
          recovery_from: now - 500000,
        },
      ],
    }).finish(),
  );
  async function restore(expectedNew) {
    const index = seen.length;
    await new Promise((resolve, reject) =>
      addCron({ request }, (err) => (err ? reject(err) : resolve())),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, index + expectedNew);
    await Promise.all(seen.slice(index));
  }
  await restore(1);
  await restore(0);
  stacks.clear(); // a new scheduler process
  await restore(1);
  assert.equal(await fs.readFile(marker, 'utf8'), id + '\n');
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.id, row.source, row.state, row.exit_code],
    [id, 'recovery', 'finished', 0],
  );
});

test('system shell start, finish and statistics receipts share one id and report no fictitious queue wait', async (t) => {
  const { root, history } = await fixture(t);
  const trace = path.join(root, 'requests');
  require('node:child_process').execFileSync(
    '/bin/bash',
    [
      '-ec',
      [
        'source shell/api.sh',
        'ID=42; begin_timestamp=12345678; ql_port=5700; QL_TRIGGER_SOURCE=system; QL_TRIGGER_ID=system-42-019388ce-0c59-44e8-afa8-a16ce721c80d',
        'ql_api_request(){ printf "%s\\n" "${!#}" >> "$TRACE"; printf \'{"code":200}\'; }; ql_parse_status_response(){ code=200; }',
        'update_cron "$ID" 0 "$$" my.log "$begin_timestamp"',
        'update_cron "$ID" 1 "$$" my.log "$begin_timestamp" 3 9',
        'record_cron_stat "$ID" 9 3',
      ].join('\n'),
    ],
    { env: { ...process.env, TRACE: trace } },
  );
  const [start, end, stat] = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.match(start.trigger_id, /^system-42-[a-f0-9-]{36}$/);
  assert.equal(start.trigger_id, end.trigger_id);
  assert.equal(end.trigger_id, stat.trigger_id);
  await history.shellReport(
    start.trigger_id,
    42,
    true,
    true,
    start.log_path,
    start.last_execution_time,
  );
  await history.interrupt('http');
  await history.shellReport(
    end.trigger_id,
    42,
    true,
    false,
    end.log_path,
    end.last_execution_time,
    end.exit_code,
  );
  const [row] = await history.recent(42, 0);
  assert.deepEqual(
    [row.state, row.reason, row.exit_code, row.queued_at, row.scheduled_at],
    ['failed', null, 9, null, null],
  );
  assert.equal((await history.metrics(0)).waitP95, null);
});

test('retention preview and deletion agree, protecting recent, queued and running triggers', async (t) => {
  const { db, history } = await fixture(t);
  for (const id of ['old', 'recent', 'queued', 'running']) {
    await history.enqueue(id, 1, 'manual', null, 1000);
  }
  await history.start('running', 2000);
  await history.finish('old', 'skipped');
  await history.finish('recent', 'finished');
  await db.query("UPDATE CronTriggers SET finished_at=2000 WHERE id='old'");
  assert.equal(await history.countExpired(3000), 1);
  assert.equal(
    await db.transaction((tx) => history.deleteExpired(3000, tx)),
    1,
  );
  assert.deepEqual((await history.recent(1, 0)).map((x) => x.id).sort(), [
    'queued',
    'recent',
    'running',
  ]);
});

test('single-instance starts contend per task across connections and only the winner runs', async (t) => {
  const { db, history, root, models } = await fixture(t);
  const peer = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'panel.sqlite'),
    logging: false,
  });
  t.after(() => peer.close());
  const manual = new TriggerHistory(peer);
  await models.CrontabModel.create({ id: 1, command: 'true', isDisabled: 0 });
  await Promise.all([
    history.enqueue('main', 1, 'node', 10),
    manual.enqueue('extra', 1, 'node', 10),
    manual.enqueue('manual', 1, 'manual', null),
  ]);
  const ids = ['main', 'extra', 'manual'];
  const claims = await Promise.all([
    history.start(ids[0]),
    manual.start(ids[1]),
    manual.start(ids[2]),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = ids[claims.indexOf(true)];
  assert.equal(
    await history.startSystem('system-denied', 1, 'test-owner'),
    false,
  );
  assert.equal(
    (await history.recent(1, 0)).find((r) => r.id === 'system-denied').reason,
    'overlap',
  );
  await history.complete(winner, 'finished', null, 0);
  assert.equal(await history.startSystem('system-next', 1, 'test-owner'), true);
  const loser = ids[claims.indexOf(false)];
  assert.equal(await manual.start(loser), false);
  assert.equal(await manual.start(loser, Date.now(), true), true);
  assert.equal(
    (
      await db.query("SELECT id FROM CronTriggers WHERE state='running'", {
        type: QueryTypes.SELECT,
      })
    ).length,
    2,
  );
});

test('parent settlement and independently lost, late or duplicate shell receipts count each failure once', async (t) => {
  const { db, history } = await fixture(t);
  const {
    recordCronResult,
  } = require('../../back/cron/settlement/cronStatistics');
  for (const [index, [status, stat]] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ].entries()) {
    const id = 'run-' + index;
    await history.enqueue(id, 1, 'node', 1000);
    await history.start(id);
    const statusReport = () =>
      history.shellReport(id, 1, false, false, 'script.log', 0, 17);
    const record = () => recordCronResult(db, 1, 17, 1000, Date.now(), id);
    if (status) await statusReport();
    if (stat) await record();
    await history.complete(id, 'failed', null, 17);
    await Promise.all([
      statusReport(),
      record(),
      history.complete(id, 'failed', null, 17),
    ]);
  }
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.state, r.exit_code]),
    Array.from({ length: 4 }, () => ['failed', 17]),
  );
  const [row] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(row, { run_count: 4, success_count: 0, fail_count: 4 });
});

test('online reconciliation preserves pending callbacks only for unchanged rules', async () => {
  const stacks = new Map();
  const queued = [];
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../loaders/logger': logger,
    '../cron/scheduling/cronScheduler': {
      createCronJob: (_, fire) => ({ fire, start() {}, cancel() {} }),
    },
    '../cron/execution/runCron': {
      runCron: (_cmd, _item, isCurrent) => queued.push(isCurrent),
    },
  });
  const item = { id: 'b', schedule: '* * * * * *', command: 'old' };
  const apply = (crons) =>
    addCron({ request: { replace: true, crons } }, (err) =>
      assert.ifError(err),
    );
  apply([item]);
  await stacks.get('b')[0].fire(new Date());
  apply([{ ...item, id: 'unrelated' }, { ...item }]);
  apply([item]);
  const original = stacks.get('b');
  addCron({ request: { replace: false, crons: [{ ...item }] } }, (err) =>
    assert.ifError(err),
  );
  assert.equal(stacks.get('b'), original);
  assert.equal(queued[0](), true);
  apply([{ ...item, command: 'new' }]);
  assert.equal(queued[0](), false);
  await stacks.get('b')[0].fire(new Date());
  apply([]);
  assert.equal(queued[1](), false);
});

test('a live crond wrapper keeps its claim across HTTP restart, and a dead owner releases it for Node', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', isDisabled: 0 });
  assert.equal(
    await history.startSystem('system-live', 1, systemOwner(process.pid)),
    true,
  );
  await history.interrupt('http');
  await history.enqueue('next', 1, 'node', Date.now());
  assert.equal(await history.start('next'), false);
  // Simulate PID reuse on this boot. A liveness check for the PID alone would block this run.
  await db.query(
    "UPDATE CronTriggers SET owner=owner || '-old' WHERE id='system-live'",
  );
  assert.equal(await history.start('next'), true);
  const previous = (await history.recent(1, 0)).find(
    (row) => row.id === 'system-live',
  );
  assert.deepEqual(
    [previous.state, previous.reason, previous.exit_code],
    ['unknown', 'restart', null],
  );
});

test('manual and system single-instance requests preserve a live legacy process without a receipt', async (t) => {
  const { models, history } = await fixture(t);
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../config': {},
    '../cron/execution/cronLimit': {},
    '../schedule/client': {},
    '../data/runningInstance': {},
    '../config/util': {},
    '../shared/logStreamManager': {},
    '../loaders/logger': logger,
  }).default;
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    pid: process.pid,
    isDisabled: 0,
    allow_multiple_instances: 0,
  });
  const svc = new Service(logger);
  let launched = false;
  svc.runSingle = async () => {
    launched = true;
  };
  await svc.run([1]);
  assert.equal(launched, false);
  assert.equal(
    await history.startSystem('system-blocked', 1, 'test-owner'),
    false,
  );
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.state, r.reason]),
    [
      ['skipped', 'overlap'],
      ['skipped', 'overlap'],
    ],
  );
  const row = await models.CrontabModel.findByPk(1);
  assert.deepEqual([row.status, row.pid], [0, process.pid]);
});

test('trigger instances settle once on child close, ignore late starts and retain another live copy', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    allow_multiple_instances: 1,
  });
  for (const id of ['a', 'b']) {
    await history.enqueue(id, 1, 'node', Date.now());
    assert.equal(await history.start(id, Date.now(), true), true);
    await history.reportInstance(id, 1, true, process.pid, id + '.log', 100, 0);
  }
  await history.complete('b', 'failed', null, 17);
  await history.reportInstance('b', 1, true, process.pid, 'b.log', 100, 0);
  assert.equal((await models.CrontabModel.findByPk(1)).status, 0);
  assert.equal((await models.CrontabModel.findByPk(1)).log_path, 'a.log');
  await history.complete('a', 'finished', null, 0);
  assert.equal((await models.CrontabModel.findByPk(1)).status, 1);
  const rows = await db.query(
    'SELECT status,exit_code FROM RunningInstances ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(rows, [
    { status: 1, exit_code: 0 },
    { status: 3, exit_code: 17 },
  ]);
});

test('queue cancellation wins against future dispatch, counts requests and leaves future slots eligible', async (t) => {
  const { history } = await fixture(t);
  for (const id of ['first', 'second'])
    await history.enqueue(id, 1, 'node', Date.now());
  assert.deepEqual(await history.queueCounts(), { triggers: 2, tasks: 1 });
  assert.deepEqual((await history.cancelQueued([1])).sort(), [
    'first',
    'second',
  ]);
  assert.equal(await history.start('first'), false);
  assert.deepEqual(await history.queueCounts(), { triggers: 0, tasks: 0 });
  await history.enqueue('next', 1, 'node', Date.now());
  assert.equal(await history.start('next'), true);
  assert.equal(await history.shouldStop('next'), false);
  await history.cancelQueued([1]);
  assert.equal(await history.shouldStop('next'), true);
});

test('script entry percentile covers only scheduled entries that reached the script', async (t) => {
  const { db, history } = await fixture(t);
  for (const [id, source, planned, entry] of [
    ['a', 'node', 100, 601],
    ['b', 'node', 200, 7000],
    ['c', 'manual', null, 500],
    ['d', 'node', 400, null],
  ]) {
    await history.enqueue(id, 42, source, planned, 500);
    await db.query(
      'UPDATE CronTriggers SET script_started_at=$entry WHERE id=$id',
      { bind: { id, entry } },
    );
  }
  const { scriptSamples, scriptStartP95, scriptOnTime, planned } =
    await history.metrics(0);
  assert.deepEqual(
    [scriptSamples, scriptStartP95, scriptOnTime, planned],
    [2, 6800, 1, 3],
  );
});

test('trigger punctuality uses the time the scheduler saw each dated slot, including skipped slots', async (t) => {
  const { history } = await fixture(t);
  await history.enqueue('manual', 1, 'manual', null, 12000);
  const empty = await history.metrics(0);
  assert.deepEqual(
    [empty.planned, empty.triggerOnTime, empty.triggerDeviationP95],
    [0, 0, null],
  );
  await history.enqueue('timely', 1, 'node', 10000, 15000);
  await history.finish('timely', 'skipped', 'overlap', null);
  await history.enqueue('late', 1, 'recovery', 10000, 15001);
  await history.enqueue('early', 1, 'node', 20000, 14000);
  await history.enqueue('previous', 1, 'node', 1000, 1000);
  const metrics = await history.metrics(10000);
  assert.deepEqual(
    [
      metrics.observed,
      metrics.planned,
      metrics.triggerOnTime,
      metrics.triggerDeviationP95,
      metrics.skipped,
      metrics.scriptSamples,
    ],
    [4, 3, 1, 6000, 1, 0],
  );
});

test('a scheduled sleep contributes its trigger time independently of its three-second execution', async (t) => {
  const { root, history, models } = await fixture(t);
  const previous = process.env.QL_DATA_DIR;
  process.env.QL_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.QL_DATA_DIR;
    else process.env.QL_DATA_DIR = previous;
  });
  const rule = { id: '1', command: 'sleep 3' };
  await models.CrontabModel.create({ id: 1, status: 1, isDisabled: 0 });
  const { runCron } = load('back/cron/execution/runCron.ts', {
    './cronLimit': {
      runWithCronLimit: (_, run) => run(),
      removeQueuedCron() {},
    },
    '../history': { triggerHistory: () => history },
    '../../data/cron': models,
    '../../data/runningInstance': {},
    '../../loaders/logger': logger,
  });
  const time = Date.now();
  await runCron(rule.command, rule, () => true, {
    id: 'timed-sleep',
    source: 'node',
    time,
  });
  const [row] = await history.recent(1, 0);
  assert.equal(row.exit_code, 0);
  assert.ok(row.finished_at - row.started_at >= 3000);
  assert.ok(
    row.command_started_at >= row.started_at &&
      row.command_started_at < row.finished_at,
  );
  assert.ok(row.finished_at - row.command_started_at >= 2900);
  assert.equal(row.script_started_at, null);
  const metrics = await history.metrics(time);
  assert.deepEqual(
    [metrics.planned, metrics.triggerDeviationP95, metrics.scriptSamples],
    [1, row.observed_at - time, 0],
  );
});

test('effective resource limits support nested v2, legacy v1 and absent quotas', () => {
  const {
    containerResources,
  } = require('../../back/shared/containerResources');
  function resources(files) {
    return containerResources((path) => files[path] ?? '', 'linux');
  }
  const v2 = resources({
    '/proc/self/cgroup': '0::/parent/child',
    '/sys/fs/cgroup/parent/cpu.max': '150000 100000',
    '/sys/fs/cgroup/parent/child/memory.max': '1073741824',
    '/sys/fs/cgroup/parent/child/memory.current': '268435456',
  });
  assert.deepEqual(
    [v2.cpus, v2.memTotal, v2.memFree],
    [Math.min(1.5, v2.hostCpus), 1073741824, 805306368],
  );
  const v1 = resources({
    '/proc/self/cgroup': '2:cpu,cpuacct:/\n3:memory:/',
    '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '100000',
    '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '400',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '80',
  });
  assert.deepEqual([v1.cpus, v1.memTotal, v1.memFree], [1, 400, 320]);
  const host = resources({
    '/proc/self/cgroup': '0::/',
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/cpu.max': 'max 100000',
  });
  assert.deepEqual(
    [host.cpus, host.memTotal],
    [host.hostCpus, host.hostMemory],
  );
});

test('queued scheduled work is actionable in list, detail, pagination and saved filters without changing the scheduler reservation', async (t) => {
  const { history, models } = await fixture(t);
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../config': {},
    '../schedule/client': {},
    '../config/util': { safeJSONParse: (value) => JSON.parse(value || '{}') },
    '../cron/execution/cronLimit': {},
    '../shared/logStreamManager': {},
    '../shared/utils': {},
    '../data/runningInstance': {},
    '../shared/i18n': { t: (key) => key },
  }).default;
  const service = new Service(logger);
  for (const command of ['task a.sh', 'task b.sh']) {
    await models.CrontabModel.create(new models.Crontab({ command }));
  }
  await history.enqueue('waiting', 2, 'node', Date.now());
  assert.equal((await service.getDb({ id: 2 })).status, 1);
  assert.equal((await service.getDb({ id: 2 }, true)).status, 3);
  const list = (params) =>
    service.crontabs({ page: '1', size: '1', ...params }, true);
  const queued = await list({ filters: JSON.stringify({ status: [3] }) });
  assert.deepEqual(
    [queued.total, queued.data[0].id, queued.data[0].status],
    [1, 2, 3],
  );
  for (const operation of ['In', 'Nin']) {
    const view = await list({
      queryString: JSON.stringify({
        filters: [{ property: 'status', value: [3], operation }],
      }),
    });
    assert.deepEqual(
      [view.total, view.data[0].id],
      [1, operation === 'In' ? 2 : 1],
    );
  }
  await history.enqueue('dispatch', 2, 'node', Date.now());
  await history.start('dispatch');
  assert.equal((await service.getDb({ id: 2 }, true)).status, 0);
  assert.equal(
    (await list({ filters: JSON.stringify({ status: [0] }) })).total,
    1,
  );
  await history.finish('dispatch', 'finished', null, 0);
  assert.equal((await service.getDb({ id: 2 }, true)).status, 3);
  await history.cancelQueued([2]);
  assert.equal((await service.getDb({ id: 2 }, true)).status, 1);
  assert.equal(
    (await list({ filters: JSON.stringify({ status: [3] }) })).total,
    0,
  );
});

test('managed child reports cannot finish a compound command or count its first segment', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({
    id: 1,
    command: 'task first.sh && exit 17',
    status: 1,
  });
  const {
    recordCronResult,
  } = require('../../back/cron/settlement/cronStatistics');
  for (const [id, first, final] of [
    ['tail-fails', 0, 17],
    ['tail-recovers', 7, 0],
  ]) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id);
    await history.bindCommand(id, process.pid);
    await history.reportInstance(id, 1, true, process.pid, id, 100, 0);
    await history.reportInstance(id, 1, false, process.pid, id, 100, 1, first);
    await recordCronResult(db, 1, first, 1000, Date.now(), id);
    const [intermediate] = await db.query(
      'SELECT state,counted FROM CronTriggers WHERE id=$id',
      { bind: { id }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(intermediate, { state: 'running', counted: 0 });
    assert.equal((await models.CrontabModel.findByPk(1)).status, 0);
    await history.enqueue(id + '-overlap', 1, 'manual', null);
    assert.equal(await history.start(id + '-overlap'), false);
    const state = final ? 'failed' : 'finished';
    await history.complete(id, state, null, final);
    await history.reportInstance(id, 1, false, process.pid, id, 100, 1, first);
    await history.complete(id, state, null, final);
    const [result] = await db.query(
      'SELECT state,exit_code FROM CronTriggers WHERE id=$id',
      { bind: { id }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(result, { state, exit_code: final });
  }
  const [totals] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(totals, { run_count: 2, success_count: 1, fail_count: 1 });
});

test('manual multi-instance submissions each claim their own slot, with separate cancellation and edit outcomes', async (t) => {
  const { root, db, models, history } = await fixture(t);
  const queue = [];
  const marker = path.join(root, 'ran');
  const logs =
    new (require('../../back/shared/logStreamManager').LogStreamManager)(root);
  const Service = load('back/services/cron.ts', {
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../data/cron': models,
    '../config': { logPath: root },
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0, stopped: 2 },
    },
    '../config/util': { getUniqPath: async () => 'test' },
    '../shared/logStreamManager': { logStreamManager: logs },
    '../cron/execution/cronLimit': {
      manualRunWithCronLimit: (fn) => {
        queue.push(fn);
      },
    },
    '../shared/i18n': { t: (key) => key },
  }).default;
  const svc = new Service(logger);
  const command = 'echo ran >> ' + marker;
  svc.makeCommand = (row) => row.command;
  await models.CrontabModel.create({
    id: 1,
    command,
    status: 1,
    allow_multiple_instances: 1,
  });
  for (let i = 0; i < 3; i++) await svc.run([1]);
  for (const run of queue.splice(0)) await run();
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => r.state),
    ['finished', 'finished', 'finished'],
  );
  await svc.run([1]);
  await svc.run([1]);
  await svc.stop([1]);
  for (const run of queue.splice(0)) await run();
  await svc.run([1]);
  await models.CrontabModel.update(
    { command: 'exit 99' },
    { where: { id: 1 } },
  );
  await queue.shift()();
  const rows = await history.recent(1, 0);
  assert.equal(
    rows.filter((r) => r.state === 'stopped' && r.reason === 'cancelled')
      .length,
    2,
  );
  assert.equal(
    rows.filter((r) => r.state === 'skipped' && r.reason === 'changed').length,
    1,
  );
  assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'ran\nran\nran');
  const idle = await svc.getDb({ id: 1 }, true);
  assert.equal(idle.status, models.CrontabStatus.idle);
  assert.equal(idle.queued_token, null);

  await svc.run([1]);
  await models.CrontabModel.update({ command }, { where: { id: 1 } });
  await svc.run([1]);
  const replacement = await svc.getDb({ id: 1 }, true);
  await queue.shift()();
  const pending = await svc.getDb({ id: 1 }, true);
  assert.equal(pending.status, models.CrontabStatus.queued);
  assert.equal(pending.queued_token, replacement.queued_token);
  await queue.shift()();
  assert.equal(
    (await fs.readFile(marker, 'utf8')).trim().split('\n').length,
    4,
  );
});

test('both stop routes reject a reused PID and still stop a valid sibling', async (t) => {
  const { db, models, history } = await fixture(t);
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await Promise.all([once(other, 'spawn'), once(sibling, 'spawn')]);
  t.after(() => {
    other.kill();
    sibling.kill();
  });
  await models.CrontabModel.create({
    id: 1,
    command: 'task one',
    status: 1,
    allow_multiple_instances: 1,
  });
  for (const [id, pid] of [
    ['stale', other.pid],
    ['sibling', sibling.pid],
  ]) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id, Date.now(), true);
    await history.reportInstance(id, 1, true, pid, id, 1, 0);
  }
  await db.query(
    "UPDATE CronTriggers SET process_identity=process_identity || '-previous' WHERE id='stale'",
  );
  const [row] = await db.query(
    "SELECT instance_id FROM CronTriggers WHERE id='stale'",
    { type: QueryTypes.SELECT },
  );
  const Service = load('back/services/cron.ts', {
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../config': {},
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0, stopped: 2 },
    },
    '../config/util': {
      killTask: async (pid, wait, verify) => {
        verify();
        process.kill(pid);
      },
    },
    '../cron/execution/cronLimit': {},
    '../shared/i18n': { t: (key) => key },
  }).default;
  const svc = new Service(logger);
  assert.equal((await svc.stopInstance(1, row.instance_id)).code, 409);
  const died = once(sibling, 'exit');
  await assert.rejects(svc.stop([1]), (e) => e.status === 409);
  await died;
  assert.doesNotThrow(() => process.kill(other.pid, 0));
});

test('scheduled admission survives worker restart and resumes once the old command exits', async (t) => {
  const { once } = require('node:events');
  const { spawn } = require('node:child_process');
  const { root, models, history } = await fixture(t);
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => old.kill());
  await once(old, 'spawn');
  const ended = once(old, 'exit');
  const marker = path.join(root, 'launches');
  const rule = {
    id: '1',
    command: 'echo fired >> ' + marker,
    skip_if_pending: true,
  };
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    isDisabled: 0,
    allow_multiple_instances: 1,
  });
  await history.enqueue('prior', 1, 'node', Date.now());
  await history.start('prior', Date.now(), true);
  await history.bindCommand('prior', old.pid);
  await history.interrupt(process.env.SERVICE_TYPE || 'http');
  const { runCron } = load('back/cron/execution/runCron.ts', {
    './cronLimit': {
      runWithCronLimit: (_, run) => run(),
      removeQueuedCron() {},
    },
    '../history': { triggerHistory: () => history },
    '../../data/cron': models,
    '../../data/runningInstance': {},
    '../../loaders/logger': logger,
  });
  const fire = (id, source) =>
    runCron(rule.command, rule, () => true, { id, source, time: Date.now() });
  await fire('during-restart', 'node');
  const rows = await history.recent(1, 0);
  assert.equal(rows.find((r) => r.id === 'prior').state, 'running');
  assert.equal(rows.find((r) => r.id === 'during-restart').reason, 'pending');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  old.kill();
  await ended;
  await fire('resumed', 'recovery');
  assert.equal(await fs.readFile(marker, 'utf8'), 'fired\n');
  assert.equal(
    (await history.recent(1, 0)).find((r) => r.id === 'resumed').state,
    'finished',
  );
  const now = Date.now();
  const admissions = await Promise.all(
    ['node', 'recovery'].map((source) =>
      history.enqueueUnlessPending(source, 1, source, now, now),
    ),
  );
  assert.deepEqual(admissions.sort(), [false, true]);
});

function barrier() {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const resume = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait() {
      enter();
      return resume;
    },
  };
}

async function editRaceFixture(t) {
  const { root, models, history } = await fixture(t);
  const queued = [];
  const client = { delCron: async () => {}, addCron: async () => {} };
  let prepareLogs = async () => {};
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': {},
    '../loaders/logger': logger,
    '../schedule/client': client,
    '../config': { logPath: root },
    '../config/util': {
      isDemoEnv: () => false,
      getUniqPath: async () => 'test',
    },
    '../cron/scheduling/schedulerMutationLock': {
      withSchedulerMutation: (fn) => fn(),
    },
    '../cron/execution/cronLimit': {
      manualRunWithCronLimit: (fn) => {
        queued.push(fn);
      },
    },
    '../shared/logStreamManager': {
      logStreamManager:
        new (require('../../back/shared/logStreamManager').LogStreamManager)(
          root,
        ),
    },
    'fs/promises': {
      ...fs,
      mkdir: async (...args) => {
        await prepareLogs();
        return fs.mkdir(...args);
      },
    },
  }).default;
  const service = new Service(logger);
  service.getLogName = async () => 'test';
  service.setCrontab = async () => {};
  service.makeCommand = (task) => task.command;
  Object.defineProperty(service, 'schedulerMode', { value: 'node' });
  return {
    root,
    service,
    client,
    models,
    history,
    queued,
    setLogBarrier(fn) {
      prepareLogs = fn;
    },
  };
}

for (const rollback of [false, true]) {
  test(`configuration ${
    rollback ? 'rollback' : 'save'
  } preserves a concurrently finished run`, async (t) => {
    const { service, models, history, client, queued } = await editRaceFixture(
      t,
    );
    const task = await service.create({
      name: 'before',
      command: 'true',
      schedule: '* * * * *',
    });
    await service.run([task.id]);
    const gate = barrier();
    service.getLogName = async () => {
      await gate.wait();
      return 'test';
    };
    if (rollback)
      client.addCron = async () => {
        throw Error('scheduler unavailable');
      };
    const saved = service.update({ id: task.id, name: 'changed' });
    const checked = rollback ? assert.rejects(saved) : saved;
    await gate.entered;
    try {
      await queued.shift()();
    } finally {
      gate.release();
    }
    await checked;
    const row = await service.getDb({ id: task.id }, true);
    assert.equal(row.name, rollback ? 'before' : 'changed');
    assert.equal(row.status, models.CrontabStatus.idle);
    assert.equal(row.queued_token, null);
    assert.equal(row.pid, null);
    assert.ok(row.log_path);
    assert.equal((await history.recent(task.id, 0))[0].state, 'finished');
    assert.equal((await history.queueCounts()).triggers, 0);
  });
}

for (const multiple of [0, 1]) {
  test(`an edit winning the manual claim suppresses the old command (multiple=${multiple})`, async (t) => {
    const { root, service, history, queued, setLogBarrier } =
      await editRaceFixture(t);
    const marker = path.join(root, 'effects');
    const task = await service.create({
      name: 'race',
      command: 'echo old >> ' + marker,
      schedule: '@once',
      allow_multiple_instances: multiple,
    });
    await service.run([task.id]);
    const gate = barrier();
    setLogBarrier(() => gate.wait());
    const dispatch = queued.shift()();
    await gate.entered;
    try {
      await service.update({ id: task.id, command: 'echo new >> ' + marker });
    } finally {
      gate.release();
    }
    await dispatch;
    const [discarded] = await history.recent(task.id, 0);
    assert.equal(discarded.state, 'skipped');
    assert.equal(discarded.reason, 'changed');
    assert.equal(discarded.started_at, null);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    await service.run([task.id]);
    await queued.shift()();
    assert.equal(await fs.readFile(marker, 'utf8'), 'new\n');
  });
}

test('worker crash before identity commit closes the launch pipe without executing user code', async (t) => {
  const { root, history, models } = await fixture(t);
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const workerFile = path.join(root, 'worker.cjs');
  const marker = path.join(root, 'old-started');
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    allow_multiple_instances: 1,
  });
  await fs.writeFile(
    workerFile,
    `
    const { createRequire } = require('node:module');
    const r = createRequire(process.cwd() + '/package.json');
    const { Sequelize, Transaction } = r('sequelize');
    const load = r('./test/helpers/load-security-module.cjs');
    const { TriggerHistory } = r('./back/cron/history');
    const db = new Sequelize({ dialect: 'sqlite', storage: process.argv[2], logging: false,
      transactionType: Transaction.TYPES.IMMEDIATE });
    const history = new TriggerHistory(db);
    history.bindCommand = async (_, pid) => {
      process.send(pid);
      await new Promise(() => {});
    };
    const { runCron } = load('back/cron/execution/runCron.ts', {
      './cronLimit': { runWithCronLimit: (_, fn) => fn(), removeQueuedCron() {} },
      "../history": { triggerHistory: () => history },
      "../../data/cron": load('back/data/cron.ts', { '.': { sequelize: db } }),
      "../../data/runningInstance": {}, "../../loaders/logger": { info() {}, error() {} },
    });
    runCron('echo old > "$PROBE"', { id: '1', skip_if_pending: true }, () => true,
      { id: 'prior', time: Date.now(), source: 'node' }).catch(e => { throw e; });
  `,
  );
  const worker = fork(workerFile, [path.join(root, 'panel.sqlite')], {
    execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, PROBE: marker },
  });
  t.after(() => worker.kill());
  const [pid] = await once(worker, 'message');
  process.kill(pid, 0);
  const exit = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exit;
  await history.interrupt(process.env.SERVICE_TYPE || 'http');
  assert.equal(
    await history.enqueueUnlessPending(
      'next',
      1,
      'node',
      Date.now(),
      Date.now(),
    ),
    true,
  );
  // Wait for the shell to observe EOF, including on hosts that retain an orphan zombie.
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      systemOwner(pid);
    } catch {
      break;
    }
    assert.ok(
      Date.now() < deadline,
      'unreleased shell must exit with its worker',
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('a managed shell sources BASH_ENV once and only after launch authorization', async (t) => {
  const { once } = require('node:events');
  const {
    spawnCronCommand,
    releaseCronCommand,
  } = require('../../back/cron/execution/cronCommandProcess');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-shell-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'events');
  const profile = path.join(root, 'profile');
  await fs.writeFile(profile, `echo profile >> "${marker}"\n`);
  const launch = () => {
    const previous = process.env.BASH_ENV;
    const data = process.env.QL_DATA_DIR;
    try {
      process.env.QL_DATA_DIR = root;
      process.env.BASH_ENV = profile;
      return spawnCronCommand(`echo command >> "${marker}"`, 'profile-test');
    } finally {
      if (data === undefined) delete process.env.QL_DATA_DIR;
      else process.env.QL_DATA_DIR = data;
      if (previous === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previous;
    }
  };
  const cancelled = launch();
  const cancelledExit = once(cancelled, 'close');
  cancelled.stdin.end();
  assert.equal((await cancelledExit)[0], 125);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });

  const authorized = launch();
  const normalExit = once(authorized, 'close');
  await releaseCronCommand(authorized);
  assert.equal((await normalExit)[0], 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'profile\ncommand\n');
});

test('a rejected same-backend edit never withdraws the timer; failed cross-backend restoration stays pending', async (t) => {
  const { service, models, client } = await editRaceFixture(t);
  const timers = new Map();
  client.addCron = async (rows) =>
    rows.forEach((row) => timers.set(row.id, row));
  client.delCron = async (ids) => ids.forEach((id) => timers.delete(id));
  const rule = { command: 'true', schedule: '*/2 * * * * *' };
  await service.create({ ...rule, name: 'conflict' });
  const job = await service.create({
    ...rule,
    name: 'original',
    max_queue_wait: 3,
  });
  const old = timers.get(String(job.id));
  const save = service.updateDb.bind(service);
  let uninterrupted = false;
  service.updateDb = async (row) => {
    uninterrupted = timers.get(String(job.id)) === old;
    return save(row);
  };
  await assert.rejects(service.update({ id: job.id, name: 'conflict' }), {
    name: 'SequelizeUniqueConstraintError',
  });
  assert.equal(uninterrupted, true);
  assert.equal(timers.get(String(job.id)), old);
  let retry = 0;
  client.readiness = {
    invalidate() {
      retry++;
    },
  };
  client.addCron = async () => {
    throw Error('unavailable');
  };
  service.updateDb = async () => {
    throw Error('database is unavailable');
  };
  await assert.rejects(service.update({ id: job.id, schedule: '@once' }), {
    status: 503,
  });
  assert.equal(retry, 1);
  const row = await models.CrontabModel.findByPk(job.id);
  assert.equal(row.name, 'original');
  assert.equal(row.saved, false);
});

test('disabled edits publish their new command; a stale subscription batch deletes nothing', async (t) => {
  const { service, models } = await editRaceFixture(t);
  const original = {
    command: 'task node "repo/my file.sh"',
    schedule: '* * * * *',
  };
  const a = await service.create({ ...original, name: 'keep' });
  const b = await service.create({ ...original, name: 'other' });
  await service.disabled([a.id]);
  const snapshots = [];
  service.setCrontab = async () =>
    snapshots.push((await models.CrontabModel.findByPk(a.id))?.command);
  const old = {
    id: a.id,
    script: 'repo/my file.sh',
    revision: a.recovery_from,
  };
  await service.update({
    id: a.id,
    name: 'repurposed',
    command: original.command,
  });
  assert.deepEqual(snapshots, [original.command]);
  // Even an edit which keeps the operand invalidates the old snapshot.
  await assert.rejects(service.remove([b.id, old]), { status: 409 });
  await service.update({ id: a.id, command: 'task other.sh' });
  assert.equal(snapshots.at(-1), 'task other.sh');
  await assert.rejects(
    service.remove([b.id, { id: a.id, script: old.script }]),
    { status: 409 },
  );
  assert.equal(await models.CrontabModel.count(), 2);
  await service.remove([{ id: a.id, script: 'other.sh' }]);
  assert.equal(await models.CrontabModel.count(), 1);
});

for (const reason of ['changed', 'queue_timeout']) {
  test(
    'the last launch gate rejects ' +
      reason +
      ' during command identity binding',
    async (t) => {
      const { root, models, history } = await fixture(t);
      await models.CrontabModel.create({ id: 1, status: 1, isDisabled: 0 });
      const rule = {
        id: '1',
        max_queue_wait: reason === 'queue_timeout' ? 1 : 0,
      };
      let current = true;
      const bind = history.bindCommand.bind(history);
      history.bindCommand = async (...args) => {
        assert.equal(await bind(...args), true);
        if (reason === 'changed') current = false;
        else await new Promise((resolve) => setTimeout(resolve, 1010));
        return true;
      };
      const { runCron } = load('back/cron/execution/runCron.ts', {
        './cronLimit': {
          runWithCronLimit: (_, run) => run(),
          removeQueuedCron() {},
        },
        '../history': { triggerHistory: () => history },
        '../../data/cron': models,
        '../../data/runningInstance': {},
        '../../loaders/logger': logger,
      });
      const marker = path.join(root, 'must-not-run');
      await runCron('echo fired > ' + marker, rule, () => current, {
        id: reason,
        source: 'node',
        time: Date.now(),
      });
      const [row] = await history.recent(1, 0);
      assert.deepEqual(
        [row.state, row.reason, row.started_at, row.exit_code],
        ['skipped', reason, null, null],
      );
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    },
  );
}

test('new and legacy log names keep a quoted subscription script executable and preserve its real exit code', async (t) => {
  const { spawnSync } = require('node:child_process');
  const { getUniqPath } = require('../../back/config/util');
  const { shellQuote } = require('../../back/shared/shellQuote');
  const { root, service } = await editRaceFixture(t);
  const file = "repo/what's new.sh";
  const command = 'task ' + shellQuote(file);
  const clean = await getUniqPath(command, '99');
  assert.equal(clean, 'repo_what_s_new_99');
  await fs.mkdir(path.join(root, 'repo'));
  await fs.writeFile(path.join(root, file), 'echo executed; exit 7');
  for (const log_name of [clean, "repo_what'$(touch injected)"]) {
    const cmd = Object.getPrototypeOf(service).makeCommand.call(service, {
      command,
      id: 99,
      log_name,
    });
    const result = spawnSync(
      '/bin/bash',
      ['-c', 'task(){ bash "$1"; }; ' + cmd],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 7);
    assert.equal(result.stdout.trim(), 'executed');
    await assert.rejects(fs.access(path.join(root, 'injected')), {
      code: 'ENOENT',
    });
  }
});

test('trigger history continues from the last visible row even when newer rows arrive or the cursor is pruned', async (t) => {
  const { history, db } = await fixture(t);
  for (let n = 0; n < 25; n++)
    await history.enqueue(
      'slot-' + String(n).padStart(2, '0'),
      1,
      'manual',
      null,
      100,
    );
  assert.equal((await history.recent(1, 0, 26)).length, 25);
  await history.enqueue('older', 1, 'manual', null, 99);
  const first = await history.recent(1, 0, 26);
  assert.equal(first.length, 26);
  const last = first[24];
  await history.enqueue('newer', 1, 'manual', null, 101);
  await db.query('DELETE FROM CronTriggers WHERE id=$id', {
    bind: { id: last.id },
  });
  const older = await history.recent(1, 0, 26, {
    time: last.observed_at,
    id: last.id,
  });
  assert.deepEqual(
    older.map((row) => row.id),
    ['older'],
  );
  assert.equal((await history.recent(1, 0)).length, 25);
});

test('expanded history refreshes visible runs by identity after newer records push them off the first page', async (t) => {
  const { history } = await fixture(t);
  await history.enqueue('visible', 1, 'manual', null, 10);
  await history.start('visible', 11);
  await history.enqueue('other-task', 2, 'manual', null, 15);
  for (let i = 0; i < 26; i++)
    await history.enqueue('new-' + i, 1, 'manual', null, 20 + i);
  assert.ok(!(await history.recent(1, 0)).some((row) => row.id === 'visible'));
  await history.finish('visible', 'finished', null, 0);
  const rows = await history.visibleTriggers(1, [
    'visible',
    'other-task',
    'pruned',
  ]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.state, row.exit_code]),
    [['visible', 'finished', 0]],
  );
});

test('live logs follow the active trigger while queued or awaiting its shell path', async (t) => {
  const { root, models, history } = await fixture(t);
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': {},
    '../config': { logPath: root },
    '../config/util': {
      fileExist: async (file) => (await fs.stat(file)).isFile(),
    },
    '../shared/i18n': { t: (text) => text },
    '../cron/execution/cronLimit': {},
    '../schedule/client': {},
    '../shared/logStreamManager': {},
    '../loaders/logger': logger,
  }).default;
  const service = new Service(logger);
  await fs.writeFile(path.join(root, 'old.log'), 'finished first run');
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    log_path: 'old.log',
    command: 'task sample',
  });
  assert.equal((await service.log(1)).content, 'finished first run');
  await history.enqueue('later', 1, 'node', Date.now());
  const queued = await service.log(1);
  assert.deepEqual(
    [queued.status, queued.nextOffset, queued.logPath],
    ['running', 0, undefined],
  );
  await history.start('later', Date.now(), false);
  const starting = await service.log(1);
  assert.deepEqual(
    [starting.status, starting.nextOffset, starting.logPath],
    ['running', 0, undefined],
  );
  await fs.writeFile(path.join(root, 'new.log'), 'second run');
  await history.reportInstance(
    'later',
    1,
    true,
    process.pid,
    'new.log',
    100,
    0,
  );
  const live = await service.log(1, {
    previousPath: 'old.log',
    offset: 10,
    follow: true,
  });
  assert.deepEqual(
    [live.logPath, live.content, live.offset],
    ['new.log', 'second run', 0],
  );
});

test('a concurrent viewer keeps its receipt through sibling starts, interleaved finishes and retention', async (t) => {
  const { root, models, history, db } = await fixture(t);
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': {},
    '../config': { logPath: root },
    '../config/util': {
      fileExist: async (file) =>
        fs.stat(file).then(
          () => true,
          () => false,
        ),
    },
    '../shared/i18n': { t: (text) => text },
    '../cron/execution/cronLimit': {},
    '../schedule/client': {},
    '../shared/logStreamManager': {},
    '../loaders/logger': logger,
  }).default;
  const service = new Service(logger);
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    command: 'task sample',
    allow_multiple_instances: 1,
  });
  const poll = (triggerId, options) =>
    service.log(1, { triggerId, follow: true, ...options });
  await history.enqueue('first', 1, 'node', 100);
  assert.equal((await poll()).triggerId, 'first');
  for (const [i, id] of ['first', 'second', 'third'].entries()) {
    if (i) await history.enqueue(id, 1, 'node', 100 + i);
    await history.start(id, 101 + i, true);
    await fs.writeFile(path.join(root, id + '.log'), id + '\n');
    // A command can own a file before any task wrapper registers a RunningInstance.
    await history.shellReport(id, 1, false, true, id + '.log', 0);
    assert.equal((await poll()).triggerId, id);
    assert.equal((await poll('first')).content, 'first\n');
  }
  const earlier = await poll('second');
  await fs.appendFile(path.join(root, 'second.log'), 'final\n');
  await history.complete('second', 'finished', null, 0);
  const final = await poll('second', {
    previousPath: earlier.logPath,
    offset: earlier.nextOffset,
    cursor: earlier.cursor,
  });
  assert.deepEqual(
    [final.triggerId, final.content, final.status],
    ['second', 'final\n', 'completed'],
  );
  await history.complete('third', 'finished', null, 0);
  assert.equal((await poll()).triggerId, 'first');
  assert.equal((await poll('second')).content, 'second\nfinal\n');
  assert.equal((await service.log(2, { triggerId: 'first' })).total, 0);
  await db.query("DELETE FROM CronTriggers WHERE id='second'");
  const removed = await poll('second');
  assert.deepEqual(
    [removed.status, removed.total, removed.logPath],
    ['notFound', 0, undefined],
  );
});

test('concurrent manual runs with logging disabled drain both pipes and publish only the ignored path', async (t) => {
  const { root, models, history } = await fixture(t);
  const queue = [];
  const Service = load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': {},
    '../config': { logPath: root },
    '../config/util': {},
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../cron/execution/cronLimit': {
      manualRunWithCronLimit: (fn) => queue.push(fn),
    },
    '../shared/i18n': { t: (text) => text },
    '../shared/logStreamManager': { logStreamManager: {} },
  }).default;
  const service = new Service(logger);
  service.makeCommand = (row) => row.command;
  await models.CrontabModel.create({
    id: 1,
    command: 'echo stdout && echo stderr >&2',
    status: 1,
    log_name: '/dev/null',
    allow_multiple_instances: 1,
  });
  await service.run([1]);
  await service.run([1]);
  await Promise.all(queue.map((job) => job()));
  const receipts = await history.recent(1, 0);
  assert.equal(receipts.length, 2);
  for (const row of receipts) {
    assert.deepEqual(
      [row.state, row.exit_code, row.log_path],
      ['finished', 0, '/dev/null'],
    );
    assert.equal(
      (await service.log(1, { triggerId: row.id })).status,
      'ignored',
    );
  }
});

test('a single stop settles its own receipt, logs and daily counts even when SIGTERM exits zero', async (t) => {
  const { root, db, models, history } = await fixture(t);
  const {
    recordCronResult,
  } = require('../../back/cron/settlement/cronStatistics');
  const instances = db.models.RunningInstance;
  const Service = load('back/services/cron.ts', {
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../config': { logPath: root },
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: { running: 0 },
    },
    '../config/util': {
      fileExist: async (file) => !!(await fs.stat(file)),
      killTask: async (pid, wait, verify, request) => {
        verify();
        await request(() => {
          if (deny) throw Object.assign(Error('denied'), { code: 'EPERM' });
        });
      },
    },
    '../cron/execution/cronLimit': {},
    '../shared/i18n': { t: (key) => key },
  }).default;
  let deny = true;
  const service = new Service(logger);
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    allow_multiple_instances: 1,
  });
  const target = {};
  for (const id of ['a', 'b', 'c']) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id, Date.now(), true);
    await history.bindCommand(id, process.pid, id + '.log');
    await fs.writeFile(path.join(root, id + '.log'), 'instance-' + id);
    const row = await instances.findOne({ where: { log_path: id + '.log' } });
    target[id] = row.id;
  }
  await assert.rejects(service.stopInstance(1, target.b), { code: 'EPERM' });
  assert.equal(await history.shouldStop('b'), false);
  deny = false;
  assert.equal((await service.stopInstance(1, target.b)).code, 200);
  assert.equal(await history.shouldStop('a'), false);
  assert.equal(await history.shouldStop('b'), true);
  assert.equal(await history.shouldStop('c'), false);
  assert.equal((await instances.findByPk(target.b)).status, 0); // command owner still drains the log
  await history.complete('b', 'finished', null, 0);
  for (const id of ['a', 'b', 'c']) {
    const log = await service.log(1, { instanceId: target[id] });
    assert.deepEqual(
      [log.content, log.status],
      ['instance-' + id, id === 'b' ? 'completed' : 'running'],
    );
  }
  assert.equal(
    (await service.log(2, { instanceId: target.b })).status,
    'notFound',
  );
  await history.complete('c', 'failed', null, 17);
  await history.complete('a', 'finished', null, 0);
  await recordCronResult(db, 1, 17, 900, Date.now(), 'b');
  await history.complete('b', 'failed', null, 17);
  const receipts = await db.query(
    'SELECT id,state,exit_code,counted FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    receipts.map((r) => [r.id, r.state, r.exit_code, r.counted]),
    [
      ['a', 'finished', 0, 1],
      ['b', 'stopped', 0, 1],
      ['c', 'failed', 17, 1],
    ],
  );
  assert.deepEqual(
    (await instances.findAll({ order: [['id', 'ASC']] })).map((row) => [
      row.status,
      row.exit_code,
    ]),
    [
      [1, 0],
      [2, 0],
      [3, 17],
    ],
  );
  assert.equal(
    (await service.log(1, { instanceId: target.b })).content,
    'instance-b',
  );
  const [counts] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(counts, { run_count: 3, success_count: 1, fail_count: 1 });
});

test('a crond stop racing owner recovery is counted once and an unsolicited signal is a failure', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    isDisabled: 0,
  });
  assert.equal(
    await history.startSystem('system-stop', 1, systemOwner(process.pid)),
    true,
  );
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {});
  await db.query(
    "UPDATE CronTriggers SET owner=owner || '-old' WHERE id='system-stop'",
  );
  await history.queueCounts();
  await history.stopVerifiedInstance(instance.id);
  await history.complete('system-stop', 'failed', null, 143);
  assert.equal((await history.recent(1, 0))[0].state, 'stopped');
  await history.enqueue('external', 1, 'node', Date.now());
  await history.start('external');
  await history.complete('external', 'stopped', 'SIGKILL', null);
  assert.equal((await history.recent(1, 0))[0].state, 'failed');
  const [counts] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(counts, { run_count: 2, success_count: 0, fail_count: 1 });
});

test('late dashboard callbacks cannot count a trigger cancelled before dispatch', async (t) => {
  const { db, history } = await fixture(t);
  const {
    recordCronResult,
  } = require('../../back/cron/settlement/cronStatistics');
  await history.enqueue('waiting', 1, 'manual', null);
  await history.cancelQueued([1]);
  await recordCronResult(db, 1, 0, 10, Date.now(), 'waiting');
  assert.equal(
    (await db.query('SELECT * FROM CrontabStats', { type: QueryTypes.SELECT }))
      .length,
    0,
  );
});

test('stop claims serialize with natural completion and duplicate requests from separate connections', async (t) => {
  const { history, models, db, root } = await fixture(t);
  const peer = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'panel.sqlite'),
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
  });
  t.after(() => peer.close());
  const remote = new TriggerHistory(peer);
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    allow_multiple_instances: 1,
  });
  const ids = {};
  for (const id of ['natural', 'cancel', 'other']) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id, Date.now(), true);
    await history.bindCommand(id, process.pid, id + '.log');
    ids[id] = (
      await db.models.RunningInstance.findOne({
        where: { log_path: id + '.log' },
      })
    ).id;
  }
  const signalGone = () => {
    throw Object.assign(Error('gone'), { code: 'ESRCH' });
  };
  await assert.rejects(
    remote.requestInstanceStop(ids.natural, process.pid, signalGone),
    { code: 'ESRCH' },
  );
  await history.complete('natural', 'finished', null, 0);
  let signals = 0;
  const signal = () => {
    signals++;
  };
  await assert.rejects(
    remote.requestInstanceStop(ids.natural, process.pid, signal),
    { code: 'ESRCH' },
  );
  await Promise.all(
    [remote, history].map((h) =>
      h.requestInstanceStop(ids.cancel, process.pid, signal),
    ),
  );
  assert.equal(signals, 1);
  assert.equal(await history.shouldStop('natural'), false);
  assert.equal(await history.shouldStop('other'), false);
  await Promise.all([
    remote.complete('cancel', 'finished', null, 0),
    history.complete('cancel', 'finished', null, 0),
  ]);
  await history.complete('other', 'failed', null, 17);
  const rows = await db.query(
    'SELECT state,exit_code,counted FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    rows.map((r) => [r.state, r.exit_code, r.counted]),
    [
      ['stopped', 0, 1],
      ['finished', 0, 1],
      ['failed', 17, 1],
    ],
  );
  const [counts] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(counts, { run_count: 3, success_count: 1, fail_count: 1 });
});

test('crond waits for its supervisor to report the actual exit after the separate command exits', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  const supervisor = systemOwner(process.pid);
  const command = 'crond:9090:1:boot';
  assert.equal(
    await history.startSystem('system-race', 1, supervisor, command),
    true,
  );
  const instance = await db.models.RunningInstance.findOne();
  assert.equal(instance.pid, 9090);
  assert.equal(await history.instanceIdentity(instance.id), command);
  await history.stopVerifiedInstance(instance.id);
  await history.recoverSystemOwners(1);
  assert.equal((await history.recent(1, 0))[0].state, 'running');
  await history.complete('system-race', 'finished', null, 0);
  assert.equal((await history.recent(1, 0))[0].state, 'finished');
});

test('a legacy crontab entering a sourced wrapper runs its original arguments once and reports its actual exit', async (t) => {
  const { root } = await fixture(t);
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  // Stand in only for the Node receipt client; bash, argument passing and exit
  // propagation run through the production crond supervisor.
  await fs.writeFile(
    path.join(bin, 'node'),
    '#!/bin/sh\nif [ "$1" = -p ]; then echo "test-uuid"; exit 0; fi\necho "$2" >> "$TRACE"\n',
    { mode: 0o755 },
  );
  const wrapper = path.join(root, "old ' task.sh");
  await fs.writeFile(
    wrapper,
    [
      'if [[ -z ${QL_TRIGGER_ID:-} ]]; then . "$SUPERVISOR"; fi',
      'printf "%s\\n" "$@" >> "$TRACE"',
      'exit 17',
    ].join('\n'),
  );
  const trace = path.join(root, 'trace');
  const args = ['a b', "quote' and $literal", ''];
  const result = require('node:child_process').spawnSync(
    '/bin/bash',
    [wrapper, ...args],
    {
      env: {
        ...process.env,
        ID: '7',
        QL_DIR: root,
        QL_TRIGGER_ID: '',
        TRACE: trace,
        SUPERVISOR: path.resolve('shell/system-cron.sh'),
        PATH: bin + ':' + process.env.PATH,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 17, result.stderr);
  assert.equal(
    await fs.readFile(trace, 'utf8'),
    ['start', ...args, 'finish', ''].join('\n'),
  );
});

for (const legacy of [false, true]) {
  test(`stop recovery keeps a real surviving descendant and its first exit receipt linked (legacy=${legacy})`, async (t) => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const { db, models, history } = await fixture(t);
    const children = [];
    t.after(() => {
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    });
    for (let i = 0; i < 2; i++) {
      const c = spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM',()=>{}); console.log('ready');setInterval(()=>{},1000)",
      ]);
      children.push(c);
      await once(c.stdout, 'data');
    }
    const [target, peer] = children;
    const exited = once(target, 'exit');
    await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
    await history.enqueue('stop-restart', 1, 'manual', null);
    await history.start('stop-restart');
    await history.bindCommand('stop-restart', target.pid, 'original.log');
    const instance = await db.models.RunningInstance.findOne();
    if (legacy)
      await db.query(
        'UPDATE CronTriggers SET owner=NULL,command_identity=NULL',
      );
    const identities = [
      systemOwner(target.pid),
      systemOwner(peer.pid) + '-old',
    ];
    await history.requestInstanceStop(
      instance.id,
      target.pid,
      () => target.kill('SIGTERM'),
      identities,
    );
    if (legacy) {
      await history.reportInstance(
        'stop-restart',
        1,
        false,
        target.pid,
        'original.log',
        0,
        1,
        143,
      );
      await require('../../back/cron/settlement/cronStatistics').recordCronResult(
        db,
        1,
        143,
        1000,
        Date.now(),
        'stop-restart',
      );
    } else {
      await history.complete('stop-restart', 'failed', null, 143);
    }
    await history.complete('stop-restart', 'finished', null, 0);
    await history.interrupt('http');
    assert.equal((await history.recent(1, 0))[0].state, 'running');
    assert.equal(await db.models.CrontabStat.count(), 0);
    assert.equal((await instance.reload()).status, 0);
    const service = new (load('back/services/cron.ts', {
      '../schedule/client': {},
      '../loaders/logger': logger,
      '../shared/logStreamManager': {},
      '../config': {},
      '../data/cron': models,
      '../cron/execution/cronLimit': {},
      '../config/util': {},
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0, stopped: 2 },
      },
      '../shared/i18n': { t: (key) => key },
    }).default)(logger);
    const pending = await history.pendingStops();
    await service.resumePendingStops(history, pending);
    assert.equal((await exited)[1], 'SIGKILL');
    assert.equal(peer.exitCode, null);
    process.kill(peer.pid, 0);
    await service.resumePendingStops(history, pending);
    await history.complete('stop-restart', 'failed', null, 17);
    assert.deepEqual(await history.pendingStops(), []);
    await instance.reload();
    assert.deepEqual([instance.status, instance.exit_code], [2, 143]);
    const [row] = await db.query(
      'SELECT state,exit_code,counted FROM CronTriggers',
      { type: QueryTypes.SELECT },
    );
    assert.deepEqual(row, { state: 'stopped', exit_code: 143, counted: 1 });
    const [counts] = await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
    assert.deepEqual(counts, { run_count: 1, success_count: 0, fail_count: 0 });
  });
}

test('restart separates a stop before launch, a lost exit, and a legacy pending stop', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  for (const id of ['gate', 'lost', 'old']) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id, Date.now(), true);
    if (id !== 'gate') await history.bindCommand(id, process.pid, id + '.log');
  }
  await history.cancelQueued([1]);
  await db.query(
    "UPDATE CronTriggers SET command_identity=NULL,process_identity=process_identity || '-gone' WHERE id='lost'",
  );
  await db.query("UPDATE CronTriggers SET stop_requested=1 WHERE id='old'");
  await history.interrupt('http');
  const rows = await db.query(
    'SELECT id,state,reason,counted FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.state, r.reason, r.counted]),
    [
      ['gate', 'stopped', 'cancelled', 0],
      ['lost', 'unknown', 'restart', 0],
      ['old', 'running', 'restart', 0],
    ],
  );
  assert.equal(
    (
      await db.models.RunningInstance.findOne({
        where: { log_path: 'lost.log' },
      })
    ).status,
    4,
  );
  await db.models.RunningInstance.update(
    { status: 3 },
    { where: { log_path: 'lost.log' } },
  );
  await history.reconcileInstances();
  assert.equal(
    (
      await db.models.RunningInstance.findOne({
        where: { log_path: 'lost.log' },
      })
    ).status,
    4,
  );
  assert.equal((await history.pendingStops())[0].pid, process.pid);
});

test('recovered stops persist the real script entry timestamp before consuming the marker', async (t) => {
  const { db, root, history, models } = await fixture(t);
  const original = process.env.QL_DIR;
  process.env.QL_DIR = root;
  t.after(() => {
    if (original === undefined) delete process.env.QL_DIR;
    else process.env.QL_DIR = original;
  });
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  await history.enqueue('timed-stop', 1, 'manual', null);
  await history.start('timed-stop');
  await history.bindCommand('timed-stop', process.pid, 'sample.log');
  const instance = await db.models.RunningInstance.findOne();
  const time = Date.now();
  const marker = path.join(root, '.tmp', 'cron-start-timed-stop');
  await fs.mkdir(path.dirname(marker));
  await fs.writeFile(marker, String(time));
  // Simulate an exit observed after a worker restart. No signal is sent by this fixture.
  await history.requestInstanceStop(instance.id, process.pid, () => {});
  await history.interrupt('http');
  await history.stopVerifiedInstance(instance.id);
  const [receipt] = await history.recent(1, 0);
  assert.deepEqual(
    [receipt.state, receipt.script_started_at],
    ['stopped', time],
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('a BSD child disappearing during ps does not strand a signalled instance or count its stop twice', async (t) => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { db, models, history } = await fixture(t);
  const service = retiredProcessFixtureService(db, models);
  const root = spawn(process.execPath, [
    '-e',
    `
    const child = require('node:child_process').spawn('cat', { stdio: ['inherit', 'ignore', 'ignore'] });
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.on('exit', () => process.exit(0));
    console.log(child.pid);
  `,
  ]);
  t.after(() => root.stdin.end());
  const childPid = Number((await once(root.stdout, 'data'))[0]);
  await models.CrontabModel.create({
    id: 1,
    status: 1,
    command: 'cat',
    allow_multiple_instances: 1,
  });
  for (const [id, pid] of [
    ['target', root.pid],
    ['sibling', process.pid],
  ]) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id, Date.now(), true);
    await history.bindCommand(id, pid);
  }
  const instance = await db.models.RunningInstance.findOne({
    where: { pid: root.pid },
  });
  const targets = [systemOwner(root.pid), systemOwner(childPid)];
  const exited = once(root, 'close');
  await history.requestInstanceStop(
    instance.id,
    root.pid,
    () => root.kill('SIGTERM'),
    targets,
  );
  await exited;
  await history.complete('target', 'stopped', 'cancelled', null);

  const api = load('back/api/cron.ts', {
    typedi: { Container: { get: () => service } },
    '../services/cron': class {},
    '../services/cronView': class {},
    '../schedule/client': {},
    '../validation/schedule': { commonCronSchema: {} },
  });
  const app = express();
  const router = express.Router();
  api.default(router);
  const server = app.use('/api', router).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${
    server.address().port
  }/api/crons/1/instances/${instance.id}/stop`;

  // Recreate the window after kill(pid, 0) has succeeded. The real ps now sees no row.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  const kill = process.kill.bind(process);
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    return pid === childPid ? true : kill(pid, signal);
  });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url, { method: 'POST' });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual([result.code, result.data.outcome], [200, 'stopped']);
    }
  } finally {
    probe.mock.restore();
    Object.defineProperty(process, 'platform', platform);
  }
  assert.equal(await history.pendingStop(instance.id), undefined);
  const rows = await db.query(
    'SELECT id,state,counted FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(rows, [
    { id: 'sibling', state: 'running', counted: 0 },
    { id: 'target', state: 'stopped', counted: 1 },
  ]);
});

test('a restarted stop consumes only the remainder of the original TERM grace period', async (t) => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const {
    finishStoppedTree,
  } = require('../../back/cron/execution/cronProcess');
  const { db, history, models } = await fixture(t);
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
  ]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  await models.CrontabModel.create({ id: 1, status: 1, command: 'true' });
  await history.enqueue('grace', 1, 'manual', null);
  await history.start('grace');
  await history.bindCommand('grace', child.pid);
  const row = await db.models.RunningInstance.findOne();
  const targets = [systemOwner(child.pid)];
  const began = Date.now();
  await history.requestInstanceStop(
    row.id,
    child.pid,
    () => child.kill('SIGTERM'),
    targets,
  );
  const first = await history.pendingStop(row.id);
  assert.ok(first.signalled_at >= began);
  for (let i = 0; i < 2; i++) await history.interrupt('http');
  assert.equal(
    (await history.pendingStop(row.id)).signalled_at,
    first.signalled_at,
  );
  // Observe scheduled delays, independently of load on the test host.
  const delays = [];
  const timer = global.setTimeout;
  const spy = t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    delays.push(ms);
    return timer(fn, ms, ...args);
  });
  try {
    await finishStoppedTree(targets, first.signalled_at - 1000);
  } finally {
    spy.mock.restore();
  }
  assert.equal((await exited)[1], 'SIGKILL');
  assert.ok(
    delays.every((ms) => ms <= 20),
    JSON.stringify(delays),
  );
  await history.stopVerifiedInstance(row.id);
  await history.stopVerifiedInstance(row.id);
  assert.equal((await history.recent(1, 0))[0].state, 'stopped');
});

test('a command without an instance survives two interrupted stop attempts and its old batch cannot select a new command', async (t) => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { db, models, history } = await fixture(t);
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
  ]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  const { killTask } = require('../../back/config/util');
  const service = new (load('back/services/cron.ts', {
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0, stopped: 2 },
    },
    '../config': {},
    '../cron/execution/cronLimit': {},
    '../shared/i18n': { t: (s) => s },
    '../config/util': {
      killTask: async (pid, wait, verify, request) => {
        await killTask(pid, wait, verify, async (signal, targets) => {
          await request(signal, targets);
          throw Error('worker interrupted after TERM');
        });
      },
    },
  }).default)(logger);
  await models.CrontabModel.create({
    id: 1,
    status: 0,
    pid: child.pid,
    command: 'true',
    allow_multiple_instances: 1,
  });
  const birth = systemOwner(child.pid);
  await history.enqueue('legacy', 1, 'manual', null);
  await history.start('legacy');
  await db.query(
    "UPDATE CronTriggers SET command_identity=$birth WHERE id='legacy'",
    { bind: { birth } },
  );
  const key = require('node:crypto').randomUUID();
  await assert.rejects(service.stop([1], key), /interrupted after TERM/);
  const [pending] = await history.pendingStops();
  assert.equal(
    (await history.pendingStop(pending.instance_id)).root_identity,
    birth,
  );
  for (let n = 0; n < 2; n++) await history.interrupt('http');
  await history.enqueue('next', 1, 'manual', null);
  await history.start('next', Date.now(), true);
  await history.bindCommand('next', process.pid, 'next.log');
  await service.resumePendingStops(
    history,
    await history.pendingStops(),
    await history.pendingStopBatches(),
  );
  assert.equal((await exited)[1], 'SIGKILL');
  await service.stop([1], key);
  const rows = await db.query(
    'SELECT state,counted FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(rows, [
    { state: 'stopped', counted: 1 },
    { state: 'running', counted: 0 },
  ]);
  const [stat] = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(stat, { run_count: 1, success_count: 0, fail_count: 0 });
  assert.deepEqual(await history.pendingStops(), []);
  assert.deepEqual(await history.pendingStopBatches(), []);
});

test('two connections atomically bind a fresh batch key to one normalized task set', async (t) => {
  const { db, models, history, root } = await fixture(t);
  const peer = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'panel.sqlite'),
    logging: false,
  });
  t.after(() => peer.close());
  const makeService = (database, cronModels) =>
    new (load('back/services/cron.ts', {
      '../data/cron': cronModels,
      '../data/runningInstance': load('back/data/runningInstance.ts', {
        '.': { sequelize: database },
      }),
      '../config': {},
      '../schedule/client': {},
      '../loaders/logger': logger,
      '../shared/logStreamManager': {},
      '../cron/execution/cronLimit': {},
      '../config/util': {},
      '../shared/i18n': { t: (key) => key },
    }).default)(logger);
  const services = [
    makeService(db, models),
    makeService(peer, load('back/data/cron.ts', { '.': { sequelize: peer } })),
  ];
  for (const id of [1, 2, 3]) {
    await models.CrontabModel.create({ id, command: 'true', status: 3 });
    await history.enqueue('queue-' + id, id, 'manual', null);
  }
  const payloads = [[2, 1, 1], [3], [1, 2], [3, 3]];
  const key = require('node:crypto').randomUUID();
  const attempts = await Promise.allSettled(
    payloads.map((ids, i) => services[i % 2].stop(ids, key)),
  );
  const [binding] = await db.query(
    'SELECT cron_ids,snapshot FROM CronStopBatches',
    { type: QueryTypes.SELECT },
  );
  const winner = JSON.parse(binding.cron_ids);
  assert.equal(binding.snapshot, null);
  for (const [i, attempt] of attempts.entries()) {
    if (winner.includes(payloads[i][0]))
      assert.equal(attempt.status, 'fulfilled');
    else assert.equal(attempt.reason.status, 409);
  }
  for (const id of [1, 2, 3]) {
    assert.equal(
      (await history.recent(id, 0))[0].state,
      winner.includes(id) ? 'stopped' : 'queued',
    );
  }
  const next = 'after-binding';
  await history.enqueue(next, winner[0], 'manual', null);
  await Promise.all(
    services.map((service) => service.stop(winner.slice().reverse(), key)),
  );
  assert.equal(
    (await history.recent(winner[0], 0)).find((row) => row.id === next).state,
    'queued',
  );
});

test('a failed stop-marker write leaves the root untouched and two workers finish only the claimed tree', async (t) => {
  const { db, models, history, root } = await fixture(t);
  const peer = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'panel.sqlite'),
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
  });
  t.after(() => peer.close());
  const remote = new TriggerHistory(peer);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  await history.enqueue('claim', 1, 'manual', null);
  await history.start('claim');
  await history.bindCommand('claim', process.pid, 'claim.log');
  const instance = await db.models.RunningInstance.findOne();
  let signals = 0;
  const claim = (worker, targets, callback) =>
    worker.requestInstanceStop(instance.id, process.pid, callback, targets);
  const signal = () => {
    signals++;
  };
  await db.query(`CREATE TRIGGER reject_marker BEFORE UPDATE OF signalled ON CronStopRequests
    BEGIN SELECT json_extract('invalid json','$'); END`);
  await assert.rejects(
    claim(history, ['root', 'child'], signal),
    /malformed JSON/i,
  );
  assert.equal(signals, 0);
  assert.equal(await history.shouldStop('claim'), false);
  await db.query('DROP TRIGGER reject_marker');
  const denied = Object.assign(Error('child denied'), { code: 'EPERM' });
  await assert.rejects(
    claim(remote, ['root'], () => {
      signals++;
      return denied;
    }),
    (error) => error === denied,
  );
  const saved = await history.pendingStop(instance.id);
  assert.equal(saved.signalled, 1);
  assert.deepEqual(JSON.parse(saved.targets).sort(), ['child', 'root']);
  assert.deepEqual(await history.forgetStop(instance.id), saved);
  const duplicate = await claim(history, ['root', 'different-child'], signal);
  assert.deepEqual(duplicate, {
    targets: JSON.parse(saved.targets),
    signalledAt: saved.signalled_at,
  });
  assert.equal(signals, 1);
  await history.complete('claim', 'finished', null, 0);
  await Promise.all(
    [remote, history].map((worker) => worker.stopVerifiedInstance(instance.id)),
  );
  const counts = await db.query(
    'SELECT run_count,success_count,fail_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(counts, [{ run_count: 1, success_count: 0, fail_count: 0 }]);
});

test('startup reconciliation preserves a live legacy instance whose stop has not succeeded', async (t) => {
  const { db, models, history } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    pid: process.pid,
  });
  const instance = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: process.pid,
    status: 0,
    started_at: 1,
  });
  await history.queueInstanceStop(instance.id, 1, process.pid);
  for (let n = 0; n < 2; n++) await history.reconcileInstances();
  assert.equal((await instance.reload()).status, 0);
  assert.equal((await task.reload()).pid, process.pid);
  assert.equal(task.status, 0);
  assert.equal((await history.pendingStops())[0].instance_id, instance.id);
});

test('a frozen legacy identity conflict is returned on replay without repeating recovery', async (t) => {
  const { models, history, db } = await fixture(t);
  const conflict = () => {
    throw Object.assign(Error('birth differs'), { status: 409 });
  };
  const service = new (load('back/services/cron.ts', {
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../config': {},
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../config/util': {},
    '../cron/execution/cronLimit': {},
    '../shared/i18n': { t: (key) => key },
    '../cron/execution/cronProcess': {
      systemOwner,
      verifyCronProcess: conflict,
    },
  }).default)(logger);
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    pid: process.pid,
  });
  const key = require('node:crypto').randomUUID();
  await assert.rejects(service.stop([1], key), { status: 409 });
  assert.deepEqual(await history.pendingStopBatches(), []);
  await history.enqueue('later', 1, 'manual', null);
  await assert.rejects(service.stop([1], key), { status: 409 });
  assert.equal((await history.recent(1, 0))[0].state, 'queued');
});

test('losing the prepared tree to another worker cannot deliver an unrecorded signal', async (t) => {
  const { db, models, history } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  await history.enqueue('released', 1, 'manual', null);
  await history.start('released');
  await history.bindCommand('released', process.pid, 'released.log');
  const instance = await db.models.RunningInstance.findOne();
  await db.query(`CREATE TRIGGER drop_preparation AFTER INSERT ON CronStopRequests
    BEGIN DELETE FROM CronStopRequests WHERE instance_id=NEW.instance_id; END`);
  let received = 0;
  const submit = () =>
    history.requestInstanceStop(
      instance.id,
      process.pid,
      () => {
        received++;
      },
      ['original'],
    );
  await assert.rejects(submit(), { status: 503 });
  assert.equal(received, 0);
  assert.equal(await history.shouldStop('released'), false);
  await db.query('DROP TRIGGER drop_preparation');
  await submit();
  assert.equal(received, 1);
  assert.equal((await history.pendingStop(instance.id)).signalled, 1);
});

function retiredProcessFixtureService(db, models) {
  return new (load('back/services/cron.ts', {
    '../config': {},
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../data/cron': models,
    '../cron/execution/cronLimit': {},
    '../shared/i18n': { t: (key) => key },
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0, stopped: 2, unknown: 4 },
    },
    '../config/util': {
      killTask() {
        assert.fail('the replacement must never receive a signal');
      },
    },
  }).default)(logger);
}

for (const legacy of [false, true]) {
  test(`a cold batch retry settles its old instance while the same PID is live again (legacy=${legacy})`, async (t) => {
    const { db, history, models } = await fixture(t);
    const service = retiredProcessFixtureService(db, models);
    const task = await models.CrontabModel.create({
      id: 1,
      command: 'true',
      status: 1,
      allow_multiple_instances: 1,
    });
    const birth = systemOwner(process.pid);
    let old;
    if (legacy) {
      old = await db.models.RunningInstance.create({
        cron_id: 1,
        pid: process.pid,
        log_path: 'same.log',
        started_at: 1,
        status: 0,
      });
    } else {
      // Simulate a persisted request from before namespace_owner existed.
      await history.startSystem(
        'old',
        1,
        birth + '-old-supervisor',
        birth + '-old-command',
      );
      old = await db.models.RunningInstance.findOne();
    }
    await history.queueInstanceStop(old.id, 1, process.pid);
    await db.query(
      'UPDATE CronStopRequests SET namespace_owner=$namespace,targets=$targets WHERE instance_id=$id',
      {
        bind: {
          id: old.id,
          namespace: legacy ? 'crond:1:previous' : null,
          targets: JSON.stringify([birth + '-old-command']),
        },
      },
    );
    const key = require('node:crypto').randomUUID();
    await db.query(
      "INSERT INTO CronStopBatches(request_id,cron_ids,snapshot) VALUES ($key,'[1]',$snapshot)",
      {
        bind: {
          key,
          snapshot: JSON.stringify({
            docs: [],
            instances: [{ id: old.id, cron_id: 1, pid: process.pid }],
            cancelled: [],
            missingPids: [],
          }),
        },
      },
    );
    await history.enqueue('replacement', 1, 'manual', null);
    await history.start('replacement', Date.now(), true);
    await history.bindCommand('replacement', process.pid);
    const fresh = await db.models.RunningInstance.findOne({
      order: [['id', 'DESC']],
    });
    await db.query(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF status ON RunningInstances
      WHEN OLD.id=${old.id} BEGIN SELECT json_extract('invalid json','$'); END`);
    await assert.rejects(service.stop([1], key), /malformed JSON/i);
    assert.ok(await history.pendingStop(old.id));
    assert.equal((await old.reload()).status, 0);
    await db.query('DROP TRIGGER fail_retirement');
    await Promise.all(Array.from({ length: 8 }, () => service.stop([1], key)));
    assert.equal((await old.reload()).status, 4);
    assert.equal(old.exit_code, null);
    assert.equal((await fresh.reload()).status, 0);
    assert.equal((await task.reload()).status, 0);
    assert.equal(task.pid, process.pid);
    assert.deepEqual(await history.pendingStops(), []);
    assert.deepEqual(await history.pendingStopBatches(), []);
    if (!legacy) {
      const [row] = await db.query(
        "SELECT state,reason,counted,exit_code FROM CronTriggers WHERE id='old'",
        { type: QueryTypes.SELECT },
      );
      assert.deepEqual(row, {
        state: 'unknown',
        reason: 'restart',
        counted: 0,
        exit_code: null,
      });
    }
    await history.complete('replacement', 'finished', null, 0);
    await Promise.all([
      service.stop([1], key),
      service.stop([1, 1], key),
      history.complete('replacement', 'finished', null, 0),
    ]);
    const stats = await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
    assert.deepEqual(stats, [
      { run_count: 1, success_count: 1, fail_count: 0 },
    ]);
  });
}

test('a lost command with a live crond supervisor keeps its real exit receipt', async (t) => {
  const { db, models, history } = await fixture(t);
  const service = retiredProcessFixtureService(db, models);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  await history.startSystem(
    'exiting',
    1,
    systemOwner(process.pid),
    systemOwner(process.pid) + '-retired',
  );
  const old = await db.models.RunningInstance.findOne();
  await history.queueInstanceStop(old.id, 1, process.pid);
  assert.equal((await service.stopInstance(1, old.id)).code, 409);
  assert.equal((await history.recent(1, 0))[0].state, 'running');
  await history.complete('exiting', 'finished', null, 0);
  assert.equal((await old.reload()).status, 1);
  assert.equal(old.exit_code, 0);
  assert.equal((await service.stopInstance(1, old.id)).data.outcome, 'ended');
});

for (const receipt of ['supervisor', 'shell status', 'shell statistics']) {
  test(`late ${receipt} after unknown repairs only its instance and counts once across retries`, async (t) => {
    const { db, history, models, root } = await fixture(t);
    const peer = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(root, 'panel.sqlite'),
      logging: false,
      transactionType: Transaction.TYPES.IMMEDIATE,
    });
    t.after(() => peer.close());
    const remote = new TriggerHistory(peer);
    const task = await models.CrontabModel.create({
      id: 1,
      command: 'true',
      status: 1,
      allow_multiple_instances: 1,
    });
    await history.enqueue('old', 1, 'manual', null);
    await history.start('old');
    await history.bindCommand('old', process.pid, '/dev/null');
    if (receipt !== 'supervisor')
      await db.query("UPDATE CronTriggers SET owner=NULL WHERE id='old'");
    const old = await db.models.RunningInstance.findOne();
    const now = Date.now();
    const end = now - 86400000;
    await db.query(
      "UPDATE CronTriggers SET state='unknown',reason='restart',started_at=$start,finished_at=$end WHERE id='old'",
      { bind: { start: end - 2000, end } },
    );
    await history.reconcileInstances();
    assert.equal((await old.reload()).status, 4);
    await history.enqueue('new', 1, 'manual', null);
    await history.start('new');
    await history.bindCommand('new', process.pid, '/dev/null');
    await task.update({
      status: 0,
      pid: process.pid,
      log_path: '/dev/null',
      last_execution_time: Math.floor(now / 1000),
      last_running_time: 73,
    });
    const liveTask = (await task.reload()).toJSON();
    const service = retiredProcessFixtureService(db, models);
    const key = require('node:crypto').randomUUID();
    await db.query(
      "INSERT INTO CronStopBatches(request_id,cron_ids,snapshot) VALUES ($key,'[1]',$snapshot)",
      {
        bind: {
          key,
          snapshot: JSON.stringify({
            docs: [],
            instances: [{ id: old.id, cron_id: 1, pid: process.pid }],
            cancelled: [],
          }),
        },
      },
    );
    const status = (code) =>
      remote.reportInstance(
        'old',
        1,
        false,
        process.pid,
        '/dev/null',
        1,
        2,
        code,
      );
    const stat = (code) => history.recordShellResult('old', 1, code, 2000, now);
    const exit = () =>
      receipt === 'supervisor'
        ? remote.complete('old', 'failed', null, 17)
        : receipt === 'shell status'
        ? status(17)
        : stat(17);
    if (receipt === 'supervisor') {
      await status(0);
      await stat(0);
      assert.equal((await old.reload()).status, 4);
    }
    await db.query(
      "CREATE TRIGGER refuse_stat BEFORE INSERT ON CrontabStats BEGIN SELECT json_extract('bad','$'); END",
    );
    await assert.rejects(exit(), /malformed JSON/i);
    assert.equal((await old.reload()).status, 4);
    const read = () =>
      db.query(
        "SELECT state,exit_code,finished_at,counted FROM CronTriggers WHERE id='old'",
        { type: QueryTypes.SELECT },
      );
    assert.deepEqual(await read(), [
      { state: 'unknown', exit_code: null, finished_at: end, counted: 0 },
    ]);
    await db.query('DROP TRIGGER refuse_stat');
    await Promise.all([
      exit(),
      exit(),
      service.stop([1], key),
      service.stop([1, 1], key),
    ]);
    await Promise.all([
      remote.complete('old', 'finished', null, 0),
      stat(0),
      status(0),
      service.stop([1], key),
    ]);
    assert.deepEqual(await read(), [
      { state: 'failed', exit_code: 17, finished_at: end, counted: 1 },
    ]);
    await old.reload();
    assert.deepEqual(
      [old.status, old.exit_code, old.finished_at],
      [3, 17, Math.floor(end / 1000)],
    );
    assert.deepEqual((await task.reload()).toJSON(), liveTask);
    assert.equal(
      (await history.recent(1, 0)).find((x) => x.id === 'new').state,
      'running',
    );
    const [totals] = await db.query(
      'SELECT date,run_count,success_count,fail_count,total_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
    assert.deepEqual(totals, {
      date: require('dayjs')(end).format('YYYY-MM-DD'),
      run_count: 1,
      success_count: 0,
      fail_count: 1,
      total_time: 2000,
    });
    await history.complete('new', 'finished', null, 0);
    const after = (await task.reload()).toJSON();
    await exit();
    assert.deepEqual((await task.reload()).toJSON(), after);
  });
}

test('untagged legacy exits need a unique run when a newer instance shares the PID and log', async (t) => {
  const { db, models } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    pid: 1350,
    log_path: '/dev/null',
    last_execution_time: 202,
    last_running_time: 55,
  });
  const before = (await task.reload()).toJSON();
  const Instance = db.models.RunningInstance;
  const old = await Instance.create({
    cron_id: 1,
    pid: 1350,
    status: 4,
    log_path: '/dev/null',
    started_at: 101,
    finished_at: 150,
  });
  const fresh = await Instance.create({
    cron_id: 1,
    pid: 1350,
    status: 0,
    log_path: '/dev/null',
    started_at: 202,
  });
  const service = new (load('back/services/cron.ts', {
    '../config': {},
    '../shared/logPath': { resolveLogPath() {} },
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: Instance,
      InstanceStatus: {
        running: 0,
        finished: 1,
        stopped: 2,
        error: 3,
        unknown: 4,
      },
    },
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../cron/execution/cronLimit': {},
    '../config/util': {},
    '../shared/i18n': { t: (key) => key },
  }).default)(logger);
  const send = (seconds, code) =>
    service.status({
      ids: [1],
      status: 1,
      pid: 1350,
      log_path: '/dev/null',
      last_execution_time: seconds,
      last_running_time: 9,
      exit_code: code,
    });
  // A stale PID-only exit is still unsafe after the original row has expired.
  await old.destroy();
  await send(0, 17);
  assert.equal((await fresh.reload()).status, 0);
  await Instance.create(old.toJSON());
  await send(0, 17);
  assert.equal((await old.reload()).status, 4);
  await send(101, 17);
  await send(101, 0);
  assert.deepEqual(
    [(await old.reload()).status, old.exit_code, old.finished_at],
    [3, 17, 150],
  );
  assert.equal((await fresh.reload()).status, 0);
  assert.deepEqual((await task.reload()).toJSON(), before);
});

test('a legacy exit without a code can be resolved by a later statistics receipt', async (t) => {
  const { db, history, models } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 0 });
  const id = 'system-1-legacy';
  await history.reportInstance(id, 1, true, process.pid, 'old.log', 100, 0);
  await history.reportInstance(id, 1, false, process.pid, 'old.log', 100, 1);
  const [unknown] = await history.recent(1, 0);
  assert.equal(unknown.state, 'unknown');
  await history.recordShellResult(id, 1, 9, 1000, Date.now());
  await history.recordShellResult(id, 1, 0, 1000, Date.now());
  const [row] = await history.recent(1, 0);
  const instance = await db.models.RunningInstance.findOne();
  assert.deepEqual(
    [
      row.state,
      row.exit_code,
      row.finished_at,
      instance.status,
      instance.exit_code,
    ],
    ['failed', 9, unknown.finished_at, 3, 9],
  );
  assert.deepEqual(
    await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    ),
    [{ run_count: 1, success_count: 0, fail_count: 1 }],
  );
});

test('legacy status retries commit one receipt per physical run, including equal results and a lost response', async (t) => {
  const { db, models, history } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
  });
  const service = new (load('back/services/cron.ts', {
    '../cron/execution/cronProcess': {
      ...require('../../back/cron/execution/cronProcess'),
      legacyProcessOwner: (pid) => 'test:' + pid,
    },
    '../config': {},
    '../shared/logPath': { resolveLogPath() {} },
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: {
        running: 0,
        finished: 1,
        stopped: 2,
        error: 3,
        unknown: 4,
      },
    },
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../cron/execution/cronLimit': {},
    '../config/util': {},
    '../shared/i18n': { t: (key) => key },
  }).default)(logger);
  const send = (pid, status, code) =>
    service.status({
      ids: [1],
      status,
      pid,
      log_path: '/dev/null',
      last_execution_time: 100,
      last_running_time: status ? 2 : 0,
      exit_code: code,
    });
  await Promise.all([send(111, 0), send(111, 0)]);
  await send(222, 0);
  await db.query(
    "CREATE TRIGGER refuse_stat BEFORE INSERT ON CrontabStats BEGIN SELECT json_extract('bad','$'); END",
  );
  await assert.rejects(send(222, 1, 7), /malformed JSON/);
  assert.equal(
    (await db.models.RunningInstance.findOne({ where: { pid: 222 } })).status,
    0,
  );
  assert.deepEqual(
    (await history.recent(1, 0)).map((row) => row.state),
    ['running', 'running'],
  );
  await db.query('DROP TRIGGER refuse_stat');
  await Promise.all([send(222, 1, 7), send(222, 1, 7)]);
  await send(222, 0);
  assert.equal((await task.reload()).pid, 111);
  await send(111, 1); // An exit without a result cannot be counted as successful.
  await Promise.all([send(111, 1, 7), send(111, 1, 7)]);
  assert.equal(await db.models.RunningInstance.count(), 2);
  const rows = await history.recent(1, 0);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (r) => r.source === 'legacy' && r.state === 'failed' && r.exit_code === 7,
    ),
  );
  assert.deepEqual(
    await db.query(
      'SELECT run_count,fail_count,success_count,total_time,max_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    ),
    [
      {
        run_count: 2,
        fail_count: 2,
        success_count: 0,
        total_time: 4000,
        max_time: 2000,
      },
    ],
  );
  // A legacy wrapper belonging to a managed command is not another execution.
  await history.enqueue('managed', 1, 'manual', null);
  await history.start('managed');
  await history.bindCommand('managed', process.pid);
  const wrapperStart = Math.floor(Date.now() / 1000);
  const wrapper = (status, code) =>
    service.status({
      ids: [1],
      status,
      pid: process.pid,
      log_path: '/dev/null',
      last_execution_time: wrapperStart,
      last_running_time: 2,
      exit_code: code,
    });
  await wrapper(0);
  await wrapper(1, 9);
  assert.equal(await db.models.RunningInstance.count(), 3);
  assert.equal(
    (await history.recent(1, 0)).find((r) => r.id === 'managed').state,
    'running',
  );
  await history.complete('managed', 'finished', null, 0);
  await wrapper(0);
  await wrapper(1, 9);
  assert.equal(await db.models.RunningInstance.count(), 3);
  const [totals] = await db.query(
    'SELECT run_count,fail_count,success_count FROM CrontabStats',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(totals, { run_count: 3, fail_count: 2, success_count: 1 });
});

test('legacy start and exit delivered out of order cannot resurrect a run or overwrite its PID replacement', async (t) => {
  const { db, models, history } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
  });
  const instances = db.models.RunningInstance;
  const service = new (load('back/services/cron.ts', {
    '../cron/execution/cronProcess': {
      ...require('../../back/cron/execution/cronProcess'),
      legacyProcessOwner: (pid) => 'test:' + pid,
    },
    '../config': {},
    '../shared/logPath': { resolveLogPath() {} },
    '../data/cron': models,
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: {
        running: 0,
        finished: 1,
        stopped: 2,
        error: 3,
        unknown: 4,
      },
    },
    '../schedule/client': {},
    '../loaders/logger': logger,
    '../shared/logStreamManager': {},
    '../cron/execution/cronLimit': {},
    '../config/util': {},
    '../shared/i18n': { t: (key) => key },
  }).default)(logger);
  const now = Math.floor(Date.now() / 1000);
  const send = (seconds, status, code, trigger_id) =>
    service.status({
      ids: [1],
      status,
      pid: 31415,
      log_path: 'shared.log',
      last_execution_time: seconds,
      last_running_time: status ? 2 : 0,
      exit_code: code,
      trigger_id,
    });
  const counts = async () =>
    (
      await db.query(
        'SELECT run_count,success_count,fail_count FROM CrontabStats',
        { type: QueryTypes.SELECT },
      )
    )[0];
  await send(now, 0);
  const current = (await task.reload()).toJSON();
  for (const [seconds, id] of [
    [now - 20, undefined],
    [now - 10, 'system-cli-older'],
  ]) {
    await send(seconds, 1, 17, id);
    await Promise.all([
      send(seconds, 0, undefined, id),
      send(seconds, 0, undefined, id),
      send(seconds, 1, 0, id),
    ]);
    const row = await instances.findOne({ where: { started_at: seconds } });
    assert.ok(row);
    assert.deepEqual([row.status, row.exit_code], [3, 17]);
    assert.deepEqual((await task.reload()).toJSON(), current);
  }
  assert.equal(await instances.count({ where: { status: 0 } }), 1);
  await Promise.all([send(now, 1, 0), send(now, 0), send(now, 1, 0)]);
  assert.deepEqual(await counts(), {
    run_count: 3,
    success_count: 1,
    fail_count: 2,
  });
  assert.equal((await task.reload()).status, 1);
  // The newer start is proof that the old PID has exited even if its exit packet is delayed.
  await send(now + 1, 0);
  await send(now + 2, 0);
  assert.deepEqual(
    (await instances.findAll({ where: { status: 0 } })).map(
      (row) => row.started_at,
    ),
    [now + 2],
  );
  assert.equal(
    (await instances.findOne({ where: { started_at: now + 1 } })).status,
    4,
  );
  await Promise.all([send(now + 1, 0), send(now + 1, 1, 9)]);
  assert.equal((await task.reload()).last_execution_time, now + 2);
  await send(now + 2, 1, 0);
  const finalCounts = { run_count: 5, success_count: 2, fail_count: 3 };
  assert.deepEqual(await counts(), finalCounts);
  const cutoff = (now + 3) * 1000;
  await db.transaction(async (tx) => {
    await instances.destroy({ where: {}, transaction: tx });
    await history.deleteExpired(cutoff, tx);
  });
  await Promise.all([
    send(now - 20, 0),
    send(now - 20, 1, 17),
    send(now - 10, 0, undefined, 'system-cli-older'),
  ]);
  assert.equal(await instances.count(), 0);
  assert.equal((await history.recent(1, 0)).length, 0);
  assert.deepEqual(await counts(), finalCounts);
});

test('a legacy start with a dead or newer PID is historical even before the replacement reports', async (t) => {
  const { history, db, models } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
  });
  for (const pid of [process.pid, 2147483000]) {
    await history.reportLegacy(1, true, pid, 'shared.log', 100, 0);
    assert.equal(
      (await db.models.RunningInstance.findOne({ where: { pid } })).status,
      4,
    );
    assert.equal((await task.reload()).status, 1);
    await history.reportLegacy(1, false, pid, 'shared.log', 100, 1, 17);
    await history.reportLegacy(1, true, pid, 'shared.log', 100, 0);
  }
  assert.deepEqual(
    (await history.recent(1, 0)).map((row) => [row.state, row.exit_code]),
    [
      ['failed', 17],
      ['failed', 17],
    ],
  );
  assert.deepEqual(
    await db.query('SELECT run_count,fail_count FROM CrontabStats', {
      type: QueryTypes.SELECT,
    }),
    [{ run_count: 2, fail_count: 2 }],
  );
});

test('two identified executions and one legacy execution can share a task, PID, second and log', async (t) => {
  const { db, models, history } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  const pid = process.pid,
    log = 'same.log',
    seconds = Math.floor(Date.now() / 1000);
  const ids = Array.from(
    { length: 2 },
    () => 'client-' + require('node:crypto').randomUUID(),
  );
  const tagged = (id, running, code) =>
    history.reportInstance(id, 1, running, pid, log, seconds, 0, code);
  const legacy = (running, code) =>
    history.reportLegacy(1, running, pid, log, seconds, 0, code);
  await tagged(ids[0], true);
  await legacy(true);
  await tagged(ids[1], false, 0); // exit beats the initial start
  await Promise.all([
    tagged(ids[1], true),
    legacy(false, 17),
    tagged(ids[0], true),
  ]);
  await Promise.all([
    tagged(ids[0], false, 0),
    legacy(true),
    legacy(false, 17),
    history.recordShellResult(ids[1], 1, 0, 0, Date.now()),
  ]);
  await history.recordShellResult(ids[0], 1, 0, 0, Date.now());
  const rows = await db.query(
    'SELECT t.source,t.id,t.state,t.counted,i.exit_code,i.status FROM CronTriggers t JOIN RunningInstances i ON t.instance_id=i.id',
    { type: QueryTypes.SELECT },
  );
  assert.equal(rows.length, 3);
  for (const id of ids)
    assert.deepEqual(
      rows.find((r) => r.id === id),
      {
        source: 'client',
        id,
        state: 'finished',
        counted: 1,
        exit_code: 0,
        status: 1,
      },
    );
  assert.deepEqual(
    rows
      .filter((r) => r.source === 'legacy')
      .map((r) => [r.state, r.counted, r.exit_code, r.status]),
    [['failed', 1, 17, 3]],
  );
  assert.deepEqual(
    await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    ),
    [{ run_count: 3, success_count: 2, fail_count: 1 }],
  );
});

test('when a later run exits first its start remains the last run time while an earlier instance stays active', async (t) => {
  const { history, models } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
  });
  const [early, late] = [1, 2].map(
    () => 'client-' + require('node:crypto').randomUUID(),
  );
  const send = (id, running, pid, log, start) =>
    history.reportInstance(
      id,
      1,
      running,
      pid,
      log,
      start,
      running ? 0 : id === late ? 7 : 15,
      running ? undefined : 0,
    );
  await send(early, true, 88801, 'early.log', 100);
  await send(late, true, 88802, 'late.log', 101);
  await send(late, false, 88802, 'late.log', 101);
  await task.reload();
  assert.deepEqual(
    [task.pid, task.log_path, task.last_execution_time],
    [88801, 'early.log', 101],
  );
  await send(early, false, 88801, 'early.log', 100);
  await task.reload();
  assert.deepEqual(
    [task.status, task.last_execution_time, task.last_running_time],
    [1, 101, 7],
  );
});

test('same-second summaries stay with the last observed start through late exits, zero elapsed and retries', async (t) => {
  const { db, history, models } = await fixture(t);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    last_execution_time: 5,
    last_running_time: 90,
  });
  const second = Math.floor(Date.now() / 1000);
  const pid = process.pid,
    log = 'mixed.log';
  const id = () => 'client-' + require('node:crypto').randomUUID();
  const newest = id(),
    exitFirst = id();
  const tagged = (key, running, elapsed, sec = second) =>
    history.reportInstance(
      key,
      1,
      running,
      pid,
      log,
      sec,
      elapsed,
      running ? undefined : 0,
    );
  const old = (running, elapsed) =>
    history.reportLegacy(
      1,
      running,
      pid,
      log,
      second,
      elapsed,
      running ? undefined : 17,
    );
  const summary = async () => {
    await task.reload();
    return [
      task.last_execution_time,
      task.last_running_time,
      task.last_instance_id,
    ];
  };
  await old(true, 0);
  await tagged(newest, true, 0);
  const [record] = await db.query(
    'SELECT instance_id FROM CronTriggers WHERE id=$id',
    { bind: { id: newest }, type: QueryTypes.SELECT },
  );
  const expected = [second, null, record.instance_id];
  assert.deepEqual(await summary(), expected);
  await old(false, 19);
  await tagged(exitFirst, false, 50);
  await tagged(exitFirst, true, 0);
  assert.deepEqual(await summary(), expected);
  await tagged(newest, false, 0);
  await history.recordShellResult(newest, 1, 0, 75000, Date.now());
  await old(false, 19);
  assert.deepEqual(await summary(), [second, 0, record.instance_id]);
  const next = id();
  await tagged(next, false, 27, second + 1);
  await tagged(next, true, 0, second + 1);
  assert.deepEqual((await summary()).slice(0, 2), [second + 1, 27]);
  assert.deepEqual(
    await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    ),
    [{ run_count: 4, success_count: 3, fail_count: 1 }],
  );
});

test('panel upgrade adopts outstanding legacy instances and a delayed exit settles its original row', async (t) => {
  const { db, models, history } = await fixture(t);
  const start = Math.floor(Date.now() / 1000);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    last_running_time: 58,
    last_execution_time: start,
  });
  const prior = await db.models.RunningInstance.create({
    cron_id: 1,
    status: 0,
    pid: process.pid,
    log_path: 'old.log',
    started_at: start,
  });
  const dead = await db.models.RunningInstance.create({
    cron_id: 1,
    status: 0,
    pid: 2147483000,
    log_path: 'gone.log',
    started_at: start - 5,
  });
  await history.reconcileInstances();
  await history.reconcileInstances();
  assert.equal((await prior.reload()).status, 0);
  assert.equal((await dead.reload()).status, 4);
  await history.reportLegacy(
    1,
    false,
    dead.pid,
    dead.log_path,
    start - 5,
    38,
    17,
  );
  await history.reportLegacy(1, false, process.pid, 'old.log', start, 6, 0);
  await history.reportLegacy(1, false, process.pid, 'old.log', start, 6, 0);
  assert.equal(await db.models.RunningInstance.count(), 2);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => r.state),
    ['finished', 'failed'],
  );
  assert.deepEqual(
    [(await task.reload()).last_instance_id, task.last_running_time],
    [prior.id, 6],
  );
  assert.deepEqual(
    await db.query(
      'SELECT run_count,success_count,fail_count FROM CrontabStats',
      { type: QueryTypes.SELECT },
    ),
    [{ run_count: 2, success_count: 1, fail_count: 1 }],
  );
});

for (const newStartsFirst of [true, false]) {
  test(`same-second upgrade reconciles settled, gone and live siblings when the new start arrives ${
    newStartsFirst ? 'before' : 'after'
  } adoption`, async (t) => {
    const { history, db, models, stats } = await fixture(t);
    const second = Math.floor(Date.now() / 1000) - 1;
    const task = await models.CrontabModel.create({
      id: 1,
      command: 'true',
      status: 0,
      last_execution_time: second,
    });
    const instances = db.models.RunningInstance;
    const create = (pid, log_path, status = 0, extra = {}) =>
      instances.create({
        cron_id: 1,
        started_at: second,
        pid,
        log_path,
        status,
        ...extra,
      });
    const gone = await create(2147483000, 'shared.log');
    const live = await create(process.pid, 'shared.log');
    const settled = await create(2147483001, 'shared.log', 1, {
      finished_at: second + 1,
      exit_code: 0,
    });
    await stats.CrontabStatModel.create({
      ref_id: 1,
      date: require('dayjs')().format('YYYY-MM-DD'),
      run_count: 1,
      success_count: 1,
    });
    const key = 'client-' + require('node:crypto').randomUUID();
    const reportNew = (running) =>
      history.reportInstance(
        key,
        1,
        running,
        88802,
        'new.log',
        second,
        running ? 0 : 2,
        running ? undefined : 0,
      );
    const reportOld = (row, elapsed, code) =>
      history.reportLegacy(
        1,
        false,
        row.pid,
        row.log_path,
        second,
        elapsed,
        code,
      );
    if (newStartsFirst) await reportNew(true);
    await history.reconcileInstances();
    const snapshot = async () =>
      db.query(
        `SELECT instance_id,state,counted,exit_code FROM CronTriggers
      ORDER BY instance_id`,
        { type: QueryTypes.SELECT },
      );
    assert.deepEqual(
      (await snapshot())
        .slice(0, 3)
        .map((r) => [r.instance_id, r.state, r.counted]),
      [
        [gone.id, 'unknown', 0],
        [live.id, 'running', 0],
        [settled.id, 'finished', 1],
      ],
    );
    await task.reload();
    if (!newStartsFirst) {
      assert.deepEqual(
        [task.last_instance_id, task.last_running_time, task.pid],
        [settled.id, 1, live.pid],
      );
      await reportNew(true);
    }
    const current = await instances.findOne({ where: { pid: 88802 } });
    await task.reload();
    assert.deepEqual(
      [task.last_instance_id, task.last_running_time, task.pid, task.log_path],
      [current.id, null, 88802, 'new.log'],
    );
    await reportNew(false);
    assert.deepEqual(
      [(await task.reload()).pid, task.last_running_time],
      [live.pid, 2],
    );
    await Promise.all([
      reportOld(gone, 27, 17),
      reportOld(live, 33, 9),
      reportOld(settled, 51, 17),
      history.reconcileInstances(),
      reportOld(gone, 27, 17),
      reportOld(live, 33, 9),
    ]);
    await history.reconcileInstances();
    assert.deepEqual(
      (await snapshot()).map((r) => [
        r.instance_id,
        r.state,
        r.counted,
        r.exit_code,
      ]),
      [
        [gone.id, 'failed', 1, 17],
        [live.id, 'failed', 1, 9],
        [settled.id, 'finished', 1, 0],
        [current.id, 'finished', 1, 0],
      ],
    );
    await task.reload();
    assert.deepEqual(
      [
        task.status,
        task.pid,
        task.last_execution_time,
        task.last_instance_id,
        task.last_running_time,
      ],
      [1, null, second, current.id, 2],
    );
    assert.deepEqual(
      await db.query(
        'SELECT run_count,success_count,fail_count FROM CrontabStats',
        { type: QueryTypes.SELECT },
      ),
      [{ run_count: 4, success_count: 2, fail_count: 2 }],
    );
  });
}

test('an exit delivered before adoption keeps the original start order and elapsed time', async (t) => {
  const { history, db, models } = await fixture(t);
  const second = Math.floor(Date.now() / 1000);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 0,
    last_execution_time: second,
  });
  const first = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: process.pid,
    started_at: second,
    log_path: 'first.log',
  });
  const last = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: 2147483000,
    started_at: second,
    log_path: 'last.log',
  });
  await history.reportLegacy(1, false, last.pid, last.log_path, second, 7, 17);
  await history.reconcileInstances();
  await history.reportLegacy(1, true, last.pid, last.log_path, second, 0);
  await history.reportLegacy(1, false, last.pid, last.log_path, second, 99, 0);
  await task.reload();
  assert.deepEqual(
    [
      task.pid,
      task.log_path,
      task.last_instance_id,
      task.last_execution_time,
      task.last_running_time,
    ],
    [first.pid, first.log_path, last.id, second, 7],
  );
  assert.deepEqual(
    (await history.recent(1, 0))
      .map((r) => [r.log_path, r.state, r.exit_code])
      .sort(),
    [
      ['first.log', 'running', null],
      ['last.log', 'failed', 17],
    ],
  );
  assert.deepEqual(
    await db.query('SELECT run_count,fail_count FROM CrontabStats', {
      type: QueryTypes.SELECT,
    }),
    [{ run_count: 1, fail_count: 1 }],
  );
});

test('upgrade repairs missing anonymous daily counts once without replaying elapsed time or a new client', async (t) => {
  const { db, models, stats, history } = await fixture(t);
  const { migrateSchema } = require('../../back/data/schemaMigrations');
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  const task = await models.CrontabModel.create({
    id: 1,
    command: 'true',
    status: 1,
    isDisabled: 0,
  });
  const now = Math.floor(Date.now() / 1000);
  const day = require('dayjs')(now * 1000).format('YYYY-MM-DD');
  const ended = async (pid, code) =>
    db.models.RunningInstance.create({
      cron_id: 1,
      pid,
      started_at: now - 3,
      finished_at: now,
      log_path: 'shared.log',
      status: code ? 3 : 1,
      exit_code: code,
    });
  await ended(101, 0);
  await ended(102, 0);
  await ended(103, 17);
  await ended(104, null);
  await ended(105, 0);
  await ended(105, 0); // Repeated anonymous start proves one additional exit.
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: day,
    run_count: 1,
    success_count: 1,
    total_time: 9000,
    max_time: 9000,
  });
  const key = 'client-' + require('node:crypto').randomUUID();
  await history.reportInstance(key, 1, true, 106, 'new.log', now, 0);
  await history.reportInstance(key, 1, false, 106, 'new.log', now, 2, 0);
  const query = () =>
    db.query(
      'SELECT run_count,success_count,fail_count,untimed_count,total_time,max_time FROM CrontabStats',
      { type: QueryTypes.SELECT },
    );
  await db.query(
    "CREATE TRIGGER reject_daily_repair BEFORE UPDATE ON CrontabStats BEGIN SELECT RAISE(ABORT,'repair failed'); END",
  );
  await assert.rejects(migrateSchema(db), (error) =>
    /repair failed/.test(error.original?.message),
  );
  assert.equal((await history.recent(1, 0)).length, 1);
  await db.query('DROP TRIGGER reject_daily_repair');
  await Promise.all([migrateSchema(db), migrateSchema(db)]);
  await Promise.all([
    history.reportLegacy(1, false, 103, 'shared.log', now - 3, 10, 17),
    history.reportLegacy(1, false, 102, 'shared.log', now - 3, 10, 0),
    history.recordShellResult(key, 1, 0, 2000, Date.now()),
  ]);
  assert.deepEqual(await query(), [
    {
      run_count: 5,
      success_count: 4,
      fail_count: 1,
      untimed_count: 3,
      total_time: 11000,
      max_time: 9000,
    },
  ]);
  assert.deepEqual(
    [(await task.reload()).last_execution_time, task.last_running_time],
    [now, 2],
  );
  assert.equal(
    (await history.recent(1, 0)).filter((r) => r.exit_code === 17).length,
    1,
  );
  const router = express.Router();
  load('back/api/dashboard.ts', {
    '../data/cron': models,
    '../data/cronStats': stats,
    '../data/runningInstance': {},
    '../shared/i18n': {
      t: (key) => key,
      tf: (format, id) => format.replace('%s', id),
    },
  }).default(router);
  const routes = router.stack[0].handle.stack;
  for (const path of ['/overview', '/top-time', '/top-count', '/labels']) {
    const handler = routes.find((entry) => entry.route?.path === path).route
      .stack[0].handle;
    let data;
    await handler(
      {},
      {
        send: (result) => {
          data = result.data;
        },
      },
      (error) => {
        throw error;
      },
    );
    assert.equal((Array.isArray(data) ? data[0] : data).avgTime, 5500, path);
  }
  await stats.CrontabStatModel.destroy({ where: { ref_id: 1 } });
  await migrateSchema(db);
  assert.deepEqual(await query(), []); // A later retention cleanup stays effective.
});

test('upgrade spends a later anonymous count once per outcome and respects prior cleanup', async (t) => {
  const { db, models, stats } = await fixture(t);
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  await models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  const day = require('dayjs')().startOf('day');
  let pid = 100;
  async function exits(ago, count, code) {
    const end = day.subtract(ago, 'day').add(1, 'second').unix();
    for (let i = 0; i < count; i++)
      await db.models.RunningInstance.create({
        cron_id: 1,
        pid: ++pid,
        started_at: end - 5,
        finished_at: end,
        log_path: 'legacy.log',
        status: code ? 3 : 1,
        exit_code: code,
      });
  }
  async function daily(ago, success, fail) {
    return stats.CrontabStatModel.create({
      ref_id: 1,
      date: day.subtract(ago, 'day').format('YYYY-MM-DD'),
      run_count: success + fail,
      success_count: success,
      fail_count: fail,
    });
  }
  await daily(3, 1, 0);
  await daily(0, 2, 3);
  await exits(4, 2, 0);
  await exits(3, 4, 0);
  await exits(2, 3, 0);
  await exits(1, 1, 0);
  await exits(0, 1, 0);
  await exits(1, 1, 17);
  await require('../../back/data/schemaMigrations').migrateSchema(db);
  const rows = await db.query(
    'SELECT date,run_count,success_count,fail_count FROM CrontabStats ORDER BY date',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    rows.map((r) => [r.date, r.run_count, r.success_count, r.fail_count]),
    [
      [3, 4, 4, 0],
      [2, 3, 3, 0],
      [0, 5, 2, 3],
    ].map(([ago, ...counts]) => [
      day.subtract(ago, 'day').format('YYYY-MM-DD'),
      ...counts,
    ]),
  );
});

test('already upgraded databases reconcile multi-day evidence against an independent one-use receipt matching model', async (t) => {
  const { db, models, stats } = await fixture(t);
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  await db.query('DELETE FROM SchemaMigrations');
  await db.query(
    "INSERT INTO SchemaMigrations VALUES ('repair-legacy-daily-statistics-v1',CURRENT_TIMESTAMP)",
  );
  const dates = Array.from({ length: 3 }, (_, i) =>
    require('dayjs')()
      .startOf('day')
      .subtract(2 - i, 'day'),
  );
  const crons = [],
    instances = [],
    saved = [],
    expected = [];
  // The oracle removes individual receipts. Nearest eligible exits take priority
  // and recorded daily totals are preserved, including pre-upgrade duplicates.
  for (let mask = 0; mask < 216; mask++) {
    const cron_id = mask + 1;
    crons.push({ id: cron_id, command: String(cron_id), status: 1 });
    const exits = dates.map((_, i) => 1 + Number(Boolean(mask & (1 << i))));
    const reports = dates.map(
      (_, i) => Math.floor(Math.floor(mask / 8) / 3 ** i) % 3,
    );
    const available = reports.flatMap((count, day) => Array(count).fill(day));
    const repaired = reports.slice();
    for (let day = 2; day >= 0; day--) {
      for (let n = 0; n < exits[day]; n++) {
        const receipt = available.findIndex((arrived) => arrived >= day);
        if (receipt < 0) repaired[day]++;
        else available.splice(receipt, 1);
        const end = dates[day].add(12, 'hour').unix();
        instances.push({
          cron_id,
          pid: 200 + n,
          started_at: end - 2,
          finished_at: end,
          status: 1,
          exit_code: 0,
        });
      }
      // Retain an explicit row even for a zero-count day. Missing rows after v1
      // have no deletion provenance and are tested separately.
      saved.push({
        ref_id: cron_id,
        date: dates[day].format('YYYY-MM-DD'),
        run_count: reports[day],
        success_count: reports[day],
      });
      expected.push([cron_id, dates[day].format('YYYY-MM-DD'), repaired[day]]);
    }
  }
  await models.CrontabModel.bulkCreate(crons);
  await db.models.RunningInstance.bulkCreate(instances);
  await stats.CrontabStatModel.bulkCreate(saved);
  // v1 has already imported some rows and counted one provably missing exit.
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,exit_code,counted) SELECT 'legacy-db-'||id,cron_id,'legacy','finished',started_at*1000,started_at*1000,finished_at*1000,id,0,1 FROM RunningInstances WHERE cron_id=1",
  );
  await stats.CrontabStatModel.update(
    { run_count: 1, success_count: 1, untimed_count: 1 },
    { where: { ref_id: 1, date: dates[2].format('YYYY-MM-DD') } },
  );
  const { migrateSchema } = require('../../back/data/schemaMigrations');
  await Promise.all([migrateSchema(db), migrateSchema(db)]);
  const rows = await db.query(
    'SELECT ref_id,date,success_count FROM CrontabStats ORDER BY ref_id,date DESC',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(rows.map(Object.values), expected);
  assert.equal(await db.models.RunningInstance.count(), instances.length);
  const [count] = await db.query('SELECT COUNT(*) AS n FROM CronTriggers', {
    type: QueryTypes.SELECT,
  });
  assert.equal(count.n, instances.length);
});

test('duplicate bookings cannot cover future starts; later anonymous credit is spent once', async (t) => {
  const { db, models, stats } = await fixture(t);
  const { migrateSchema } = require('../../back/data/schemaMigrations');
  const {
    readDailyResults,
  } = require('../../back/cron/settlement/legacyDailyStatistics');
  const today = require('dayjs')().startOf('day');
  const yesterday = today.subtract(1, 'day');
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  await db.query('DELETE FROM SchemaMigrations');
  await db.query(
    "INSERT INTO SchemaMigrations VALUES ('repair-legacy-daily-statistics-v2',CURRENT_TIMESTAMP)",
  );
  for (const id of [1, 2, 3]) {
    await models.CrontabModel.create({ id, command: 'true' });
    const booked = yesterday.add(10, 'hour');
    // Three starts precede or share the last booking second, two start later.
    for (const [index, offset] of [-9, -5, 0, 2, 5].entries()) {
      const started = booked.add(offset, 'second');
      const instance = await db.models.RunningInstance.create({
        cron_id: id,
        pid: 100 + index,
        started_at: started.unix(),
        finished_at: started.unix() + 1,
        status: 1,
        exit_code: 0,
      });
      await db.query(
        'UPDATE RunningInstances SET createdAt=$stamp WHERE id=$id',
        {
          bind: { stamp: started.toISOString(), id: instance.id },
        },
      );
    }
    const row = await stats.CrontabStatModel.create({
      ref_id: id,
      date: yesterday.format('YYYY-MM-DD'),
      success_count: 5,
      run_count: 5,
      total_time: 5000,
      max_time: 1000,
    });
    await db.query(
      'UPDATE CrontabStats SET createdAt=$stamp,updatedAt=$stamp WHERE id=$id',
      {
        bind: {
          id: row.id,
          stamp: id === 3 ? 'unknown' : booked.add(900, 'ms').toISOString(),
        },
      },
    );
    if (id === 2)
      await stats.CrontabStatModel.create({
        ref_id: id,
        date: today.format('YYYY-MM-DD'),
        run_count: 1,
        success_count: 1,
      });
  }
  await migrateSchema(db);
  await migrateSchema(db);
  const rows = await db.query(
    'SELECT ref_id,success_count,untimed_count,total_time FROM CrontabStats WHERE date=$day ORDER BY ref_id',
    { type: QueryTypes.SELECT, bind: { day: yesterday.format('YYYY-MM-DD') } },
  );
  assert.deepEqual(rows.map(Object.values), [
    [1, 7, 2, 5000],
    [2, 6, 1, 5000],
    [3, 5, 0, 5000],
  ]);
  const results = await readDailyResults(db, 2);
  assert.deepEqual(
    results.map((r) => [
      r.day,
      r.exitSuccess,
      r.exitFail,
      r.bookedSuccess,
      r.bookedFail,
      r.supplement,
    ]),
    [
      [today.format('YYYY-MM-DD'), 0, 0, 1, 0, 0],
      [yesterday.format('YYYY-MM-DD'), 5, 0, 6, 0, 1],
    ],
  );
});

test('v3 keeps v2 statistics cleanup and rejects ambiguous settled PID siblings on replay', async (t) => {
  const { db, models, history } = await fixture(t);
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const now = Math.floor(Date.now() / 1000);
  for (const [pid, log, start] of [
    [101, 'kept', now - 8],
    [102, 'a', now - 6],
    [102, 'b', now - 4],
  ]) {
    await db.models.RunningInstance.create({
      cron_id: 1,
      pid,
      started_at: start,
      finished_at: now,
      status: 1,
      log_path: log,
      exit_code: 0,
    });
  }
  const { migrateSchema } = require('../../back/data/schemaMigrations');
  await db.query('DELETE FROM SchemaMigrations');
  await db.query(
    "INSERT INTO SchemaMigrations VALUES ('repair-legacy-daily-statistics-v2',CURRENT_TIMESTAMP)",
  );
  await migrateSchema(db);
  await Promise.all([
    history.reportLegacy(1, false, 102, 'a', now - 6, 6, 0),
    history.reportLegacy(1, false, 102, 'b', now - 4, 4, 0),
  ]);
  assert.deepEqual(
    (await history.recent(1, 0)).map((row) => row.log_path),
    ['kept'],
  );
  assert.equal(await db.models.CrontabStat.count(), 0);
});

test('daily verified exits distinguish a spawn failure and previously adopted ambiguous legacy rows', async (t) => {
  const { db, stats } = await fixture(t);
  const second = Math.floor(Date.now() / 1000) - 5;
  const ms = second * 1000;
  for (const [id, source, state, reason, code, instance] of [
    ['spawn', 'node', 'failed', 'spawn', null, null],
    ['signal', 'node', 'failed', 'SIGTERM', null, null],
    ['first', 'legacy', 'finished', null, 0, 1],
    ['second', 'legacy', 'finished', null, 0, 2],
    ['identified', 'client', 'finished', null, 0, 3],
  ]) {
    if (instance)
      await db.models.RunningInstance.create({
        id: instance,
        cron_id: 1,
        pid: 44,
        started_at: second - instance,
        finished_at: second,
        status: 1,
        log_path: id,
        exit_code: 0,
      });
    await db.query(
      `INSERT INTO CronTriggers(id,cron_id,source,state,reason,started_at,observed_at,finished_at,exit_code,instance_id,counted)
      VALUES ($id,1,$source,$state,$reason,$start,$start,$ms,$code,$instance,1)`,
      {
        bind: {
          id,
          source,
          state,
          reason,
          code,
          instance,
          ms,
          start: ms - (instance || 1) * 1000,
        },
      },
    );
  }
  const day = require('dayjs')(ms).format('YYYY-MM-DD');
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: day,
    run_count: 5,
    success_count: 3,
    fail_count: 2,
  });
  assert.deepEqual(
    await require('../../back/cron/settlement/legacyDailyStatistics').readDailyResults(
      db,
      1,
    ),
    [
      {
        day,
        exitSuccess: 1,
        exitFail: 1,
        bookedSuccess: 3,
        bookedFail: 2,
        supplement: 0,
      },
    ],
  );
});

test('a separately identified execution cannot hide an unlinked legacy exit sharing its PID and finish second', async (t) => {
  const { db, models } = await fixture(t);
  for (const table of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const end = Math.floor(Date.now() / 1000);
  const old = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: 71,
    log_path: 'old',
    started_at: end - 3,
    finished_at: end,
    status: 1,
    exit_code: 0,
  });
  const tagged = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: 71,
    log_path: 'tagged',
    started_at: end,
    finished_at: end,
    status: 1,
    exit_code: 0,
  });
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,instance_id,source,state,observed_at,started_at,finished_at,exit_code,counted) VALUES ('tagged',1,$instance,'client','finished',$end,$end,$end,0,1)",
    { bind: { instance: tagged.id, end: end * 1000 } },
  );
  await require('../../back/data/schemaMigrations').migrateSchema(db);
  assert.deepEqual(
    await db.query(
      'SELECT instance_id FROM CronTriggers ORDER BY instance_id',
      { type: QueryTypes.SELECT },
    ),
    [{ instance_id: old.id }, { instance_id: tagged.id }],
  );
});

test('statistics cleanup persists its own cutoff and a delayed unknown exit cannot reopen a cleaned day', async (t) => {
  const { db, models, stats, history } = await fixture(t);
  const day = require('dayjs')().startOf('day');
  const expired = day.subtract(3, 'day');
  const cutoff = day.subtract(1, 'day');
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const key = 'client-' + require('node:crypto').randomUUID();
  await history.reportInstance(key, 1, true, 123, 'old.log', expired.unix(), 0);
  await db.query(
    "UPDATE CronTriggers SET state='unknown',finished_at=$end WHERE id=$key",
    { bind: { key, end: expired.add(10, 'minute').valueOf() } },
  );
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: expired.format('YYYY-MM-DD'),
    run_count: 2,
    success_count: 2,
    untimed_count: 1,
  });
  const Service = load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default;
  const cleanup = (days) =>
    new Service().cleanup({
      cronStatRetentionDays: days,
      runningInstanceRetentionDays: 0,
    });
  await db.query(
    "CREATE TRIGGER reject_stat_cutoff BEFORE INSERT ON CronStatRetention BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  await assert.rejects(cleanup(1), (error) =>
    error.original?.message.includes('test rollback'),
  );
  assert.equal(await stats.CrontabStatModel.count(), 1);
  await db.query('DROP TRIGGER reject_stat_cutoff');
  await cleanup(1);
  await cleanup(30);
  await Promise.all([
    history.recordShellResult(key, 1, 17, 1000, Date.now()),
    history.reportInstance(
      key,
      1,
      false,
      123,
      'old.log',
      expired.unix(),
      1,
      17,
    ),
  ]);
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.state, row.finished_at],
    ['failed', expired.add(10, 'minute').valueOf()],
  );
  // An independently retried statistics packet must also use the stored end.
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,started_at,finished_at,exit_code) VALUES ('unclaimed',1,'client','finished',$start,$start,$end,0)",
    {
      bind: { start: expired.valueOf(), end: expired.add(1, 'hour').valueOf() },
    },
  );
  await history.recordShellResult('unclaimed', 1, 0, 1000, Date.now());
  assert.equal(await stats.CrontabStatModel.count(), 0);
  // A live process that started before the cutoff may still finish today.
  const live = 'client-' + require('node:crypto').randomUUID();
  await history.reportInstance(
    live,
    1,
    true,
    124,
    'live.log',
    expired.unix(),
    0,
  );
  await history.reportInstance(
    live,
    1,
    false,
    124,
    'live.log',
    expired.unix(),
    1,
    0,
  );
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((row) => [
      row.date,
      row.run_count,
    ]),
    [[day.format('YYYY-MM-DD'), 1]],
  );
  assert.deepEqual(
    await db.query('SELECT first_day FROM CronStatRetention', {
      type: QueryTypes.SELECT,
    }),
    [{ first_day: cutoff.format('YYYY-MM-DD') }],
  );
});

test('an expired unknown orphan or an undated standalone retry cannot recreate a pruned trigger', async (t) => {
  const { db, models, history } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const now = Math.floor(Date.now() / 1000) - 5,
    start = now - 10,
    cutoff = now * 1000 + 500;
  await db.models.RunningInstance.create({
    cron_id: 1,
    pid: 44,
    log_path: 'expired',
    started_at: start,
    finished_at: now,
    status: 4,
  });
  const key = 'client-' + require('node:crypto').randomUUID();
  await history.reportInstance(key, 1, false, 88, 'tagged', start, 1, 0);
  await db.query('UPDATE CronTriggers SET finished_at=$time WHERE id=$key', {
    bind: { time: now * 1000, key },
  });
  await db.transaction((tx) => history.deleteExpired(cutoff, tx));
  const count = await db.models.CrontabStat.count();
  await Promise.all([
    history.reportLegacy(1, false, 44, 'expired', start, 1, 0),
    history.reportInstance(key, 1, false, 88, 'tagged', 0, 1, 0),
  ]);
  assert.deepEqual(await history.recent(1, 0), []);
  assert.equal(await db.models.CrontabStat.count(), count);
});

test('v1 upgrade after deleting a previously supplemented day does not issue that supplement again', async (t) => {
  const { db, models, stats } = await fixture(t);
  for (const name of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY)`);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const day = require('dayjs')().startOf('day').subtract(1, 'day');
  const i = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: 22,
    started_at: day.unix(),
    finished_at: day.unix() + 1,
    status: 1,
    exit_code: 0,
  });
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,instance_id,source,state,observed_at,started_at,finished_at,exit_code,counted) VALUES ('legacy-db-'||$id,1,$id,'legacy','finished',$start,$start,$end,0,1)",
    { bind: { id: i.id, start: day.valueOf(), end: day.valueOf() + 1000 } },
  );
  await db.query('DELETE FROM SchemaMigrations');
  await db.query(
    "INSERT INTO SchemaMigrations VALUES ('repair-legacy-daily-statistics-v1',CURRENT_TIMESTAMP)",
  );
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: day.format('YYYY-MM-DD'),
    run_count: 1,
    success_count: 1,
    untimed_count: 1,
  });
  await stats.CrontabStatModel.destroy({ where: { ref_id: 1 } });
  await require('../../back/data/schemaMigrations').migrateSchema(db);
  assert.equal(await stats.CrontabStatModel.count(), 0);
});

test('upgrading a v3 database with old statistics cleanup protects a retained unknown from its first late exit', async (t) => {
  const { db, models, stats, history } = await fixture(t);
  for (const name of ['Envs', 'Subscriptions', 'CrontabViews'])
    await db.query(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY)`);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const today = require('dayjs')().startOf('day'),
    old = today.subtract(3, 'day');
  await db.query('DELETE FROM SchemaMigrations');
  await db.query(
    "INSERT INTO SchemaMigrations VALUES ('repair-legacy-daily-statistics-v3',CURRENT_TIMESTAMP)",
  );
  await db.query(
    "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,started_at,finished_at) VALUES ('pending',1,'client','unknown',$old,$old,$end)",
    {
      bind: { old: old.valueOf(), end: old.add(5, 'minute').valueOf() },
    },
  );
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: today.format('YYYY-MM-DD'),
    run_count: 1,
    success_count: 1,
  });
  await require('../../back/data/schemaMigrations').migrateSchema(db);
  await Promise.all([
    history.recordShellResult('pending', 1, 0, 300000, Date.now()),
    history.recordShellResult('pending', 1, 0, 300000, Date.now()),
  ]);
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [r.date, r.run_count]),
    [[today.format('YYYY-MM-DD'), 1]],
  );
  assert.equal((await history.recent(1, 0))[0].state, 'finished');
});

test('cleanup uses one precision and cutoff for a linked exit on the boundary second', async (t) => {
  const { db, stats } = await fixture(t);
  const now = new Date(2026, 10, 19, 0, 0, 0, 900);
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const boundary = new Date(2026, 10, 18, 0, 0, 0).getTime();
  const instances = db.models.RunningInstance;
  for (const [id, end] of [
    ['expired', boundary - 1],
    ['boundary', boundary + 100],
  ]) {
    const instance = await instances.create({
      cron_id: 1,
      pid: 42,
      started_at: boundary / 1000 - 100,
      finished_at: Math.floor(end / 1000),
      status: 1,
      exit_code: 0,
    });
    await db.query(
      "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,counted) VALUES ($id,1,'manual','finished',$start,$start,$end,$instance,1)",
      { bind: { id, start: boundary - 100000, end, instance: instance.id } },
    );
  }
  const Service = load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: instances,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default;
  const service = new Service();
  const policy = { runningInstanceRetentionDays: 1, cronStatRetentionDays: 1 };
  const preview = await service.preview(policy);
  assert.deepEqual([preview.runningInstances, preview.triggers], [1, 1]);
  const result = await service.cleanup(policy);
  assert.deepEqual(
    [result.deleted.runningInstances, result.deleted.triggers],
    [1, 1],
  );
  assert.equal(await instances.count(), 1);
  assert.deepEqual(
    await db.query(
      'SELECT t.id FROM CronTriggers t JOIN RunningInstances i ON i.id=t.instance_id',
      { type: QueryTypes.SELECT },
    ),
    [{ id: 'boundary' }],
  );
});

test('a dated exit racing retention, recovery and retries only books its actual retained day', async (t) => {
  const { db, models, history, stats } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const day = require('dayjs')().startOf('day').subtract(1, 'day');
  const old = day.subtract(1, 'minute').valueOf(),
    kept = day.add(1, 'minute').valueOf();
  const recent = Date.now() - 1000;
  const start = day.subtract(2, 'day').unix();
  const keys = Array.from(
    { length: 3 },
    () => 'client-' + require('node:crypto').randomUUID(),
  );
  const report = (index, running, end) =>
    history.reportInstance(
      keys[index],
      1,
      running,
      210 + index,
      'run' + index,
      start,
      running ? 0 : 1,
      running ? undefined : 17,
      false,
      end,
    );
  // The last start was lost. Its first dated exit still belongs to a retained day.
  await report(0, true);
  await report(1, true);
  const Service = load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default;
  const cleanup = () =>
    new Service().cleanup({
      cronStatRetentionDays: 1,
      runningInstanceRetentionDays: 1,
    });
  await Promise.all([
    cleanup(),
    history.interrupt('http'),
    report(0, false, old),
    report(1, false, kept),
    history.recordShellResult(keys[1], 1, 17, 1000, Date.now(), kept),
  ]);
  await report(2, false, recent);
  // Each exit must precede its retry, including for the now pruned trigger.
  await cleanup();
  await Promise.all(
    [0, 1, 2].flatMap((n) => {
      const end = [old, kept, recent][n];
      return [
        history.recordShellResult(keys[n], 1, 17, 1000, Date.now(), end),
        report(n, false, end),
      ];
    }),
  );
  const totals = await stats.CrontabStatModel.findAll({
    order: [['date', 'ASC']],
  });
  assert.deepEqual(
    totals.map((x) => [x.date, x.run_count, x.fail_count]),
    [
      [day.format('YYYY-MM-DD'), 1, 1],
      [require('dayjs')(recent).format('YYYY-MM-DD'), 1, 1],
    ],
  );
});

test('a managed command retains its exit after the log reader disappears, including a signalled exit', async (t) => {
  const { root, db, history, models, stats } = await fixture(t);
  const {
    spawnCronCommand,
    releaseCronCommand,
  } = require('../../back/cron/execution/cronCommandProcess');
  const { once } = require('node:events');
  const saved = process.env.QL_DATA_DIR;
  process.env.QL_DATA_DIR = root;
  t.after(() => {
    if (saved === undefined) delete process.env.QL_DATA_DIR;
    else process.env.QL_DATA_DIR = saved;
  });
  await models.CrontabModel.create({ id: 1, command: 'true' });
  for (const [id, command, code, signal] of [
    [
      'outer-failure',
      'for i in {1..3000}; do echo output; echo error >&2; done; exit 17',
      17,
      null,
    ],
    ['outer-signal', 'kill -TERM $$', null, 'SIGTERM'],
  ]) {
    await history.enqueue(id, 1, 'manual', null);
    await history.start(id);
    const proc = spawnCronCommand(command, id);
    const closed = once(proc, 'close');
    await once(proc, 'spawn');
    await history.bindCommand(id, proc.pid);
    await history.interrupt('http');
    proc.stdout.destroy();
    proc.stderr.destroy();
    await releaseCronCommand(proc);
    assert.deepEqual(await closed, [code, signal]);
    const file = path.join(root, 'db', 'cron-exits', id);
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual([receipt.code, receipt.signal], [code, signal]);
    // Rolling back the database write must leave the independent receipt replayable.
    await db.query(
      "CREATE TRIGGER reject_result BEFORE INSERT ON CrontabStats BEGIN SELECT RAISE(ABORT,'rollback'); END",
    );
    await assert.rejects(history.recoverSystemOwners(1), (error) =>
      error.original?.message.includes('rollback'),
    );
    await fs.access(file);
    await db.query('DROP TRIGGER reject_result');
    await Promise.all([
      history.interrupt('http'),
      history.complete(id, 'unknown', 'restart', null),
    ]);
    const row = (await history.recent(1, 0)).find((r) => r.id === id);
    assert.deepEqual(
      [row.state, row.exit_code, row.reason, row.finished_at],
      ['failed', code, signal, receipt.time],
    );
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  }
  assert.equal((await stats.CrontabStatModel.findOne()).fail_count, 2);
});

test('HTTP restart recovers ownerless CLI starts, keeping only the verified live process running', async (t) => {
  const { history, models, db } = await fixture(t);
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const start = Math.floor(Date.now() / 1000) - 5;
  const [live, gone] = [0, 1].map(
    () => 'client-' + require('node:crypto').randomUUID(),
  );
  await history.reportInstance(live, 1, true, process.pid, 'live', start, 0);
  await history.reportInstance(gone, 1, true, 2147483647, 'gone', start, 0);
  await history.interrupt('grpc');
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => r.state),
    ['running', 'running'],
  );
  await history.interrupt('http');
  await history.reconcileInstances();
  const rows = await db.query(
    'SELECT t.id,t.state,i.status FROM CronTriggers t JOIN RunningInstances i ON i.id=t.instance_id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    rows.find((r) => r.id === live),
    { id: live, state: 'running', status: 0 },
  );
  assert.deepEqual(
    rows.find((r) => r.id === gone),
    { id: gone, state: 'unknown', status: 4 },
  );
  assert.equal(await db.models.CrontabStat.count(), 0);
});

test('stopping a supervisor still draining stdout preserves its already observed natural exit', async (t) => {
  const { root, history, db, models } = await fixture(t);
  const saved = process.env.QL_DATA_DIR;
  process.env.QL_DATA_DIR = root;
  t.after(() => {
    if (saved === undefined) delete process.env.QL_DATA_DIR;
    else process.env.QL_DATA_DIR = saved;
  });
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const id = 'already-exited';
  await history.enqueue(id, 1, 'manual', null);
  await history.start(id);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  require('../../back/cron/settlement/exitReceipt.cjs').writeExit(
    id,
    0,
    null,
    Date.now(),
  );
  let signals = 0;
  await assert.rejects(
    history.requestInstanceStop(
      instance.id,
      process.pid,
      () => {
        signals++;
      },
      [systemOwner(process.pid)],
    ),
    { code: 'ESRCH' },
  );
  await history.forgetStop(instance.id);
  await history.complete(id, 'failed', null, 17);
  assert.equal(signals, 0);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.state, r.exit_code]),
    [['finished', 0]],
  );
  assert.equal((await db.models.CrontabStat.findOne()).success_count, 1);
});

async function journalFixture(t) {
  const f = await fixture(t, true);
  for (const key of ['QL_DIR', 'QL_DATA_DIR']) {
    const previous = process.env[key];
    process.env[key] = f.root;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  await f.models.CrontabModel.create({ id: 1, command: 'true', status: 1 });
  return { ...f, ...require('../../back/cron/settlement/exitReceipt.cjs') };
}

// Older publishers left only the canonical file. Keep that on-disk layout
// explicit in damage and mixed-version tests even as current writers evolve.
function writeSingleFileExit(id, code, signal, time) {
  const file =
    require('../../back/cron/settlement/exitReceipt.cjs').receiptPath(id);
  const checksum = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify([id, code, signal, time]))
    .digest('hex');
  require('node:fs').mkdirSync(path.dirname(file), { recursive: true });
  require('node:fs').writeFileSync(
    file,
    JSON.stringify({ version: 1, code, signal, time, checksum }),
    { flag: 'wx' },
  );
}

test('duplicate supervisor publications preserve the first complete exit', async (t) => {
  const { writeExit, readExit } = await journalFixture(t);
  writeExit('first-exit', 17, null, 1000);
  writeExit('first-exit', 0, null, 2000);
  const first = await readExit('first-exit');
  assert.deepEqual([first.code, first.time], [17, 1000]);
});

test('a failed SQLite COMMIT preserves the published exit for restart and duplicate delivery', async (t) => {
  const { db, history, writeExit, readExit, stats } = await journalFixture(t);
  const id = 'failed-commit',
    start = Date.now() - 10000;
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 17, null, start + 1000);
  // This constraint is checked at COMMIT, after the increment and receipt hook.
  await db.query('CREATE TABLE needed(id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE deferred_ref(id INTEGER REFERENCES needed(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    'CREATE TRIGGER fail_commit AFTER INSERT ON CrontabStats BEGIN INSERT INTO deferred_ref VALUES (1); END',
  );
  await assert.rejects(
    history.complete(id, 'finished', null, 0),
    /constraint|foreign key/i,
  );
  assert.equal((await history.recent(1, 0))[0].state, 'running');
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.equal((await readExit(id))?.code, 17);
  await db.query('DROP TRIGGER fail_commit');
  await Promise.all([
    history.interrupt('http'),
    history.complete(id, 'finished', null, 0),
  ]);
  const row = (await history.recent(1, 0))[0];
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['failed', 17, start + 1000],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
  assert.equal(await readExit(id), undefined);
});

test('retention consumes a published exit before pruning an expired unknown and never resurrects a deleted entry', async (t) => {
  const { db, history, stats, writeExit, readExit } = await journalFixture(t);
  const day = require('dayjs')().startOf('day');
  const old = day.subtract(3, 'day').valueOf(),
    kept = day.add(1, 'ms').valueOf();
  const id = 'unknown-on-disk';
  await history.enqueue(id, 1, 'manual', null, old);
  await history.start(id, old, true);
  await history.bindCommand(id, process.pid);
  await history.finish(id, 'unknown', 'restart', null, undefined, old + 1000);
  await history.reconcileInstances();
  await db.query('UPDATE RunningInstances SET finished_at=$end', {
    bind: { end: Math.floor((old + 1000) / 1000) },
  });
  writeExit(id, 23, null, kept);
  const cleanup = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  await cleanup.cleanup({
    runningInstanceRetentionDays: 1,
    cronStatRetentionDays: 1,
  });
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row?.state, row?.exit_code, row?.finished_at],
    ['failed', 23, kept],
  );
  await db.query('DELETE FROM CronTriggers WHERE id=$id', { bind: { id } });
  writeExit(id, 0, null, kept);
  await history.interrupt('http');
  assert.equal((await history.recent(1, 0)).length, 0);
  assert.equal((await readExit(id)).code, 0);
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [
      r.date,
      r.run_count,
      r.fail_count,
    ]),
    [],
  );
});

test('verified stop across midnight keeps a published exit through tree verification and restart', async (t) => {
  const { db, history, stats, writeExit, readExit } = await journalFixture(t);
  const day = require('dayjs')().startOf('day').subtract(1, 'day');
  const start = day.valueOf(),
    end = day.endOf('day').valueOf(),
    id = 'pending-stop-exit';
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {}, [
    systemOwner(process.pid),
  ]);
  writeExit(id, 17, null, end);
  await history.complete(id, 'finished', null, 0);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await history.interrupt('http');
  await history.stopVerifiedInstance(instance.id);
  await history.complete(id, 'failed', null, 9);
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['stopped', 17, end],
  );
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [r.date, r.run_count]),
    [[day.format('YYYY-MM-DD'), 1]],
  );
  assert.equal(await readExit(id), undefined);
});

test('a late skip or duplicate receipt cannot override a published command exit', async (t) => {
  const { history, writeExit, readExit, stats } = await journalFixture(t);
  const id = 'late-skip',
    start = Date.now() - 1000;
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 9, null, start + 300);
  await history.complete(id, 'skipped', 'cancelled', null);
  writeExit(id, 9, null, start + 300);
  await history.interrupt('http');
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['failed', 9, start + 300],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
  assert.equal(await readExit(id), undefined);
});

test('startup keeps a signal-only exit and its date when the service clock moved back', async (t) => {
  const { history, writeExit, stats } = await journalFixture(t);
  const id = 'future-supervisor-exit';
  const day = require('dayjs')().add(1, 'day').startOf('day');
  const start = day.subtract(1, 'minute').valueOf(),
    end = day.valueOf();
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, null, 'SIGTERM', end);
  await Promise.all([
    history.interrupt('http'),
    history.complete(id, 'finished', null, 0),
  ]);
  const [trigger] = await history.recent(1, 0);
  assert.deepEqual(
    [trigger.state, trigger.reason, trigger.exit_code, trigger.finished_at],
    ['failed', 'SIGTERM', null, end],
  );
  const row = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [row.date, row.run_count, row.fail_count],
    [day.format('YYYY-MM-DD'), 1, 1],
  );
});

test('replay can retire unreadable committed and pruned exits while a new instance has a real result', async (t) => {
  const { history, stats, writeExit, receiptPath } = await journalFixture(t);
  const start = Date.now() - 10000;
  for (const id of ['booked', 'new-exit']) {
    await history.enqueue(id, 1, 'manual', null, start);
    await history.start(id, start, true);
    await history.bindCommand(id, process.pid);
  }
  await history.complete('booked', 'failed', null, 17, start + 100);
  for (const id of ['booked', 'pruned', 'new-exit'])
    writeExit(id, 0, null, start + 200);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', (file, ...args) => {
    if ([receiptPath('booked'), receiptPath('pruned')].includes(file))
      throw Object.assign(new Error('stale receipt cannot be read'), {
        code: 'EACCES',
      });
    return open(file, ...args);
  });
  await Promise.all([
    history.interrupt('http'),
    history.complete('booked', 'finished', null, 0),
    history.complete('pruned', 'failed', null, 99),
  ]);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.id, r.exit_code]).sort(),
    [
      ['booked', 17],
      ['new-exit', 0],
    ],
  );
  const stat = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [stat.run_count, stat.fail_count, stat.success_count],
    [2, 1, 1],
  );
  for (const id of ['booked', 'pruned', 'new-exit'])
    await assert.rejects(fs.stat(receiptPath(id)), { code: 'ENOENT' });
});

test('restart retires a committed script entry sample without consuming another execution’s pending sample', async (t) => {
  const { root, history, stats, writeExit } = await journalFixture(t);
  await fs.mkdir(path.join(root, '.tmp'));
  const sample = (id) => path.join(root, '.tmp', 'cron-start-' + id);
  const start = Date.now() - 5000;
  for (const id of ['old', 'new']) {
    await history.enqueue(id, 1, 'manual', null, start);
    await history.start(id, start, true);
    await history.bindCommand(id, process.pid);
    await fs.writeFile(sample(id), String(start + 100));
  }
  const unlink = fs.unlink.bind(fs);
  const hook = t.mock.method(fs, 'unlink', (file, ...args) =>
    file === sample('old')
      ? Promise.reject(new Error('interrupted unlink'))
      : unlink(file, ...args),
  );
  await history.complete('old', 'failed', null, 17, start + 200);
  hook.mock.restore();
  assert.equal(
    (await history.visibleTriggers(1, ['old']))[0].script_started_at,
    start + 100,
  );
  await fs.writeFile(sample('unregistered'), String(start));
  await fs.writeFile(sample('pruned'), String(start));
  writeExit('pruned', 17, null, start + 100);
  await history.interrupt('grpc');
  for (const id of ['old', 'pruned'])
    await assert.rejects(fs.stat(sample(id)), { code: 'ENOENT' });
  for (const id of ['new', 'unregistered'])
    assert.equal((await fs.stat(sample(id))).isFile(), true);
  await history.complete('new', 'finished', null, 0, start + 300);
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 2);
});

test('delayed post-commit deletion only retires its own exit while cleanup and a later exit overlap', async (t) => {
  const { db, history, stats, receiptPath, readExit, writeExit } =
    await journalFixture(t);
  const midnight = require('dayjs')().startOf('day');
  const old = midnight.subtract(3, 'day').valueOf(),
    fresh = midnight.valueOf();
  for (const [id, time] of [
    ['old-run', old],
    ['new-run', fresh],
  ]) {
    await history.enqueue(id, 1, 'manual', null, time);
    await history.start(id, time, true);
    await history.bindCommand(id, process.pid);
  }
  let reachedDeletion, allowDeletion;
  const entered = new Promise((resolve) => {
    reachedDeletion = resolve;
  });
  const resume = new Promise((resolve) => {
    allowDeletion = resolve;
  });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (file, ...args) => {
    if (file === receiptPath('old-run')) {
      reachedDeletion();
      await resume;
    }
    return rename(file, ...args);
  });
  writeExit('old-run', 17, null, old + 50);
  const settling = history.complete('old-run', 'failed', null, 17);
  try {
    await Promise.race([
      entered,
      settling.then(() => {
        throw Error('missing post-commit barrier');
      }),
    ]);
    assert.equal((await stats.CrontabStatModel.findOne()).fail_count, 1);
    writeExit('new-run', 23, null, fresh + 150);
    assert.equal((await readExit('old-run')).code, 17);
  } finally {
    allowDeletion();
  }
  await settling;
  assert.equal((await readExit('new-run')).code, 23);
  writeExit('old-run', 17, null, old + 50);
  const cleanup = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  await Promise.all([
    cleanup.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 1,
    }),
    history.complete('new-run', 'finished', null, 0),
    history.complete('old-run', 'finished', null, 0),
  ]);
  writeExit('old-run', 17, null, old + 50);
  await history.interrupt('http');
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.id, r.exit_code]),
    [['new-run', 23]],
  );
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [
      r.date,
      r.run_count,
      r.fail_count,
    ]),
    [[midnight.format('YYYY-MM-DD'), 1, 1]],
  );
  assert.equal(await readExit('old-run'), undefined);
  assert.equal(await readExit('new-run'), undefined);
});

test('an unavailable script sampling directory does not block replay of a pending command exit', async (t) => {
  const { root, history, writeExit, readExit } = await journalFixture(t);
  await fs.writeFile(path.join(root, '.tmp'), 'not a directory');
  const id = 'pending-supervisor',
    start = Date.now() - 1000;
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 23, null, start + 500);
  await history.interrupt('http');
  const [result] = await history.recent(1, 0);
  assert.deepEqual([result.exit_code, result.finished_at], [23, start + 500]);
  assert.equal(await readExit(id), undefined);
});

for (const fault of [
  'read error',
  'truncated JSON',
  'invalid fields',
  'end before start',
  'changed code',
  'copied sibling receipt',
]) {
  test(`a pending exit with ${fault} survives cleanup and restarts while a sibling settles`, async (t) => {
    const { db, history, stats, writeExit, receiptPath } = await journalFixture(
      t,
    );
    const day = require('dayjs')().startOf('day');
    const start = day.subtract(4, 'day').valueOf();
    const end = day.subtract(2, 'day').valueOf() + 500;
    for (const id of ['broken-exit', 'sibling-exit']) {
      await history.enqueue(id, 1, 'manual', null, start);
      await history.start(id, start, true);
      await history.bindCommand(id, process.pid);
    }
    writeSingleFileExit('broken-exit', 23, null, end);
    writeExit('sibling-exit', 0, null, day.valueOf());
    const file = receiptPath('broken-exit');
    const original = await fs.readFile(file);
    if (fault === 'read error') {
      for (const method of ['open', 'readFile']) {
        const fn = fs[method].bind(fs);
        t.mock.method(fs, method, (path, ...args) => {
          if (path === file)
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return fn(path, ...args);
        });
      }
    } else {
      const contents = {
        'truncated JSON': '{"code":',
        'invalid fields': '{"code":true,"signal":null,"time":1}',
        'end before start': JSON.stringify({
          code: 0,
          signal: null,
          time: start - 1,
        }),
        'changed code': JSON.stringify({ ...JSON.parse(original), code: 24 }),
        'copied sibling receipt': await fs.readFile(
          receiptPath('sibling-exit'),
          'utf8',
        ),
      };
      await fs.writeFile(file, contents[fault]);
    }
    await history.interrupt('http');
    await history.complete('broken-exit', 'finished', null, 0);
    const result = async (id) => (await history.visibleTriggers(1, [id]))[0];
    assert.equal((await result('sibling-exit')).state, 'finished');
    const unresolved = await result('broken-exit');
    assert.deepEqual(
      [unresolved.state, unresolved.reason, unresolved.finished_at],
      ['unknown', 'exit_pending', null],
    );
    assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
    // Age the provisional observation past the history cutoff. The real
    // execution and its linked process row must still be available for repair.
    await db.query(
      "UPDATE CronTriggers SET finished_at=$end WHERE id='broken-exit'",
      {
        bind: { end },
      },
    );
    await db.query(
      "UPDATE RunningInstances SET finished_at=$end WHERE id=(SELECT instance_id FROM CronTriggers WHERE id='broken-exit')",
      { bind: { end: Math.floor(end / 1000) } },
    );
    const cleanup = new (load('back/services/retention.ts', {
      '../data': { sequelize: db },
      '../data/cronStats': stats,
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0 },
      },
      '../data/system': {},
      '../config': {},
    }).default)();
    const policy = {
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 7,
    };
    for (let i = 0; i < 2; i++) {
      await history.interrupt('http');
      await cleanup.cleanup(policy);
    }
    assert.equal((await result('broken-exit')).state, 'unknown');
    assert.equal(await db.models.RunningInstance.count(), 2);
    t.mock.restoreAll();
    await fs.unlink(file);
    await history.complete('broken-exit', 'finished', null, 0);
    assert.equal((await result('broken-exit')).state, 'unknown');
    await fs.writeFile(file, original);
    await Promise.all([
      history.retryPendingExits(),
      history.retryPendingExits(),
      history.complete('broken-exit', 'finished', null, 0),
    ]);
    const row = await result('broken-exit');
    assert.deepEqual(
      [row.state, row.exit_code, row.finished_at],
      ['failed', 23, end],
    );
    const instance = await db.models.RunningInstance.findOne({
      where: { exit_code: 23 },
    });
    assert.deepEqual(
      [instance.status, instance.finished_at],
      [3, Math.floor(end / 1000)],
    );
    assert.deepEqual(
      (await stats.CrontabStatModel.findAll({ order: [['date', 'ASC']] })).map(
        (x) => [x.date, x.run_count, x.success_count, x.fail_count],
      ),
      [
        [day.subtract(2, 'day').format('YYYY-MM-DD'), 1, 0, 1],
        [day.format('YYYY-MM-DD'), 1, 1, 0],
      ],
    );
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  });
}

test('a repaired exit from an older supervisor respects a daily ledger that was already pruned', async (t) => {
  const { history, db, stats, receiptPath } = await journalFixture(t);
  const day = require('dayjs')().startOf('day'),
    start = day.subtract(3, 'day').valueOf(),
    id = 'old-format-exit';
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeSingleFileExit(id, 0, null, start + 300);
  const file = receiptPath(id);
  await fs.writeFile(file, '{');
  await history.complete(id, 'failed', null, 99);
  await db.query('INSERT INTO CronStatRetention(id,first_day) VALUES(1,$day)', {
    bind: { day: day.format('YYYY-MM-DD') },
  });
  await fs.writeFile(
    file,
    JSON.stringify({ code: 0, signal: null, time: start + 300 }),
  );
  await Promise.all([history.retryPendingExits(), history.interrupt('http')]);
  assert.equal((await history.recent(1, 0))[0].state, 'unknown');
  await history.complete(id, 'finished', null, 0, start + 300);
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['finished', 0, start + 300],
  );
  assert.equal(
    (
      await db.query('SELECT counted FROM CronTriggers', {
        type: QueryTypes.SELECT,
      })
    )[0].counted,
    1,
  );
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('a damaged stop receipt keeps the signalled tree tracked until verification, then uses its recovered exit', async (t) => {
  const { history, db, stats, receiptPath } = await journalFixture(t);
  const id = 'stopping-with-damaged-exit',
    start = Date.now() - 5000;
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {}, [
    systemOwner(process.pid),
  ]);
  writeSingleFileExit(id, 17, null, start + 500);
  const file = receiptPath(id),
    bytes = await fs.readFile(file);
  await fs.writeFile(file, 'bad');
  await history.complete(id, 'finished', null, 0);
  await history.interrupt('http');
  assert.equal((await history.recent(1, 0))[0].state, 'running');
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await history.stopVerifiedInstance(instance.id);
  assert.equal((await history.recent(1, 0))[0].state, 'unknown');
  await fs.writeFile(file, bytes);
  await history.retryPendingExits();
  const [row] = await history.recent(1, 0);
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['stopped', 17, start + 500],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
});

test('an unverifiable exit prevents unconfirmed signals; a legacy instance without a trigger still stops normally', async (t) => {
  const { db, history, receiptPath } = await journalFixture(t);
  const start = Date.now() - 300,
    id = 'uncertain-stop';
  const legacy = await db.models.RunningInstance.create({
    cron_id: 1,
    pid: process.pid,
    status: 0,
    started_at: Math.floor(start / 1000),
  });
  const targets = [systemOwner(process.pid)];
  let signals = 0;
  await history.requestInstanceStop(
    legacy.id,
    process.pid,
    () => {
      signals++;
    },
    targets,
  );
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  const [linked] = await db.query(
    'SELECT instance_id FROM CronTriggers WHERE id=$id',
    {
      bind: { id },
      type: QueryTypes.SELECT,
    },
  );
  writeSingleFileExit(id, 0, null, start + 100);
  await fs.writeFile(receiptPath(id), 'bad');
  await assert.rejects(
    history.requestInstanceStop(
      linked.instance_id,
      process.pid,
      () => {
        signals++;
      },
      targets,
    ),
    { status: 503 },
  );
  assert.equal(signals, 1);
});

test('repair books a checksummed exit on the observed day even when the clock moved backwards during execution', async (t) => {
  const { history, stats, receiptPath } = await journalFixture(t);
  const midnight = require('dayjs')().startOf('day'),
    id = 'clock-stepped-back';
  const start = midnight.valueOf() + 5000,
    end = midnight.valueOf() - 5000;
  await history.enqueue(id, 1, 'manual', null, start);
  await history.start(id, start, true);
  await history.bindCommand(id, process.pid);
  writeSingleFileExit(id, 0, null, end);
  const file = receiptPath(id),
    original = await fs.readFile(file);
  await fs.writeFile(file, 'broken');
  await history.interrupt('http');
  assert.equal((await history.recent(1, 0))[0].state, 'unknown');
  await fs.writeFile(file, original);
  await history.retryPendingExits();
  assert.equal((await history.recent(1, 0))[0].finished_at, end);
  const stat = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [stat.date, stat.success_count, stat.total_time],
    [midnight.subtract(1, 'day').format('YYYY-MM-DD'), 1, 0],
  );
});

for (const damage of [
  'swapped files',
  'changed legal code',
  'removed checksum',
]) {
  test(`unbound legacy exits with ${damage} need independent per-execution evidence`, async (t) => {
    const { history, db, stats, writeExit, receiptPath } = await journalFixture(
      t,
    );
    const end = Math.floor(Date.now() / 1000) * 1000 - 2000;
    const oldA = { code: 0, signal: null, time: end + 11 };
    const oldB = { code: 23, signal: null, time: end + 22 };
    for (const id of ['old-a', 'old-b', 'new-c']) {
      await history.enqueue(id, 1, 'manual', null, end - 1000);
      await history.start(id, end - 1000, true);
      await history.bindCommand(id, process.pid);
    }
    writeExit('new-c', 0, null, end + 33);
    if (damage === 'removed checksum')
      writeSingleFileExit('old-a', 0, null, oldA.time);
    const a = damage === 'swapped files' ? oldB : { ...oldA, code: 24 };
    await fs.writeFile(receiptPath('old-a'), JSON.stringify(a));
    await fs.writeFile(
      receiptPath('old-b'),
      JSON.stringify(damage === 'swapped files' ? oldA : oldB),
    );
    const rows = () =>
      db.query(
        'SELECT id,state,exit_code,counted FROM CronTriggers ORDER BY id',
        { type: QueryTypes.SELECT },
      );
    const first = [
      { id: 'new-c', state: 'finished', exit_code: 0, counted: 1 },
      { id: 'old-a', state: 'unknown', exit_code: null, counted: 0 },
      { id: 'old-b', state: 'unknown', exit_code: null, counted: 0 },
    ];
    for (let pass = 0; pass < 2; pass++) {
      await history.interrupt('http');
      await Promise.all([
        history.retryPendingExits(),
        history.complete('old-a', 'finished', null, 0, oldA.time),
        history.complete('old-a', 'failed', null, a.code),
        history.complete('old-b', 'failed', null, 23, oldB.time + 1),
        history.recordShellResult('old-a', 1, a.code, 10, end),
      ]);
      assert.deepEqual(await rows(), first);
    }
    await fs.writeFile(receiptPath('old-b'), JSON.stringify(oldB));
    await Promise.all(
      [1, 2].map(() =>
        history.complete('old-b', 'failed', null, 23, oldB.time),
      ),
    );
    assert.deepEqual(await rows(), first);
    await fs.unlink(receiptPath('old-b'));
    writeExit('old-b', 23, null, oldB.time);
    await history.retryPendingExits();
    assert.deepEqual(await rows(), [
      first[0],
      first[1],
      { id: 'old-b', state: 'failed', exit_code: 23, counted: 1 },
    ]);
    const stat = await stats.CrontabStatModel.findOne();
    assert.deepEqual(
      [stat.run_count, stat.success_count, stat.fail_count],
      [2, 1, 1],
    );
  });
}

for (const witnessed of [false, true]) {
  test(`restart during stop preserves the provenance of a legacy exit (witnessed=${witnessed})`, async (t) => {
    const { history, db, stats, receiptPath } = await journalFixture(t);
    const id = 'old-stop',
      end = Date.now() - 1000;
    await history.enqueue(id, 1, 'manual', null, end - 1000);
    await history.start(id, end - 1000, true);
    await history.bindCommand(id, process.pid);
    const instance = await db.models.RunningInstance.findOne();
    await history.requestInstanceStop(instance.id, process.pid, () => {}, [
      systemOwner(process.pid),
    ]);
    writeSingleFileExit(id, 0, null, end);
    const file = receiptPath(id);
    await fs.writeFile(
      file,
      JSON.stringify({ code: null, signal: 'SIGTERM', time: end }),
    );
    // Upgrades can inherit a staged exit copied from the old, unchecked file.
    await db.query(
      'UPDATE CronTriggers SET stop_exit_at=$end,exit_code=24 WHERE id=$id',
      {
        bind: { end: end - 5, id },
      },
    );
    if (witnessed) await history.complete(id, 'failed', 'SIGTERM', null, end);
    await fs.writeFile(
      file,
      JSON.stringify({ code: 24, signal: null, time: end - 5 }),
    );
    await history.interrupt('http');
    await history.interrupt('http');
    assert.equal(await stats.CrontabStatModel.count(), 0);
    await history.stopVerifiedInstance(instance.id);
    const [row] = await history.recent(1, 0);
    assert.deepEqual(
      [row.state, row.exit_code, row.finished_at],
      witnessed ? ['stopped', null, end] : ['unknown', null, null],
    );
    assert.equal(await stats.CrontabStatModel.count(), Number(witnessed));
  });
}

test('a stored terminal result keeps its exit and day when a conflicting legacy marker replays', async (t) => {
  const { history, db, stats, receiptPath } = await journalFixture(t);
  const id = 'stored-terminal',
    midnight = require('dayjs')().startOf('day'),
    end = midnight.subtract(1, 'second').valueOf();
  await history.enqueue(id, 1, 'manual', null, end - 2000);
  await history.start(id, end - 2000, true);
  await history.bindCommand(id, process.pid);
  await history.finish(id, 'failed', null, 17, undefined, end);
  writeSingleFileExit(id, 0, null, end + 2000);
  await fs.writeFile(
    receiptPath(id),
    JSON.stringify({ code: 0, signal: null, time: end + 2000 }),
  );
  await Promise.all([
    history.interrupt('http'),
    history.complete(id, 'finished', null, 0),
  ]);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [
      r.state,
      r.exit_code,
      r.finished_at,
    ]),
    [['failed', 17, end]],
  );
  assert.equal((await db.models.RunningInstance.findOne()).exit_code, 17);
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [
      r.date,
      r.run_count,
      r.fail_count,
    ]),
    [[midnight.subtract(1, 'day').format('YYYY-MM-DD'), 1, 1]],
  );
});

test('the orphan reporter rejects a versioned message copied from a sibling before opening the database', async (t) => {
  const { receiptPath, writeExit } = await journalFixture(t);
  writeExit('sibling', 23, null, Date.now());
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [
      require.resolve('../../back/shared/managedExit.cjs'),
      await fs.readFile(receiptPath('sibling'), 'utf8'),
    ],
    { env: { ...process.env, QL_TRIGGER_ID: 'target' }, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid supervisor exit receipt/);
});

test('crond retries confirm their registered system execution and leave other tasks and sources alone', async (t) => {
  const { history, root, receiptPath, writeExit, stats } = await journalFixture(
    t,
  );
  const manual = 'system-1-manual',
    system = 'older-wrapper-id';
  const start = Date.now() - 5000;
  await history.enqueue(manual, 1, 'manual', null, start);
  await history.start(manual, start, true);
  await history.bindCommand(manual, process.pid);
  await history.enqueue(system, 1, 'system', null, start);
  await history.start(system, start, true);
  const db = stats.CrontabStatModel.sequelize;
  await db.query('UPDATE CronTriggers SET owner=$owner WHERE id=$id', {
    bind: { owner: systemOwner(process.pid), id: system },
  });
  const end = Date.now();
  writeSingleFileExit(system, 17, null, end);
  await fs.writeFile(
    receiptPath(system),
    JSON.stringify({ code: 17, signal: null, time: end }),
  );
  await history.interrupt('http');
  // Use the normal config path for the child process's independent connection.
  await fs.writeFile(path.join(root, '.env'), '');
  await fs.symlink(
    path.join(root, 'database.sqlite'),
    path.join(root, 'db', 'database.sqlite'),
  );
  const report = (task, id, code) => {
    const { status, stderr } = require('node:child_process').spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        require.resolve('../../back/bootstrap/systemCron.ts'),
        'finish',
        String(task),
        '0',
        id,
        String(code),
        String(end),
      ],
      { env: { ...process.env, QL_TRIGGER_ID: '', ID: '' }, encoding: 'utf8' },
    );
    assert.equal(status, 0, stderr);
  };
  report(1, manual, 0);
  report(2, system, 17);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.equal(
    (await history.visibleTriggers(1, [system]))[0].state,
    'unknown',
  );
  assert.equal(
    (await history.visibleTriggers(1, [manual]))[0].state,
    'running',
  );
  const original = await fs.readFile(receiptPath(system));
  await fs.unlink(receiptPath(system));
  report(1, system, 99);
  assert.equal(
    (await history.visibleTriggers(1, [system]))[0].state,
    'unknown',
  );
  await assert.rejects(fs.stat(receiptPath(system)), { code: 'ENOENT' });
  await fs.writeFile(receiptPath(system), original);
  report(1, system, 17);
  report(1, system, 17);
  assert.equal(
    (await history.visibleTriggers(1, [system]))[0].reason,
    'exit_conflict',
  );
  await fs.unlink(receiptPath(system));
  writeExit(system, 17, null, end);
  await history.retryPendingExits();
  assert.deepEqual(
    (await history.visibleTriggers(1, [system])).map((row) => [
      row.exit_code,
      row.finished_at,
    ]),
    [[17, end]],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
});

test('a valid bound supervisor message recovers its own damaged legacy file and disputes a conflicting bound publication', async (t) => {
  const { history, root, receiptPath, writeExit, stats } = await journalFixture(
    t,
  );
  const end = Date.now() - 1000;
  await fs.writeFile(path.join(root, '.env'), '');
  for (const id of ['weak-disk', 'strong-disk']) {
    await history.enqueue(id, 1, 'manual', null, end - 2000);
    await history.start(id, end - 2000, true);
    await history.bindCommand(id, process.pid);
    writeExit(id, 17, null, end);
    const file = receiptPath(id),
      observed = await fs.readFile(file, 'utf8');
    await fs.unlink(file);
    if (id === 'weak-disk') {
      await fs.writeFile(
        file,
        JSON.stringify({ code: 24, signal: null, time: end }),
      );
      await history.interrupt('http');
      await fs.symlink(
        path.join(root, 'database.sqlite'),
        path.join(root, 'db', 'database.sqlite'),
      );
    } else {
      writeExit(id, 23, null, end - 10);
    }
    const { status, stderr } = require('node:child_process').spawnSync(
      process.execPath,
      [require.resolve('../../back/shared/managedExit.cjs'), observed],
      { env: { ...process.env, QL_TRIGGER_ID: id }, encoding: 'utf8' },
    );
    assert.equal(status, 0, stderr);
  }
  const rows = await history.recent(1, 0);
  assert.deepEqual(rows.map((r) => [r.id, r.exit_code, r.finished_at]).sort(), [
    ['strong-disk', null, null],
    ['weak-disk', 17, end],
  ]);
  assert.equal(
    rows.find((r) => r.id === 'strong-disk').reason,
    'exit_conflict',
  );
  assert.equal((await stats.CrontabStatModel.findOne()).fail_count, 1);
});

for (const [initial, recovery] of [
  ['missing', 'poll'],
  ['damaged', 'restart'],
  ['swapped', 'cleanup'],
]) {
  test(`an early independent exit survives a ${initial} file, cleanup and two restarts until ${recovery}`, async (t) => {
    const { history, db, root, receiptPath, stats } = await journalFixture(t);
    const midnight = require('dayjs')().startOf('day').subtract(2, 'day');
    const start = midnight.subtract(2, 'minute').valueOf();
    const a = { code: null, signal: 'SIGTERM', time: midnight.valueOf() + 73 };
    const b = { code: 0, signal: null, time: a.time };
    for (const id of ['early-a', 'early-b']) {
      await history.enqueue(id, 1, 'manual', null, start);
      await history.start(id, start, true);
      await history.bindCommand(id, process.pid);
    }
    await fs.mkdir(path.dirname(receiptPath('early-a')), { recursive: true });
    await fs.writeFile(path.join(root, '.env'), '');
    await fs.symlink(
      path.join(root, 'database.sqlite'),
      path.join(root, 'db', 'database.sqlite'),
    );
    const fileA = receiptPath('early-a'),
      fileB = receiptPath('early-b');
    if (initial !== 'missing')
      await fs.writeFile(
        fileA,
        initial === 'damaged' ? '{' : JSON.stringify(b),
      );
    await fs.writeFile(fileB, JSON.stringify(a));
    const report = (id, observation) =>
      require('node:util').promisify(require('node:child_process').execFile)(
        process.execPath,
        [
          require.resolve('../../back/shared/managedExit.cjs'),
          JSON.stringify(observation),
        ],
        { env: { ...process.env, QL_TRIGGER_ID: id } },
      );
    await Promise.all([
      report('early-a', a),
      report('early-a', a),
      report('early-b', b),
    ]);
    const states = async () =>
      (await history.recent(1, 0))
        .map((r) => [r.id, r.state, r.exit_code, r.finished_at])
        .sort();
    const unknown = [
      ['early-a', 'unknown', null, null],
      ['early-b', 'unknown', null, null],
    ];
    assert.deepEqual(await states(), unknown);
    // Neither sibling can use the other's observation, even at the exact same millisecond.
    await history.retryPendingExits();
    await db.query('UPDATE CronTriggers SET finished_at=$start', {
      bind: { start },
    });
    const cleanup = new (load('back/services/retention.ts', {
      '../data': { sequelize: db },
      '../data/cronStats': stats,
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0 },
      },
      '../data/system': {},
      '../config': {},
    }).default)();
    const clean = () =>
      cleanup.cleanup({
        runningInstanceRetentionDays: 1,
        cronStatRetentionDays: 7,
      });
    for (let pass = 0; pass < 2; pass++) {
      await history.interrupt('http');
      await clean();
      assert.deepEqual(await states(), unknown);
    }
    assert.equal(await stats.CrontabStatModel.count(), 0);
    // Restore only A's bytes. No successful A observation will be sent again.
    await fs.writeFile(fileA, JSON.stringify(a));
    const recover = {
      poll: () => history.retryPendingExits(),
      restart: () => history.interrupt('http'),
      cleanup: clean,
    };
    await Promise.all([recover[recovery](), report('early-b', b)]);
    // Cleanup may legitimately prune A's old detail in the transaction that books it.
    if (recovery !== 'cleanup') {
      const [row] = await history.visibleTriggers(1, ['early-a']);
      assert.deepEqual(
        [row.state, row.reason, row.exit_code, row.finished_at],
        ['failed', 'SIGTERM', null, a.time],
      );
    }
    const [sibling] = await history.visibleTriggers(1, ['early-b']);
    assert.equal(sibling.state, 'unknown');
    assert.deepEqual(
      (await stats.CrontabStatModel.findAll()).map((r) => [
        r.date,
        r.run_count,
        r.fail_count,
      ]),
      [[midnight.format('YYYY-MM-DD'), 1, 1]],
    );
    await fs.writeFile(fileB, JSON.stringify(b));
    await Promise.all([
      history.retryPendingExits(),
      history.interrupt('http'),
      report('early-b', b),
    ]);
    const stat = await stats.CrontabStatModel.findOne();
    assert.deepEqual(
      [stat.run_count, stat.success_count, stat.fail_count],
      [2, 1, 1],
    );
  });
}

test('a failed booking retains the early observation; a later retry respects the pruned daily ledger', async (t) => {
  const { history, db, stats, receiptPath } = await journalFixture(t);
  const id = 'early-commit',
    day = require('dayjs')().startOf('day'),
    end = day.subtract(3, 'day').valueOf();
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  writeSingleFileExit(id, 0, null, end);
  const file = receiptPath(id);
  await fs.writeFile(file, '{');
  await Promise.all(
    [1, 2].map(() => history.complete(id, 'finished', null, 0, end)),
  );
  const observed = () =>
    db.query(
      'SELECT trigger_id,outcome,finished_at FROM CronExitObservations',
      { type: QueryTypes.SELECT },
    );
  const expected = [{ trigger_id: id, outcome: '0', finished_at: end }];
  assert.deepEqual(await observed(), expected);
  // A malformed timestamp or an incomplete callback cannot corroborate a file.
  await history.complete(id, 'failed', null, 99);
  await history.complete(id, 'failed', null, 99, end - 2000);
  assert.deepEqual(await observed(), expected);
  await fs.writeFile(
    file,
    JSON.stringify({ code: 0, signal: null, time: end }),
  );
  await db.query('CREATE TABLE needed(id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE deferred_ref(id INTEGER REFERENCES needed(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    'CREATE TRIGGER fail_booking AFTER INSERT ON CrontabStats BEGIN INSERT INTO deferred_ref VALUES (1); END',
  );
  await assert.rejects(history.retryPendingExits(), /constraint|foreign key/i);
  assert.deepEqual(await observed(), expected);
  assert.equal((await history.recent(1, 0))[0].state, 'unknown');
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await db.query('DROP TRIGGER fail_booking');
  await db.query('INSERT INTO CronStatRetention(id,first_day) VALUES(1,$day)', {
    bind: { day: day.format('YYYY-MM-DD') },
  });
  await Promise.all([history.retryPendingExits(), history.interrupt('http')]);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [
      r.state,
      r.exit_code,
      r.finished_at,
    ]),
    [['finished', 0, end]],
  );
  assert.deepEqual(await observed(), []);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('a timestamped crond retry saved during replacement only corroborates its registered task', async (t) => {
  const { history, db, root, stats, receiptPath } = await journalFixture(t);
  const id = 'older-crond-witness';
  assert.equal(
    await history.startSystem(id, 1, systemOwner(process.pid)),
    true,
  );
  const end = Date.now();
  await fs.mkdir(path.dirname(receiptPath(id)), { recursive: true });
  await fs.writeFile(path.join(root, '.env'), '');
  await fs.symlink(
    path.join(root, 'database.sqlite'),
    path.join(root, 'db', 'database.sqlite'),
  );
  const send = (task) =>
    require('node:util').promisify(require('node:child_process').execFile)(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        require.resolve('../../back/bootstrap/systemCron.ts'),
        'finish',
        String(task),
        '0',
        id,
        '19',
        String(end),
      ],
      { env: { ...process.env, QL_TRIGGER_ID: '', ID: '' } },
    );
  await send(2);
  assert.deepEqual(
    await db.query('SELECT * FROM CronExitObservations', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
  await send(1);
  await history.interrupt('http');
  assert.equal((await history.recent(1, 0))[0].state, 'unknown');
  await fs.writeFile(
    receiptPath(id),
    JSON.stringify({ code: 19, signal: null, time: end }),
  );
  await history.retryPendingExits();
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.exit_code, r.finished_at]),
    [[19, end]],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).fail_count, 1);
});

test('a stopping legacy instance hides its provisional exit code until the early observation is corroborated', async (t) => {
  const { history, db, stats, receiptPath } = await journalFixture(t);
  const id = 'early-stopping',
    end = Date.now() - 500;
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {}, [
    systemOwner(process.pid),
  ]);
  await db.query(
    'UPDATE CronTriggers SET exit_code=24,stop_exit_at=$end WHERE id=$id',
    { bind: { id, end: end - 1 } },
  );
  writeSingleFileExit(id, 17, null, end);
  const file = receiptPath(id);
  await fs.writeFile(file, '{');
  await history.complete(id, 'failed', null, 17, end);
  const [pending] = await history.visibleTriggers(1, [id]);
  assert.deepEqual(
    [pending.state, pending.reason, pending.exit_code, pending.finished_at],
    ['running', 'exit_pending', null, null],
  );
  await history.interrupt('http');
  await fs.writeFile(
    file,
    JSON.stringify({ code: 17, signal: null, time: end }),
  );
  await history.retryPendingExits();
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await history.stopVerifiedInstance(instance.id);
  const [final] = await history.recent(1, 0);
  assert.deepEqual(
    [final.state, final.exit_code, final.finished_at],
    ['stopped', 17, end],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
});

for (const field of ['code', 'millisecond']) {
  test(`conflicting independent legacy reports (${field}) converge across all file and report orders`, async (t) => {
    const { db, history, stats, receiptPath, writeExit } = await journalFixture(
      t,
    );
    const start = require('dayjs')().startOf('day').valueOf() - 5000;
    const a = { code: 17, signal: null, time: start + 5000 };
    const b = field === 'code' ? { ...a, code: 0 } : { ...a, time: a.time - 1 };
    async function launch(id) {
      await history.enqueue(id, 1, 'manual', null, start);
      await history.start(id, start, true);
      await history.bindCommand(id, process.pid);
    }
    await launch('confirmed-sibling');
    writeExit('confirmed-sibling', 0, null, a.time);
    await history.interrupt('http');
    for (const order of ['ABF', 'BAF', 'AFB', 'BFA', 'FAB', 'FBA']) {
      const id = 'conflict-' + order.toLowerCase();
      await launch(id);
      const report = (r) =>
        history.complete(
          id,
          r.code ? 'failed' : 'finished',
          null,
          r.code,
          r.time,
          'legacy',
        );
      for (const event of order) {
        if (event === 'F')
          await fs.writeFile(receiptPath(id), JSON.stringify(a));
        else await report(event === 'A' ? a : b);
        await history.interrupt('http');
      }
      await Promise.all([report(a), report(b), history.retryPendingExits()]);
      const [row] = await history.visibleTriggers(1, [id]);
      assert.deepEqual(
        [row.state, row.exit_code, row.finished_at],
        ['unknown', null, null],
        order,
      );
      const [linked] = await db.query(
        'SELECT i.status,i.exit_code FROM RunningInstances i JOIN CronTriggers t ON t.instance_id=i.id WHERE t.id=$id',
        { bind: { id }, type: QueryTypes.SELECT },
      );
      assert.deepEqual(linked, { status: 4, exit_code: null }, order);
      assert.deepEqual(
        (await stats.CrontabStatModel.findAll()).map((r) => [
          r.run_count,
          r.success_count,
          r.fail_count,
          r.total_time,
          r.max_time,
        ]),
        [[1, 1, 0, 5000, 5000]],
        order,
      );
    }
  });
}

test('a failed COMMIT replacing a reversible legacy booking preserves the bound exit for a retry', async (t) => {
  const { db, history, stats, receiptPath, writeExit, readExit } =
    await journalFixture(t);
  const id = 'weak-before-commit',
    end = Date.now() - 500;
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  writeSingleFileExit(id, 0, null, end);
  await fs.writeFile(
    receiptPath(id),
    JSON.stringify({ code: 0, signal: null, time: end }),
  );
  await history.complete(id, 'finished', null, 0, end, 'legacy');
  writeExit(id, 23, null, end + 10);
  await db.query('CREATE TABLE needed(id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE blocked(id INTEGER REFERENCES needed(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    'CREATE TRIGGER fail_replacement AFTER INSERT ON CrontabStats BEGIN INSERT INTO blocked VALUES(1); END',
  );
  await assert.rejects(history.interrupt('http'), /constraint|foreign key/i);
  assert.equal((await stats.CrontabStatModel.findOne()).success_count, 1);
  assert.equal((await readExit(id))?.code, 23);
  await db.query('DROP TRIGGER fail_replacement');
  await history.interrupt('http');
  await history.complete(id, 'finished', null, 0, end, 'legacy');
  const [result] = await history.recent(1, 0);
  assert.deepEqual([result.exit_code, result.finished_at], [23, end + 10]);
  const stat = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [stat.run_count, stat.success_count, stat.fail_count, stat.max_time],
    [1, 0, 1, 1010],
  );
});

test('archived legacy corrections preserve anonymous and sibling maxima without recreating history or pruned days', async (t) => {
  const { db, history, stats, receiptPath, writeExit } = await journalFixture(
    t,
  );
  const day = require('dayjs')().startOf('day').subtract(3, 'day'),
    start = day.valueOf();
  const policy = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  await stats.CrontabStatModel.create({
    ref_id: 1,
    date: day.format('YYYY-MM-DD'),
    run_count: 2,
    success_count: 2,
    total_time: 120,
    max_time: 80,
  });
  for (const [id, ms] of [
    ['a', 500],
    ['b', 220],
    ['strong', 150],
  ]) {
    await history.enqueue(id, 1, 'manual', null, start);
    await history.start(id, start, true);
    await history.bindCommand(id, process.pid);
    writeSingleFileExit(id, 0, null, start + ms);
    if (id !== 'strong')
      await fs.writeFile(
        receiptPath(id),
        JSON.stringify({ code: 0, signal: null, time: start + ms }),
      );
    await history.complete(id, 'finished', null, 0, start + ms);
  }
  const totals = async () =>
    (await stats.CrontabStatModel.findAll({ order: [['date', 'ASC']] })).map(
      (s) => [s.date, s.run_count, s.total_time, s.max_time],
    );
  const old = day.format('YYYY-MM-DD'),
    kept = day.add(3, 'day');
  await policy.cleanup({
    runningInstanceRetentionDays: 1,
    cronStatRetentionDays: 7,
  });
  assert.equal((await history.recent(1, 0)).length, 0);
  await Promise.all(
    [1, 2].map(() =>
      history.complete('a', 'failed', null, 17, start + 500, 'legacy'),
    ),
  );
  assert.deepEqual(await totals(), [[old, 4, 490, 220]]);
  await history.complete('b', 'finished', null, 0, start + 221, 'legacy');
  assert.deepEqual(await totals(), [[old, 3, 270, 150]]);
  writeExit('a', 17, null, kept.valueOf() + 10);
  await history.interrupt('http');
  assert.deepEqual(await totals(), [
    [old, 3, 270, 150],
    [
      kept.format('YYYY-MM-DD'),
      1,
      kept.valueOf() + 10 - start,
      kept.valueOf() + 10 - start,
    ],
  ]);
  assert.equal((await history.recent(1, 0)).length, 0);
  await policy.cleanup({
    runningInstanceRetentionDays: 1,
    cronStatRetentionDays: 1,
  });
  await history.complete('b', 'finished', null, 0, start + 220, 'legacy');
  assert.equal((await totals()).length, 1);
  assert.equal((await totals())[0][0], kept.format('YYYY-MM-DD'));
});

test('a conflict invalidates a staged legacy stop while its process tree still needs verification', async (t) => {
  const { db, history, stats, receiptPath, writeExit } = await journalFixture(
    t,
  );
  const id = 'staged-conflict',
    end = Date.now() - 100;
  await history.enqueue(id, 1, 'manual', null, end - 500);
  await history.start(id, end - 500, true);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {}, [
    systemOwner(process.pid),
  ]);
  writeSingleFileExit(id, 17, null, end);
  await fs.writeFile(
    receiptPath(id),
    JSON.stringify({ code: 17, signal: null, time: end }),
  );
  await history.complete(id, 'failed', null, 17, end, 'legacy');
  await history.complete(id, 'failed', null, 23, end, 'legacy');
  await history.interrupt('http');
  assert.equal((await history.recent(1, 0))[0].state, 'running');
  await history.stopVerifiedInstance(instance.id);
  assert.equal((await history.recent(1, 0))[0].reason, 'exit_conflict');
  assert.equal(await stats.CrontabStatModel.count(), 0);
  await fs.unlink(receiptPath(id));
  writeExit(id, 17, null, end);
  await history.retryPendingExits();
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [r.state, r.exit_code]),
    [['stopped', 17]],
  );
  const stat = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [stat.run_count, stat.fail_count, stat.success_count],
    [1, 0, 0],
  );
});

test('instance history hides provisional exits and preserves confirmed siblings', async (t) => {
  const { db, history } = await fixture(t);
  const model = db.models.RunningInstance;
  const make = (cron_id, status) =>
    model.create({
      cron_id,
      status,
      started_at: 100,
      finished_at: 102,
      exit_code: 17,
    });
  const pending = await make(1, 4);
  const confirmed = await make(1, 3);
  const interrupted = await make(1, 4);
  const unrelated = await make(2, 3);
  // A later start can belong to a lower ID (e.g. an imported execution).
  await model.update({ started_at: 101 }, { where: { id: pending.id } });
  await db.query(
    `INSERT INTO CronTriggers(id,cron_id,source,state,reason,observed_at,instance_id,finished_at,exit_code)
    VALUES ('interrupted',1,'manual','unknown','restart',100000,$instance,102000,17)`,
    { bind: { instance: interrupted.id } },
  );
  const [row] = await history.visibleTriggers(1, ['interrupted']);
  assert.deepEqual(
    [row.reason, row.finished_at, row.exit_code],
    ['restart', null, null],
  );
  await db.query(
    `INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,instance_id,exit_pending)
    VALUES ('disputed',1,'manual','unknown',100000,$instance,1)`,
    { bind: { instance: pending.id } },
  );
  const api = load('back/api/cron.ts', {
    '../services/cron': class {},
    '../services/cronView': class {},
    '../data/runningInstance': { RunningInstanceModel: model },
    '../schedule/client': {},
    '../validation/schedule': { commonCronSchema: {} },
  });
  const app = express().use(express.json());
  api.default(app);
  app.use(require('celebrate').errors());
  const server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    'http://127.0.0.1:' + server.address().port + '/crons/1/instances',
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    data
      .sort((a, b) => a.id - b.id)
      .map((row) => [row.id, row.status, row.finished_at, row.exit_code]),
    [
      [pending.id, 4, null, null],
      [confirmed.id, 3, 102, 17],
      [interrupted.id, 4, null, null],
    ],
  );
  const page = async (query) =>
    (await fetch(response.url + '?' + query)).json();
  const legacy = await page('');
  assert.equal(legacy.data[0].id, pending.id);
  for (const query of [
    'limit=1',
    'ids=invalid&before=no',
    'paged=false&limit=0',
  ]) {
    assert.deepEqual(await page(query), legacy);
  }
  assert.equal(Object.hasOwn(legacy, 'next'), false);
  const first = await page('paged=true&limit=2');
  assert.deepEqual(
    first.data.map((row) => row.id),
    [interrupted.id, confirmed.id],
  );
  assert.equal(first.next, confirmed.id);
  await make(1, 3);
  const second = await page('paged=true&limit=2&before=' + first.next);
  assert.deepEqual(
    second.data.map((row) => row.id),
    [pending.id],
  );
  assert.equal(second.next, null);
  const refreshed = await page(
    'paged=true&ids=' + [pending.id, unrelated.id].join(','),
  );
  assert.deepEqual(
    refreshed.data.map((row) => [row.id, row.exit_code]),
    [[pending.id, null]],
  );
  assert.equal((await page('paged=true')).next, null);
  for (const invalid of ['limit=0', 'before=bad', 'ids=bad', 'ids=1&limit=2']) {
    assert.equal(
      (await fetch(response.url + '?paged=true&' + invalid)).status,
      400,
    );
  }
});

for (const scenario of [
  'archive then dispute',
  'expire both then dispute',
  'dispute with retained history',
  'correct to an expired day',
]) {
  test(`cross-day correction after ${scenario} survives cleanup, restart and mixed receipt replay`, async (t) => {
    const { db, history, stats, receiptPath, writeExit, readExit } =
      await journalFixture(t);
    const today = require('dayjs')().startOf('day');
    const original = today.subtract(3, 'day');
    const expiredTarget = scenario === 'correct to an expired day';
    const corrected = today.subtract(expiredTarget ? 2 : 1, 'day');
    const start = original.valueOf() + 1000;
    const end = start + 2000;
    const newEnd = corrected.valueOf() + 3000;
    const id = 'old-execution';
    const keepHistory = scenario === 'dispute with retained history';
    const policy = new (load('back/services/retention.ts', {
      '../data': { sequelize: db },
      '../data/cronStats': stats,
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0 },
      },
      '../data/system': {},
      '../config': {},
    }).default)();
    const cleanup = (historyDays, statDays) =>
      policy.cleanup({
        runningInstanceRetentionDays: historyDays,
        cronStatRetentionDays: statDays,
      });
    const oldReport = (code) =>
      history.complete(
        id,
        code ? 'failed' : 'finished',
        null,
        code,
        end,
        'legacy',
      );
    const ledger = async () =>
      (await stats.CrontabStatModel.findAll({ order: [['date', 'ASC']] })).map(
        (row) => [
          row.date,
          row.run_count,
          row.success_count,
          row.fail_count,
          row.total_time,
          row.max_time,
        ],
      );
    async function startRun(key, time) {
      await history.enqueue(key, 1, 'manual', null, time);
      await history.start(key, time, true);
      await history.bindCommand(key, process.pid);
    }
    // Separate confirmed runs on both days expose double debits and overwritten totals.
    await startRun('original-sibling', start);
    writeExit('original-sibling', 0, null, start + 300);
    await history.interrupt('http');
    const siblingStart = today.valueOf() - 5000;
    await startRun('retained-sibling', siblingStart);
    writeExit('retained-sibling', 0, null, siblingStart + 400);
    await history.interrupt('http');
    await startRun(id, start);
    await fs.writeFile(
      receiptPath(id),
      JSON.stringify({ code: 0, signal: null, time: end }),
    );
    await oldReport(0);
    assert.deepEqual((await ledger())[0], [
      original.format('YYYY-MM-DD'),
      2,
      2,
      0,
      2300,
      2000,
    ]);
    if (!keepHistory)
      await cleanup(1, scenario === 'expire both then dispute' ? 1 : 7);
    await Promise.all([oldReport(17), oldReport(17)]);
    if (scenario !== 'expire both then dispute') {
      assert.deepEqual((await ledger())[0], [
        original.format('YYYY-MM-DD'),
        1,
        1,
        0,
        300,
        300,
      ]);
    }
    await cleanup(keepHistory ? 7 : 1, 1);
    await history.interrupt('http');
    await history.interrupt('http');
    assert.equal(
      (await history.visibleTriggers(1, [id])).length,
      Number(keepHistory),
    );

    writeExit(id, 23, null, newEnd);
    const bound = await readExit(id);
    if (scenario === 'archive then dispute') {
      // No trigger remains. A failed COMMIT must leave the sole recovered receipt usable.
      await db.query('CREATE TABLE required_parent(id INTEGER PRIMARY KEY)');
      await db.query(
        'CREATE TABLE deferred_child(id INTEGER REFERENCES required_parent(id) DEFERRABLE INITIALLY DEFERRED)',
      );
      await db.query(
        'CREATE TRIGGER fail_correction AFTER UPDATE ON CrontabStats BEGIN INSERT INTO deferred_child VALUES(1); END',
      );
      await assert.rejects(
        history.retryPendingExits(),
        /constraint|foreign key/i,
      );
      assert.equal((await readExit(id)).time, newEnd);
      assert.equal((await ledger())[0][1], 1);
      await db.query('DROP TRIGGER fail_correction');
    }
    if (scenario === 'expire both then dispute') {
      await Promise.all([
        history.retryPendingExits(),
        oldReport(0),
        oldReport(17),
        cleanup(1, 1),
        history.complete(id, 'failed', null, 23, newEnd, bound),
        history.interrupt('http'),
      ]);
    } else {
      // A file restored after startup must also settle without another callback.
      await history.retryPendingExits();
    }
    const retainedDay = today.subtract(1, 'day').format('YYYY-MM-DD');
    const duration = newEnd - start;
    const expected = expiredTarget
      ? [[retainedDay, 1, 1, 0, 400, 400]]
      : [[retainedDay, 2, 1, 1, duration + 400, duration]];
    assert.deepEqual(await ledger(), expected);
    assert.equal(await readExit(id), undefined);
    writeExit(id, 23, null, newEnd);
    await Promise.all([
      oldReport(0),
      oldReport(17),
      history.complete(id, 'failed', null, 23, newEnd, bound),
      history.interrupt('http'),
      cleanup(keepHistory ? 7 : 1, 1),
    ]);
    assert.deepEqual(await ledger(), expected);
    const visible = await history.visibleTriggers(1, [id]);
    assert.deepEqual(
      visible.map((row) => [row.state, row.exit_code, row.finished_at]),
      keepHistory ? [['failed', 23, newEnd]] : [],
    );
    const summary = await db.models.Crontab.findByPk(1);
    assert.equal(summary.last_execution_time, Math.floor(siblingStart / 1000));
  });
}

test('a restored bound receipt survives replacement at the instant the weak receipt is retired', async (t) => {
  const { db, history, stats, writeExit, receiptPath } = await journalFixture(
    t,
  );
  const midnight = require('dayjs')().startOf('day').valueOf();
  const id = 'replaced-at-retirement',
    file = receiptPath(id);
  await history.enqueue(id, 1, 'manual', null, midnight - 3000);
  await history.start(id, midnight - 3000, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 17, null, midnight + 100);
  const rename = fs.rename.bind(fs);
  const remove = fs.rm.bind(fs);
  const restored = file + '.test-restore';
  await rename(file, restored);
  await fs.writeFile(
    file,
    JSON.stringify({ code: 0, signal: null, time: midnight - 10 }),
  );
  let replaced = false;
  async function restore(source) {
    if (source !== file || replaced) return;
    replaced = true;
    await rename(restored, file);
  }
  t.mock.method(fs, 'rm', async (source, options) => {
    await restore(source);
    return remove(source, options);
  });
  t.mock.method(fs, 'rename', async (source, dest) => {
    await restore(source);
    await rename(source, dest);
    if (source === file) throw Error('worker exited immediately after rename');
  });
  await history.complete(id, 'finished', null, 0, midnight - 10, 'legacy');
  assert.equal(replaced, true);
  t.mock.restoreAll();
  await history.complete(id, 'failed', null, 23, midnight - 10, 'legacy');
  await new TriggerHistory(db).interrupt('http');
  await history.interrupt('http');
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => [
      r.state,
      r.exit_code,
      r.finished_at,
    ]),
    [['failed', 17, midnight + 100]],
  );
  assert.deepEqual(
    (await stats.CrontabStatModel.findAll()).map((r) => [
      r.date,
      r.run_count,
      r.success_count,
      r.fail_count,
    ]),
    [[require('dayjs')(midnight).format('YYYY-MM-DD'), 1, 0, 1]],
  );
});

test('unavailable retirement storage cannot block a sibling exit during restart or polling', async (t) => {
  const { history, stats, writeExit, receiptPath } = await journalFixture(t);
  const end = Date.now();
  const ids = ['retiring', 'confirmed-sibling'];
  for (const id of ids) {
    await history.enqueue(id, 1, 'manual', null, end - 1000);
    await history.start(id, end - 1000, true);
    await history.bindCommand(id, process.pid);
    writeExit(id, 0, null, end);
  }
  const root = path.dirname(receiptPath(ids[0]));
  const moved = path.join(
    root,
    '.retiring.retiring.' + require('node:crypto').randomUUID(),
  );
  await fs.writeFile(
    moved,
    JSON.stringify({ code: 0, signal: null, time: end }),
  );
  const remove = fs.unlink.bind(fs);
  let disposalAttempts = 0;
  t.mock.method(fs, 'unlink', (file) => {
    if (!path.basename(file).startsWith('.pending.retiring.'))
      return remove(file);
    disposalAttempts++;
    return Promise.reject(
      Object.assign(new Error('temporarily busy'), { code: 'EBUSY' }),
    );
  });
  const list = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (dir, options) => {
    if (path.dirname(dir) === root)
      throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return list(dir, options);
  });
  await history.interrupt('http');
  await history.retryPendingExits();
  assert.ok(disposalAttempts >= 2);
  assert.deepEqual(
    (await history.recent(1, 0)).map((r) => r.state),
    ['finished', 'finished'],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 2);
});

for (const difference of ['code', 'day', 'identical']) {
  test(`canonical and retiring bound receipts converge across reads and replays: ${difference}`, async (t) => {
    const { history, db, stats, writeExit, receiptPath } = await journalFixture(
      t,
    );
    const midnight = require('dayjs')().startOf('day').valueOf();
    const start = midnight - 4000;
    async function launch(id) {
      await history.enqueue(id, 1, 'manual', null, start);
      await history.start(id, start, true);
      await history.bindCommand(id, process.pid);
    }
    await launch('unrelated');
    writeExit('unrelated', 0, null, start + 300);
    await history.interrupt('http');
    const orders = ['both', 'opposite', 'published-first', 'retiring-first'];
    for (const order of orders) {
      const id = 'clash-' + order;
      await launch(id);
      const canonical = receiptPath(id);
      const moved = path.join(
        path.dirname(canonical),
        '.retiring.' + id + '.' + require('node:crypto').randomUUID(),
      );
      const a = [0, null, midnight - 1];
      const b = [
        difference === 'code' ? 23 : 0,
        null,
        difference === 'day' ? midnight + 1 : midnight - 1,
      ];
      const [first, second] = order === 'opposite' ? [b, a] : [a, b];
      writeExit(id, ...first);
      const stagedBytes = await fs.readFile(canonical);
      await fs.rename(canonical, moved);
      if (order === 'retiring-first') await history.interrupt('http');
      if (order === 'published-first') await fs.unlink(moved);
      writeExit(id, ...second);
      const publishedBytes = await fs.readFile(canonical);
      if (order === 'published-first') {
        await history.complete(id, 'unknown', null, null);
        await fs.writeFile(moved, stagedBytes);
      }
      await Promise.all([
        history.interrupt('http'),
        history.retryPendingExits(),
        history.complete(id, 'unknown', null, null),
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        await fs.writeFile(moved, stagedBytes);
        await fs.writeFile(canonical, publishedBytes);
        await new TriggerHistory(db).interrupt('http');
      }
      const [row] = await history.visibleTriggers(1, [id]);
      if (difference === 'identical') {
        assert.deepEqual(
          [row.state, row.finished_at, row.exit_code],
          ['finished', midnight - 1, 0],
          order,
        );
        await assert.rejects(fs.stat(moved), { code: 'ENOENT' });
        await assert.rejects(fs.stat(canonical), { code: 'ENOENT' });
      } else {
        assert.deepEqual(
          [row.state, row.reason, row.finished_at, row.exit_code],
          ['unknown', 'exit_conflict', null, null],
          order,
        );
        assert.deepEqual(await fs.readFile(canonical), publishedBytes);
        assert.deepEqual(await fs.readFile(moved), stagedBytes);
      }
    }
    const [total] = await stats.CrontabStatModel.findAll();
    const count = difference === 'identical' ? orders.length : 0;
    assert.deepEqual(
      [
        total.run_count,
        total.success_count,
        total.fail_count,
        total.total_time,
        total.max_time,
      ],
      [1 + count, 1 + count, 0, 300 + count * 3999, count ? 3999 : 300],
    );
    assert.equal(await stats.CrontabStatModel.count(), 1);
  });
}

test('late bound conflict after pruning debits only a retained contribution and keeps both dates closed to replay', async (t) => {
  const { db, history, stats, writeExit, receiptPath } = await journalFixture(
    t,
  );
  const today = require('dayjs')().startOf('day'),
    old = today.subtract(3, 'day');
  const retained = today.subtract(1, 'day').valueOf() + 100;
  const policy = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  for (const [id, end] of [
    ['system-cli-expired-bound', old.valueOf() + 100],
    ['system-cli-archived-bound', retained],
  ]) {
    await history.enqueue(id, 1, 'manual', null, old.valueOf());
    await history.start(id, old.valueOf(), true);
    await history.bindCommand(id, process.pid);
    writeExit(id, 0, null, end);
    await history.complete(id, 'unknown', null, null);
  }
  const clean = () =>
    policy.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 1,
    });
  await clean();
  assert.equal((await history.recent(1, 0)).length, 0);
  for (const id of ['system-cli-expired-bound', 'system-cli-archived-bound']) {
    const file = receiptPath(id);
    const end =
      id === 'system-cli-expired-bound' ? old.valueOf() + 100 : retained;
    writeExit(id, 0, null, end);
    const moved = path.join(
      path.dirname(file),
      '.retiring.' + id + '.' + require('node:crypto').randomUUID(),
    );
    await fs.rename(file, moved);
    writeExit(id, 17, null, today.valueOf() + 100);
    await Promise.all([
      history.interrupt('http'),
      history.retryPendingExits(),
      clean(),
    ]);
    await history.interrupt('http');
    assert.equal(JSON.parse(await fs.readFile(moved)).code, 0);
    assert.equal(JSON.parse(await fs.readFile(file)).code, 17);
    // Once the conflict was observed it survives loss of one copy, even if
    // the trigger and its entire original ledger had expired before detection.
    await fs.unlink(moved);
    const now = Date.now();
    await Promise.all([
      history.interrupt('http'),
      history.reportInstance(
        id,
        1,
        false,
        process.pid,
        'replayed.log',
        Math.floor(now / 1000),
        1,
        0,
        false,
        now,
      ),
      history.recordShellResult(id, 1, 0, 1000, now, now),
    ]);

    assert.equal(JSON.parse(await fs.readFile(file)).code, 17);
  }
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.equal((await history.recent(1, 0)).length, 0);
});

test('a failed conflict commit retains both bound files and rolls back its debit and evidence together', async (t) => {
  const { history, db, stats, writeExit, receiptPath } = await journalFixture(
    t,
  );
  const id = 'bound-conflict-rollback',
    end = Date.now() - 100;
  await history.enqueue(id, 1, 'manual', null, end - 500);
  await history.start(id, end - 500, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 0, null, end);
  await history.complete(id, 'finished', null, 0);
  writeExit(id, 0, null, end);
  const file = receiptPath(id);
  const moved = path.join(
    path.dirname(file),
    '.retiring.' + id + '.' + require('node:crypto').randomUUID(),
  );
  await fs.rename(file, moved);
  writeExit(id, 17, null, end + 10);
  await db.query('CREATE TABLE required_parent(id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE deferred_child(id INTEGER REFERENCES required_parent(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    'CREATE TRIGGER fail_dispute AFTER INSERT ON CronBoundExitConflicts BEGIN INSERT INTO deferred_child VALUES(1); END',
  );
  await assert.rejects(history.interrupt('http'), /constraint|foreign key/i);
  assert.equal((await stats.CrontabStatModel.findOne()).success_count, 1);
  assert.equal((await history.visibleTriggers(1, [id]))[0].state, 'finished');
  assert.equal(JSON.parse(await fs.readFile(moved)).code, 0);
  assert.equal(JSON.parse(await fs.readFile(file)).code, 17);
  await db.query('DROP TRIGGER fail_dispute');
  await Promise.all([history.retryPendingExits(), history.interrupt('http')]);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.equal(
    (await history.visibleTriggers(1, [id]))[0].reason,
    'exit_conflict',
  );
});

test('a pre-upgrade aggregate without a per-execution booking survives conflicting bound evidence', async (t) => {
  const { history, db, stats, writeExit, receiptPath } = await journalFixture(
    t,
  );
  const id = 'pre-upgrade-conflict',
    end = Date.now() - 100;
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  // This models a panel that committed a terminal row and aggregate without recording the receipt provenance.
  await history.complete(id, 'finished', null, 0, end);
  writeExit(id, 0, null, end);
  const file = receiptPath(id);
  await fs.rename(
    file,
    path.join(
      path.dirname(file),
      '.retiring.' + id + '.' + require('node:crypto').randomUUID(),
    ),
  );
  writeExit(id, 23, null, end);
  await history.interrupt('http');
  await history.interrupt('http');
  assert.equal(
    (await history.visibleTriggers(1, [id]))[0].reason,
    'exit_conflict',
  );
  const daily = await stats.CrontabStatModel.findOne();
  assert.deepEqual(
    [daily.run_count, daily.success_count, daily.fail_count, daily.total_time],
    [1, 1, 0, 1000],
  );
});

for (const rollback of [false, true]) {
  test(`third bound receipt during withdrawal survives commit, replay and history cleanup: rollback=${rollback}`, async (t) => {
    const { db, history, writeExit, receiptPath, readExit, stats } =
      await journalFixture(t);
    const id = 'three-receipts',
      midnight = require('dayjs')().startOf('day').valueOf();
    const old = midnight - 3 * 86400000,
      file = receiptPath(id);
    for (const task of [id, 'independent']) {
      await history.enqueue(task, 1, 'manual', null, old);
      await history.start(task, old, true);
      await history.bindCommand(task, process.pid);
      writeExit(task, 0, null, old + 200);
      await history.complete(task, 'unknown', null, null);
    }
    writeExit(id, 17, null, midnight - 1);
    const second = await readExit(id);
    const policy = new (load('back/services/retention.ts', {
      '../data': { sequelize: db },
      '../data/cronStats': stats,
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0 },
      },
      '../data/system': {},
      '../config': {},
    }).default)();
    if (rollback) {
      await db.query('CREATE TABLE third_parent(id INTEGER PRIMARY KEY)');
      await db.query(
        'CREATE TABLE third_child(id INTEGER REFERENCES third_parent(id) DEFERRABLE INITIALLY DEFERRED)',
      );
      await db.query(
        'CREATE TRIGGER third_failure AFTER INSERT ON CronBoundExitConflicts BEGIN INSERT INTO third_child VALUES(1); END',
      );
    }
    let injected = false;
    const query = db.query.bind(db);
    const hook = t.mock.method(db, 'query', async (sql, ...args) => {
      const result = await query(sql, ...args);
      if (
        !injected &&
        /^DELETE FROM CronLegacyExitBookings WHERE/.test(
          String(sql).replace(/[`"]/g, ''),
        )
      ) {
        injected = true;
        writeExit(id, 23, null, midnight + 1);
        writeExit(id, 23, null, midnight + 1);
      }
      return result;
    });
    if (rollback) {
      await assert.rejects(
        history.interrupt('http'),
        /constraint|foreign key/i,
      );
      assert.equal((await stats.CrontabStatModel.findOne()).run_count, 2);
      await db.query('DROP TRIGGER third_failure');
    } else await history.interrupt('http');
    assert.ok(injected);
    hook.mock.restore();
    for (let pass = 0; pass < 2; pass++) {
      await Promise.all([
        new TriggerHistory(db).interrupt('http'),
        history.retryPendingExits(),
        history.complete(id, 'failed', null, second.code, second.time, second),
      ]);
      const day = await stats.CrontabStatModel.findOne();
      assert.deepEqual(
        [day.run_count, day.success_count, day.total_time],
        [1, 1, 200],
      );
    }
    assert.equal(
      (await history.visibleTriggers(1, [id]))[0].reason,
      'exit_conflict',
    );
    await policy.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 1,
    });
    // When only the canonical path is restored later, polling must still ingest it.
    for (const entry of await fs.readdir(path.dirname(file)))
      await fs.unlink(path.join(path.dirname(file), entry));
    writeExit(id, null, 'SIGTERM', midnight + 2);
    await history.retryPendingExits();
    await fs.unlink(file);
    await new TriggerHistory(db).interrupt('http');
    const evidence = await db.query(
      'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
      { bind: { id }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(
      evidence.map((e) => [e.outcome, e.finished_at]),
      [
        ['0', old + 200],
        ['17', midnight - 1],
        ['23', midnight + 1],
        ['SIGTERM', midnight + 2],
      ],
    );
    assert.equal(await stats.CrontabStatModel.count(), 0);
  });
}

test('a stale collector cannot unlink a third bound publication restored at the retirement path', async (t) => {
  const {
    db,
    history,
    receiptPath,
    writeExit,
    readExit,
    retiringExits,
    stats,
  } = await journalFixture(t);
  const id = 'collector-race',
    end = Date.now() - 1000,
    file = receiptPath(id);
  await history.enqueue(id, 1, 'manual', null, end - 200);
  await history.start(id, end - 200, true);
  await history.bindCommand(id, process.pid);
  writeExit(id, 0, null, end);
  await history.complete(id, 'finished', null, 0);
  writeExit(id, 0, null, end);
  const restored = path.join(
    path.dirname(file),
    '.retiring.' + id + '.' + require('node:crypto').randomUUID(),
  );
  await fs.rename(file, restored);
  const rename = fs.rename.bind(fs);
  let resume, entered;
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const release = new Promise((resolve) => {
    resume = resolve;
  });
  let intercepted = false;
  t.mock.method(fs, 'rename', async (src, dest) => {
    if (src === restored && !intercepted) {
      intercepted = true;
      entered();
      await release;
    }
    return rename(src, dest);
  });
  const stale = history.retryPendingExits();
  try {
    await Promise.race([
      paused,
      stale.then(() => {
        throw Error('missing retirement barrier');
      }),
    ]);
    writeExit(id, 17, null, end + 1);
    await history.complete(id, 'unknown', null, null);
    assert.equal(
      (await history.visibleTriggers(1, [id]))[0].reason,
      'exit_conflict',
    );
    // Replace the exact public path that the stale worker is about to claim.
    const third = {
      code: 23,
      signal: null,
      time: end + 2,
      version: 1,
      checksum: require('node:crypto')
        .createHash('sha256')
        .update(JSON.stringify([id, 23, null, end + 2]))
        .digest('hex'),
    };
    await fs.writeFile(restored + '.restore', JSON.stringify(third));
    await rename(restored + '.restore', restored);
  } finally {
    resume();
  }
  await stale;
  assert.ok(
    (
      await Promise.all(
        (await retiringExits()).map((copy) => readExit(id, copy.file)),
      )
    ).some((exit) => exit?.code === 23),
  );
  await Promise.all([
    new TriggerHistory(db).interrupt('http'),
    history.retryPendingExits(),
  ]);
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome FROM CronBoundExitConflicts ORDER BY finished_at',
        { type: QueryTypes.SELECT },
      )
    ).map((v) => v.outcome),
    ['0', '17', '23'],
  );
  assert.equal(await stats.CrontabStatModel.count(), 0);
});

test('upgrading the two-tuple conflict journal retains both outcomes when a third arrives only as a supervisor message', async (t) => {
  const { db, history } = await journalFixture(t);
  const id = 'archived-conflict';
  await db.query('DROP TABLE CronBoundExitConflicts');
  await db.query(
    'CREATE TABLE CronBoundExitConflicts(trigger_id TEXT PRIMARY KEY,outcome TEXT,finished_at INTEGER,other_outcome TEXT,other_finished_at INTEGER) WITHOUT ROWID',
  );
  await db.query(
    "INSERT INTO CronBoundExitConflicts VALUES($id,'0',1000,'17',1001)",
    { bind: { id } },
  );
  await db.transaction((tx) => installTriggerHistory(db, tx));
  const third = { code: null, signal: 'SIGTERM', time: 1002, version: 1 };
  await Promise.all([
    history.complete(id, 'failed', 'SIGTERM', null, 1002, third),
    history.complete(id, 'failed', 'SIGTERM', null, 1002, third),
  ]);
  await db.transaction((tx) => installTriggerHistory(db, tx));
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome,finished_at FROM CronBoundExitConflicts ORDER BY finished_at',
        { type: QueryTypes.SELECT },
      )
    ).map((v) => [v.outcome, v.finished_at]),
    [
      ['0', 1000],
      ['17', 1001],
      ['SIGTERM', 1002],
    ],
  );
  assert.deepEqual(await history.visibleTriggers(1, [id]), []);
  assert.equal(await db.models.CrontabStat.count(), 0);
});

test('a Python supervisor and a reporter killed before SQLite accepts its message preserve every distinct exit', async (t) => {
  const { db, history, root, writeExit, receiptPath, readExit, retiringExits } =
    await journalFixture(t);
  const id = 'orphan-withdrawal',
    time = Date.now() - 5000;
  const file = receiptPath(id);
  writeExit(id, 0, null, time);
  writeExit(id, 17, null, time + 1);
  await history.interrupt('http');
  const env = { ...process.env, QL_TRIGGER_ID: id };
  const { spawnSync, spawn } = require('node:child_process');
  const supervisor = spawnSync(
    'python3',
    [
      '-I',
      '-S',
      path.resolve('shell/cron-command.py'),
      'exit 23',
      String(process.pid),
      file,
      process.execPath,
      require.resolve('../../back/shared/managedExit.cjs'),
    ],
    { env, input: 'run\n', encoding: 'utf8' },
  );
  assert.equal(supervisor.status, 23, supervisor.stderr);
  const copies = await Promise.all(
    (await retiringExits()).map((c) => readExit(id, c.file)),
  );
  assert.ok(copies.some((copy) => copy?.code === 23));
  await fs.writeFile(path.join(root, '.env'), '');
  await fs.symlink(
    path.join(root, 'database.sqlite'),
    path.join(root, 'db', 'database.sqlite'),
  );
  const code = 29,
    end = time + 2;
  const checksum = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify([id, code, null, end]))
    .digest('hex');
  const message = JSON.stringify({
    code,
    signal: null,
    time: end,
    checksum,
    version: 1,
  });
  await db.transaction(async () => {
    const child = spawn(
      process.execPath,
      [require.resolve('../../back/shared/managedExit.cjs'), message],
      { env, stdio: 'ignore' },
    );
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      const until = Date.now() + 5000;
      let found = false;
      while (!found && Date.now() < until) {
        const copies = await Promise.all(
          (await retiringExits()).map((copy) => readExit(id, copy.file)),
        );
        found = copies.some((copy) => copy?.code === code && copy.time === end);
        if (!found) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(found, 'the message is on disk before SQLite accepts it');
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  });
  await new TriggerHistory(db).interrupt('http');
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome FROM CronBoundExitConflicts ORDER BY CAST(outcome AS INTEGER)',
        { type: QueryTypes.SELECT },
      )
    ).map((v) => v.outcome),
    ['0', '17', '23', '29'],
  );
  assert.equal(await db.models.CrontabStat.count(), 0);
});

for (const occupied of [
  'damaged',
  'different valid result',
  'symlink to a sibling receipt',
]) {
  test(`concurrent orphan reports survive a kill before SQLite with an occupied alternate: ${occupied}`, async (t) => {
    const {
      history,
      db,
      root,
      writeExit,
      readExit,
      receiptPath,
      retiringExits,
      stats,
    } = await journalFixture(t);
    const id = 'occupied-alternate',
      midnight = require('dayjs')().startOf('day').valueOf();
    const file = receiptPath(id),
      end = midnight + 100;
    const make = (code, time) => ({
      version: 1,
      code,
      signal: null,
      time,
      checksum: require('node:crypto')
        .createHash('sha256')
        .update(JSON.stringify([id, code, null, time]))
        .digest('hex'),
    });
    for (const key of [id, 'healthy-sibling']) {
      await history.enqueue(key, 1, 'manual', null, midnight - 1000);
      await history.start(key, midnight - 1000, true);
      writeExit(key, 0, null, midnight - 10);
      await history.complete(key, 'unknown', null, null);
    }
    writeExit(id, 17, null, end);
    await history.interrupt('http');
    const third = make(23, end + 100),
      fourth = make(31, end + 200);
    const alternate = path.join(
      path.dirname(file),
      '.published.' + id + '.' + third.checksum,
    );
    const occupant =
      occupied === 'damaged' ? '{"version":' : JSON.stringify(fourth);
    if (occupied === 'symlink to a sibling receipt') {
      const sibling = path.join(root, 'sibling-receipt');
      const checksum = require('node:crypto')
        .createHash('sha256')
        .update(
          JSON.stringify(['healthy-sibling', fourth.code, null, fourth.time]),
        )
        .digest('hex');
      await fs.writeFile(sibling, JSON.stringify({ ...fourth, checksum }));
      await fs.symlink(sibling, alternate);
    } else await fs.writeFile(alternate, occupant);
    const originalBytes = await fs.readFile(alternate);
    // Stop at the real reporter's first database import, after its filesystem publication.
    const barrier = path.join(root, 'before-database.cjs');
    await fs.writeFile(
      barrier,
      `const Module=require('node:module'), load=Module._load;
      Module._load=function(name,...args) {
        if (name === '../cron/history') {
          require('node:fs').writeFileSync(process.env.ARRIVED, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        }
        return load.call(this,name,...args);
      };`,
    );
    const children = [1, 2].map((index) => {
      const arrived = path.join(root, 'reporter-' + index);
      const child = require('node:child_process').spawn(
        process.execPath,
        [
          '--require',
          barrier,
          require.resolve('../../back/shared/managedExit.cjs'),
          JSON.stringify(third),
        ],
        {
          env: { ...process.env, QL_TRIGGER_ID: id, ARRIVED: arrived },
          stdio: 'ignore',
        },
      );
      return {
        arrived,
        child,
        closed: new Promise((resolve) => child.once('close', resolve)),
      };
    });
    try {
      const deadline = Date.now() + 10000;
      while (
        Date.now() < deadline &&
        !children.every((c) => require('node:fs').existsSync(c.arrived))
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(
        children.every((c) => require('node:fs').existsSync(c.arrived)),
      );
    } finally {
      for (const c of children) c.child.kill('SIGKILL');
      await Promise.all(children.map((c) => c.closed));
    }
    const diskEvidence = async () =>
      (
        await Promise.all(
          (await retiringExits()).map((c) => readExit(id, c.file)),
        )
      ).filter((c) => c?.code === third.code && c.time === third.time);
    assert.ok(
      (await diskEvidence()).length > 0,
      'third tuple must already be recoverable without a database commit',
    );
    assert.deepEqual(await fs.readFile(alternate), originalBytes);
    for (let attempt = 0; attempt < 3; attempt++) {
      writeExit(id, third.code, null, third.time);
      await Promise.all([
        new TriggerHistory(db).interrupt('http'),
        history.retryPendingExits(),
      ]);
      assert.equal(
        (await diskEvidence()).length,
        1,
        'retain one physical witness per distinct retry result',
      );
    }
    const rows = await db.query(
      'SELECT outcome FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
      { bind: { id }, type: QueryTypes.SELECT },
    );
    assert.deepEqual(
      rows.map((row) => row.outcome),
      occupied === 'different valid result'
        ? ['0', '17', '23', '31']
        : ['0', '17', '23'],
    );
    assert.deepEqual(await fs.readFile(alternate), originalBytes);
    assert.equal(
      (await fs.lstat(alternate)).isSymbolicLink(),
      occupied === 'symlink to a sibling receipt',
    );
    assert.equal(
      (await history.visibleTriggers(1, [id]))[0].reason,
      'exit_conflict',
    );
    const [stat] = await stats.CrontabStatModel.findAll();
    assert.deepEqual(
      [stat.run_count, stat.success_count, stat.total_time],
      [1, 1, 990],
    );
    assert.equal(await stats.CrontabStatModel.count(), 1);
  });
}

for (const runtime of ['node', 'python']) {
  test(`a fully written ${runtime} receipt survives SIGKILL before its first link`, async (t) => {
    const { history, db, writeExit, receiptPath, retiringExits, readExit } =
      await journalFixture(t);
    const id = 'prelink-' + runtime,
      file = receiptPath(id),
      end = Date.now() - 10;
    writeExit(id, 0, null, end - 2);
    writeExit(id, 17, null, end - 1);
    await history.interrupt('http');
    const checksum = require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify([id, 23, null, end]))
      .digest('hex');
    const oldPath = path.join(
      path.dirname(file),
      '.published.' + id + '.' + checksum,
    );
    await fs.writeFile(oldPath, 'damaged');
    await fs.unlink(file); // Exercise first-link publication at an unoccupied compatibility path.
    const result =
      runtime === 'node'
        ? require('node:child_process').spawnSync(process.execPath, [
            '-e',
            `
        require('node:fs').linkSync=()=>process.kill(process.pid,'SIGKILL');
        require(process.argv[1]).writeExit(process.argv[2],23,null,Number(process.argv[3]));
      `,
            require.resolve('../../back/cron/settlement/exitReceipt.cjs'),
            id,
            String(end),
          ])
        : require('node:child_process').spawnSync(
            'python3',
            [
              '-I',
              '-S',
              '-c',
              `
import os,runpy,sys,time,signal
fixed_time=int(sys.argv[-1])*1000000
time.time_ns=lambda: fixed_time
os.link=lambda *args: os.kill(os.getpid(),signal.SIGKILL)
sys.argv=sys.argv[1:-1]
runpy.run_path(sys.argv[0],run_name='__main__')
      `,
              path.resolve('shell/cron-command.py'),
              'exit 23',
              String(process.pid),
              file,
              process.execPath,
              'unused',
              String(end),
            ],
            {
              env: { ...process.env, QL_TRIGGER_ID: id },
              input: 'run\n',
              encoding: 'utf8',
            },
          );
    assert.equal(result.signal, 'SIGKILL', String(result.stderr));
    const copies = await Promise.all(
      (await retiringExits()).map((copy) => readExit(id, copy.file)),
    );
    assert.ok(copies.some((copy) => copy?.code === 23 && copy.time === end));
    await new TriggerHistory(db).interrupt('http');
    assert.equal(await fs.readFile(oldPath, 'utf8'), 'damaged');
    const rows = await db.query(
      'SELECT outcome FROM CronBoundExitConflicts ORDER BY finished_at',
      { type: QueryTypes.SELECT },
    );
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['0', '17', '23'],
    );
  });
}

test('a failed append to an existing dispute cannot reclaim uncommitted retries', async (t) => {
  const { history, db, writeExit, retiringExits, readExit } =
    await journalFixture(t);
  const id = 'failed-retry-commit',
    time = Date.now() - 100;
  writeExit(id, 0, null, time);
  writeExit(id, 17, null, time);
  await history.interrupt('http');
  writeExit(id, 23, null, time);
  writeExit(id, 23, null, time);
  const copies = async () =>
    (
      await Promise.all(
        (await retiringExits()).map((c) => readExit(id, c.file)),
      )
    ).filter((c) => c?.code === 23);
  const before = (await copies()).map((copy) => copy.file).sort();
  assert.equal(before.length, 6); // Each retry has a marker, JSON body and legacy-compatible link.
  await db.query('CREATE TABLE failed_append_parent (id INTEGER PRIMARY KEY)');
  await db.query(
    'CREATE TABLE failed_append_child (id INTEGER REFERENCES failed_append_parent(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await db.query(
    "CREATE TRIGGER reject_append AFTER INSERT ON CronBoundExitConflicts WHEN NEW.outcome='23' BEGIN INSERT INTO failed_append_child VALUES(1); END",
  );
  await assert.rejects(history.interrupt('http'), /constraint|foreign key/i);
  assert.deepEqual((await copies()).map((copy) => copy.file).sort(), before);
  await db.query('DROP TRIGGER reject_append');
  await new TriggerHistory(db).interrupt('http');
  assert.equal((await copies()).length, 1);
  assert.equal(
    (
      await db.query('SELECT outcome FROM CronBoundExitConflicts', {
        type: QueryTypes.SELECT,
      })
    ).length,
    3,
  );
});

test('replacing the selected witness before duplicate cleanup preserves the other verified copy', async (t) => {
  const { history, db, writeExit, retiringExits, readExit, isMetadataReceipt } =
    await journalFixture(t);
  const id = 'replace-before-cleanup',
    time = Date.now();
  writeExit(id, 0, null, time);
  writeExit(id, 17, null, time);
  await history.interrupt('http');
  writeExit(id, 23, null, time);
  writeExit(id, 23, null, time);
  const witnesses = (
    await Promise.all((await retiringExits()).map((c) => readExit(id, c.file)))
  )
    .filter((c) => c?.code === 23 && !isMetadataReceipt(c.file))
    .map((c) => c.file)
    .sort();
  assert.equal(witnesses.length, 2);
  const query = db.query.bind(db);
  let replaced = false;
  const hook = t.mock.method(db, 'query', async (sql, ...args) => {
    const result = await query(sql, ...args);
    if (
      !replaced &&
      String(sql)
        .replace(/[`"]/g, '')
        .includes('INSERT OR IGNORE INTO CronBoundExitConflicts')
    ) {
      replaced = true;
      await fs.writeFile(
        witnesses[0] + '.restore',
        '{"code":0,"signal":null,"time":123}',
      );
      await fs.rename(witnesses[0] + '.restore', witnesses[0]);
    }
    return result;
  });
  await history.interrupt('http');
  hook.mock.restore();
  await history.retryPendingExits();
  assert.ok(replaced);
  assert.equal((await readExit(id, witnesses[1])).code, 23);
  assert.equal((await readExit(id, witnesses[0])).version, undefined);
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome FROM CronBoundExitConflicts ORDER BY CAST(outcome AS INTEGER)',
        { type: QueryTypes.SELECT },
      )
    ).map((r) => r.outcome),
    ['0', '17', '23'],
  );
});

test('an incomplete private publication cannot book the supervisor exit while the real result is unavailable', async (t) => {
  const { history, db, receiptPath, writeExit, stats } = await journalFixture(
    t,
  );
  const id = 'incomplete-retry',
    end = Date.now() - 3 * 86400000;
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  const file = receiptPath(id),
    dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const pending = path.join(
    dir,
    '.pending.' + id + '.' + require('node:crypto').randomUUID(),
  );
  await fs.writeFile(pending, '{"code":23');
  await history.complete(id, 'failed', 'SIGKILL', null, end + 1);
  const [unresolved] = await history.visibleTriggers(1, [id]);
  assert.deepEqual(
    [unresolved.state, unresolved.reason, unresolved.finished_at],
    ['unknown', 'exit_pending', null],
  );
  assert.equal(await stats.CrontabStatModel.count(), 0);
  // An earlier worker may already have recorded unknown without the pending flag.
  await db.query(
    'UPDATE CronTriggers SET exit_pending=NULL,finished_at=$end WHERE id=$id',
    { bind: { id, end } },
  );
  const policy = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  await policy.cleanup({
    runningInstanceRetentionDays: 1,
    cronStatRetentionDays: 7,
  });
  assert.equal(
    (await history.visibleTriggers(1, [id]))[0].reason,
    'exit_pending',
  );
  await new TriggerHistory(db).interrupt('http');
  writeExit(id, 23, null, end);
  await fs.rename(file, pending);
  await history.retryPendingExits();
  const [row] = await history.visibleTriggers(1, [id]);
  assert.deepEqual(
    [row.state, row.exit_code, row.finished_at],
    ['failed', 23, end],
  );
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
});

function publishFromPeer(id, code, time) {
  const { execFile } = require('node:child_process');
  return require('node:util').promisify(execFile)(process.execPath, [
    '-e',
    'require(process.argv[1]).writeExit(process.argv[2],Number(process.argv[3]),null,Number(process.argv[4]))',
    require.resolve('../../back/cron/settlement/exitReceipt.cjs'),
    id,
    String(code),
    String(time),
  ]);
}

const receiptBoundaries = {
  settle: [
    'booking',
    'claim',
    'increment',
    'commit',
    'move',
    'readClaim',
    'unlink',
  ],
  withdraw: ['dispute', 'debit', 'commit'],
  prune: [
    'deleteDay',
    'cutoff',
    'historyCutoff',
    'deleteHistory',
    'pruneBooking',
    'commit',
  ],
};
for (const [operation, stages] of Object.entries(receiptBoundaries)) {
  for (const stage of stages)
    for (const side of ['before', 'after']) {
      test(`receipt boundary ${operation}/${stage}/${side}: kill with a replacement and two retry processes`, async (t) => {
        const { root, db, history, receiptPath, writeExit, stats } =
          await journalFixture(t);
        const id = 'boundary',
          day = require('dayjs')().startOf('day');
        const old = day.subtract(3, 'day').valueOf() + 1000,
          fresh = day.valueOf() + 1;
        for (const [key, time] of [
          ['sibling', fresh],
          [id, old],
        ]) {
          await history.enqueue(key, 1, 'manual', null, time - 1000);
          await history.start(key, time - 1000, true);
          writeExit(key, 0, null, time);
          if (key === 'sibling' || operation !== 'settle')
            await history.complete(key, 'unknown', null, null);
        }
        if (operation === 'withdraw') writeExit(id, 17, null, old + 1);
        const child = require('node:child_process').spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            require.resolve('../helpers/receipt-boundary-worker.cjs'),
            operation,
            stage,
            side,
            id,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        const closed = new Promise((resolve) =>
          child.once('close', (code, signal) => resolve({ code, signal })),
        );
        let wasGone;
        let receiptsSettled;
        try {
          const marker = path.join(root, 'at-barrier');
          const deadline = Date.now() + 15000;
          while (
            !require('node:fs').existsSync(marker) &&
            child.exitCode === null &&
            Date.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            await fs.readFile(marker, 'utf8').catch(() => stderr),
            stage + '/' + side,
          );
          // Read through an independent connection while the worker is stopped
          // at the barrier. Partial SQL effects must remain invisible.
          const committed = stage === 'commit' && side === 'after';
          const inCollector = ['move', 'readClaim', 'unlink'].includes(stage);
          const oldDayVisible =
            operation === 'settle' ? committed || inCollector : !committed;
          const ledger = (
            await stats.CrontabStatModel.findAll({ order: [['date', 'ASC']] })
          ).map((r) => [r.date, r.run_count, r.success_count]);
          const oldDay = require('dayjs')(old).format('YYYY-MM-DD');
          assert.deepEqual(ledger, [
            ...(oldDayVisible ? [[oldDay, 1, 1]] : []),
            [day.format('YYYY-MM-DD'), 1, 1],
          ]);
          wasGone = !(await history.visibleTriggers(1, [id])).length;
          const canonical = receiptPath(id);
          // Replace atomically using the genuine SHA256 tuple for this ID. Two
          // other processes publish the competing tuple before killing the worker.
          const replacement = {
            code: 23,
            signal: null,
            time: fresh,
            version: 1,
            checksum: require('node:crypto')
              .createHash('sha256')
              .update(JSON.stringify([id, 23, null, fresh]))
              .digest('hex'),
          };
          await fs.writeFile(
            canonical + '.restore',
            JSON.stringify(replacement),
          );
          await fs.rename(canonical + '.restore', canonical);
          await Promise.all([
            publishFromPeer(id, 0, old),
            publishFromPeer(id, 0, old),
          ]);
          // Let two independent SQLite connections start retrying while the
          // interrupted worker is still alive, including after its COMMIT.
          let began = 0,
            release;
          const bothAtBegin = new Promise((resolve) => {
            release = resolve;
          });
          const query = db.query.bind(db);
          const gate = t.mock.method(db, 'query', (sql, ...args) => {
            const pending = query(sql, ...args);
            if (String(sql).startsWith('BEGIN') && ++began === 2) release();
            return pending;
          });
          receiptsSettled = Promise.allSettled(
            [1, 2].map(() =>
              new TriggerHistory(db).complete(id, 'finished', null, 0, old, {
                version: 1,
                code: 0,
                signal: null,
                time: old,
              }),
            ),
          );
          let timeout;
          try {
            await Promise.race([
              bothAtBegin,
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      Error('Concurrent retry transactions never started'),
                    ),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
            gate.mock.restore();
          }
        } finally {
          child.kill('SIGKILL');
          const result = await closed;
          if (!stderr) assert.equal(result.signal, 'SIGKILL');
          if (receiptsSettled)
            for (const retry of await receiptsSettled)
              assert.equal(retry.status, 'fulfilled', retry.reason);
        }
        const policy = new (load('back/services/retention.ts', {
          '../data': { sequelize: db },
          '../data/cronStats': stats,
          '../data/runningInstance': {
            RunningInstanceModel: db.models.RunningInstance,
            InstanceStatus: { running: 0 },
          },
          '../data/system': {},
          '../config': {},
        }).default)();
        for (let i = 0; i < 2; i++) {
          await new TriggerHistory(db).interrupt('http');
          await Promise.all([
            history.retryPendingExits(),
            history.complete(id, 'unknown', null, null),
          ]);
          assert.deepEqual(
            (await stats.CrontabStatModel.findAll()).map((r) => [
              r.date,
              r.run_count,
            ]),
            [[day.format('YYYY-MM-DD'), 1]],
            'replay must converge even before the next pruning pass',
          );
          await policy.cleanup({
            runningInstanceRetentionDays: 1,
            cronStatRetentionDays: 1,
          });
          const tuples = await db.query(
            'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
            { bind: { id }, type: QueryTypes.SELECT },
          );
          const expected = [
            ['0', old],
            ...(operation === 'withdraw' ? [['17', old + 1]] : []),
            ['23', fresh],
          ];
          assert.deepEqual(
            tuples.map((r) => [r.outcome, r.finished_at]),
            expected,
          );
          const [row] = await history.visibleTriggers(1, [id]);
          if (wasGone) assert.equal(row, undefined);
          else
            assert.deepEqual(
              [row.state, row.reason, row.exit_code],
              ['unknown', 'exit_conflict', null],
            );
          assert.deepEqual(
            (await stats.CrontabStatModel.findAll()).map((r) => [
              r.date,
              r.run_count,
              r.success_count,
              r.fail_count,
            ]),
            [[day.format('YYYY-MM-DD'), 1, 1, 0]],
          );
        }
      });
    }
}

for (const runtime of ['node', 'python']) {
  for (const stage of [
    'before-write',
    'partial',
    'after-write',
    'before-mirror',
    'after-mirror',
    'before-link',
    'after-link',
    'published',
  ]) {
    test(`receipt publication ${runtime}/${stage} with replacement, concurrent retries and SIGKILL`, async (t) => {
      const { root, db, history, receiptPath, stats } = await journalFixture(t);
      const id = 'publication',
        file = receiptPath(id),
        end = Date.now() - 100;
      await history.enqueue(id, 1, 'manual', null, end - 200);
      await history.start(id, end - 200, true);
      const node = runtime === 'node';
      const args = node
        ? [
            require.resolve('../helpers/receipt-publisher-barrier.cjs'),
            stage,
            String(end),
          ]
        : [
            '-I',
            '-S',
            path.resolve('test/helpers/receipt-publisher-barrier.py'),
            stage,
            String(end),
            path.resolve('shell/cron-command.py'),
            file,
            String(process.pid),
          ];
      const child = require('node:child_process').spawn(
        node ? process.execPath : 'python3',
        args,
        {
          env: { ...process.env, QL_TRIGGER_ID: id },
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
      const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve(signal)),
      );
      child.stdin.end('run\n');
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const complete = stage !== 'before-write';
      try {
        const deadline = Date.now() + 10000,
          ready = path.join(root, 'publisher-ready');
        while (
          !require('node:fs').existsSync(ready) &&
          child.exitCode === null &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          await fs.readFile(ready, 'utf8').catch(() => stderr),
          stage,
        );
        await history.bindCommand(id, child.pid);
        const replacement = {
          version: 1,
          code: 17,
          signal: null,
          time: end + 1,
          checksum: require('node:crypto')
            .createHash('sha256')
            .update(JSON.stringify([id, 17, null, end + 1]))
            .digest('hex'),
        };
        // After link, overwrite the compatibility inode in place as well as
        // testing atomic replacement after the publisher has returned.
        if (stage === 'after-link')
          await fs.writeFile(file, JSON.stringify(replacement));
        else {
          await fs.writeFile(file + '.restore', JSON.stringify(replacement));
          await fs.rename(file + '.restore', file);
        }
        await Promise.all([
          publishFromPeer(id, 17, end + 1),
          publishFromPeer(id, 17, end + 1),
        ]);
      } finally {
        child.kill('SIGKILL');
        assert.equal(await closed, 'SIGKILL', stderr);
      }
      await history.complete(id, 'stopped', 'SIGKILL', null);
      for (let retry = 0; retry < 2; retry++) {
        await new TriggerHistory(db).interrupt('http');
        const [row] = await history.visibleTriggers(1, [id]);
        if (complete) {
          assert.deepEqual(
            [row.state, row.reason, row.exit_code],
            ['unknown', 'exit_conflict', null],
          );
          const tuples = await db.query(
            'SELECT outcome,finished_at FROM CronBoundExitConflicts ORDER BY finished_at',
            { type: QueryTypes.SELECT },
          );
          assert.deepEqual(
            tuples.map((r) => [r.outcome, r.finished_at]),
            [
              ['23', end],
              ['17', end + 1],
            ],
          );
          assert.equal(await stats.CrontabStatModel.count(), 0);
        } else {
          assert.deepEqual(
            [row.state, row.exit_code, row.finished_at],
            ['failed', 17, end + 1],
          );
          assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
        }
      }
    });
  }
}

test('a bound supervisor killed without any command receipt stays unknown until its actual exit arrives', async (t) => {
  const { db, history, writeExit, stats } = await journalFixture(t);
  const id = 'killed-before-any-bytes',
    end = Date.now() - 50;
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  await history.complete(id, 'stopped', 'SIGKILL', null);
  await new TriggerHistory(db).interrupt('http');
  const [unknown] = await history.visibleTriggers(1, [id]);
  assert.deepEqual(
    [unknown.state, unknown.reason, unknown.finished_at],
    ['unknown', 'exit_pending', null],
  );
  assert.equal(await stats.CrontabStatModel.count(), 0);
  writeExit(id, 23, null, end);
  await Promise.all([history.retryPendingExits(), history.retryPendingExits()]);
  assert.equal((await history.visibleTriggers(1, [id]))[0].exit_code, 23);
  assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
});

for (const canonical of ['absent', 'damaged']) {
  test(`a verified private receipt with ${canonical} canonical path blocks a stop signal`, async (t) => {
    const { db, history, receiptPath, writeExit } = await journalFixture(t);
    const id = 'stop-after-publication',
      end = Date.now();
    await history.enqueue(id, 1, 'manual', null, end - 1000);
    await history.start(id, end - 1000, true);
    await history.bindCommand(id, process.pid);
    const instance = await db.models.RunningInstance.findOne();
    writeExit(id, 0, null, end);
    if (canonical === 'absent') await fs.unlink(receiptPath(id));
    else await fs.writeFile(receiptPath(id), 'damaged');
    let signals = 0;
    await assert.rejects(
      history.requestInstanceStop(instance.id, process.pid, () => {
        signals++;
      }),
      { code: 'ESRCH' },
    );
    assert.equal(signals, 0);
    assert.equal((await history.visibleTriggers(1, [id]))[0].state, 'finished');
    assert.equal((await db.models.CrontabStat.findOne()).success_count, 1);
  });
}

test('replacing a public collecting file at the last unlink preserves the new bytes', async (t) => {
  const { history, db, receiptPath, retireLegacyFile } = await journalFixture(
    t,
  );
  const id = 'collector-replacement',
    end = Date.now();
  writeSingleFileExit(id, 0, null, end);
  const canonical = receiptPath(id);
  const publicName = path.join(
    path.dirname(canonical),
    '.collecting.' + id + '.' + require('node:crypto').randomUUID(),
  );
  await fs.rename(canonical, publicName);
  writeSingleFileExit(id, 23, null, end + 1);
  const replacement = await fs.readFile(canonical);
  const unlink = fs.unlink.bind(fs),
    remove = fs.rm.bind(fs);
  let injected = false;
  const inject = async (target) => {
    if (injected) return;
    injected = true;
    // Both old public collection names and the canonical name can be restored.
    // A collector-private disposal slot is outside the publication namespace.
    const destination = path.basename(target).startsWith('.collecting.')
      ? target
      : publicName;
    await fs.rename(canonical, destination);
  };
  const deleteFile = t.mock.method(fs, 'unlink', async (file) => {
    await inject(file);
    return unlink(file);
  });
  const removeFile = t.mock.method(fs, 'rm', async (file, ...args) => {
    await inject(file);
    return remove(file, ...args);
  });
  await retireLegacyFile(id, publicName, { outcome: '0', time: end });
  deleteFile.mock.restore();
  removeFile.mock.restore();
  assert.ok(injected);
  assert.deepEqual(await fs.readFile(publicName), replacement);
  writeSingleFileExit(id, 0, null, end);
  await history.interrupt('http');
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome FROM CronBoundExitConflicts ORDER BY finished_at',
        { type: QueryTypes.SELECT },
      )
    ).map((row) => row.outcome),
    ['0', '23'],
  );
});

test('a verified stop settles from the private receipt while the scheduler owner is still live', async (t) => {
  const { db, history, receiptPath, writeExit } = await journalFixture(t);
  const id = 'private-stop-result',
    end = Date.now();
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  await history.bindCommand(id, process.pid);
  const instance = await db.models.RunningInstance.findOne();
  await history.requestInstanceStop(instance.id, process.pid, () => {}, [
    systemOwner(process.pid),
  ]);
  writeExit(id, 143, null, end);
  await fs.unlink(receiptPath(id));
  for (let retry = 0; retry < 2; retry++) {
    await history.stopVerifiedInstance(instance.id);
    const [row] = await history.visibleTriggers(1, [id]);
    assert.deepEqual(
      [row.state, row.exit_code, row.finished_at],
      ['stopped', 143, end],
    );
    assert.equal((await db.models.CrontabStat.findOne()).run_count, 1);
  }
});

for (const full of ['ENOSPC', 'EDQUOT']) {
  test(`a short JSON write with ${full} replays the exact day once and reclaims both publications`, async (t) => {
    const {
      history,
      db,
      stats,
      readExit,
      retiringExits,
      receiptPath,
      writeExit,
    } = await journalFixture(t);
    const id = 'short-body',
      day = require('dayjs')().startOf('day'),
      end = day.valueOf() - 100;
    await history.enqueue(id, 1, 'manual', null, end - 1000);
    await history.start(id, end - 1000, true);
    const sync = require('node:fs'),
      write = sync.writeFileSync;
    const hook = t.mock.method(
      sync,
      'writeFileSync',
      (file, content, options) => {
        if (content && path.dirname(file) === path.dirname(receiptPath(id))) {
          write(file, content.slice(0, 12), options);
          throw Object.assign(Error('no data blocks'), { code: full });
        }
        return write(file, content, options);
      },
    );
    writeExit(id, 23, null, end);
    hook.mock.restore();
    const files = await retiringExits();
    assert.deepEqual(
      (await Promise.all(files.map((copy) => fs.stat(copy.file))))
        .map((s) => s.size)
        .sort((a, b) => a - b),
      [0, 12],
    );
    for (const copy of files) {
      const observed = await readExit(id, copy.file);
      assert.deepEqual([observed.code, observed.time], [23, end]);
    }
    await Promise.all([
      new TriggerHistory(db).interrupt('http'),
      history.retryPendingExits(),
    ]);
    await Promise.all([
      publishFromPeer(id, 23, end),
      publishFromPeer(id, 23, end),
    ]);
    await new TriggerHistory(db).interrupt('http');
    const [result] = await history.visibleTriggers(1, [id]);
    assert.deepEqual(
      [result.state, result.exit_code, result.finished_at],
      ['failed', 23, end],
    );
    assert.deepEqual(
      (await stats.CrontabStatModel.findAll()).map((r) => [
        r.date,
        r.run_count,
        r.fail_count,
      ]),
      [[day.subtract(1, 'day').format('YYYY-MM-DD'), 1, 1]],
    );
    assert.deepEqual(await fs.readdir(path.dirname(receiptPath(id))), []);
  });
}

test('a zero-byte receipt requires the correct execution ID, checksum, and a regular file', async (t) => {
  const { readExit, receiptPath, retiringExits, writeExit } =
    await journalFixture(t);
  const id = 'metadata-check',
    end = Date.now();
  writeExit(id, null, 'SIGTERM', end);
  const [marker] = (
    await Promise.all(
      (
        await retiringExits()
      ).map(async (c) =>
        (await fs.stat(c.file)).size === 0 ? c.file : undefined,
      ),
    )
  ).filter(Boolean);
  assert.equal((await readExit(id, marker)).signal, 'SIGTERM');
  for (const invalid of [
    marker.replace(id, 'other-execution'),
    marker.replace('SIGTERM', 'SIGKILL'),
  ]) {
    await fs.copyFile(marker, invalid);
    assert.equal(
      await readExit(
        invalid.includes('other-execution') ? 'other-execution' : id,
        invalid,
      ),
      null,
    );
  }
  await fs.writeFile(marker, '{"code":7');
  assert.equal(await readExit(id, marker), null);
  await fs.unlink(marker);
  await fs.symlink(receiptPath(id), marker);
  assert.equal(await readExit(id, marker), null);
});

for (const fault of ['rename', 'unlink']) {
  test(`receipt collection ${fault} fails with ENOSPC after commit; pruning and retries keep the old day absent`, async (t) => {
    const { db, history, stats, writeExit, retiringExits, receiptPath } =
      await journalFixture(t);
    const id = 'collector-full',
      today = require('dayjs')().startOf('day'),
      old = today.subtract(3, 'day').valueOf() + 123;
    await history.enqueue(id, 1, 'manual', null, old - 1000);
    await history.start(id, old - 1000, true);
    writeExit(id, 17, null, old);
    let attempts = 0;
    const original = fs[fault].bind(fs);
    const hook = t.mock.method(fs, fault, (file, ...args) => {
      if (
        file.startsWith(path.dirname(receiptPath(id)) + path.sep) ||
        (fault === 'unlink' &&
          path.basename(file).startsWith('.pending.' + id + '.'))
      ) {
        attempts++;
        throw Object.assign(Error('directory full'), { code: 'ENOSPC' });
      }
      return original(file, ...args);
    });
    await history.complete(id, 'unknown', null, null);
    assert.ok(attempts);
    assert.equal((await stats.CrontabStatModel.findOne()).run_count, 1);
    assert.ok((await retiringExits()).length);
    const policy = new (load('back/services/retention.ts', {
      '../data': { sequelize: db },
      '../data/cronStats': stats,
      '../data/runningInstance': {
        RunningInstanceModel: db.models.RunningInstance,
        InstanceStatus: { running: 0 },
      },
      '../data/system': {},
      '../config': {},
    }).default)();
    await policy.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 1,
    });
    hook.mock.restore();
    await Promise.all([
      publishFromPeer(id, 17, old),
      publishFromPeer(id, 17, old),
    ]);
    for (let i = 0; i < 2; i++) {
      await new TriggerHistory(db).interrupt('http');
      assert.equal(await stats.CrontabStatModel.count(), 0);
      assert.deepEqual(await history.visibleTriggers(1, [id]), []);
      assert.deepEqual(await fs.readdir(path.dirname(receiptPath(id))), []);
    }
  });
}

test('native SQLITE_FULL rolls back the counter claim and preserves the receipt until capacity returns', async (t) => {
  const { db, history, stats, writeExit, readExit } = await journalFixture(t);
  const id = 'sqlite-full',
    end = Date.now();
  await history.enqueue(id, 1, 'manual', null, end - 1000);
  await history.start(id, end - 1000, true);
  writeExit(id, 0, null, end);
  await db.query('CREATE TABLE force_page_growth (body BLOB)');
  await db.query(
    'CREATE TRIGGER exhaust_pages AFTER INSERT ON CrontabStats BEGIN INSERT INTO force_page_growth VALUES(zeroblob(2097152)); END',
  );
  const before = await db.query('PRAGMA page_count', {
    type: QueryTypes.SELECT,
  });
  const query = db.query.bind(db);
  const hook = t.mock.method(db, 'query', async (sql, options) => {
    if (String(sql).startsWith('INSERT INTO "CrontabStats"'))
      await query('PRAGMA max_page_count=' + before[0].page_count, {
        transaction: options.transaction,
      });
    return query(sql, options);
  });
  await assert.rejects(
    history.complete(id, 'unknown', null, null),
    (error) => error.original?.code === 'SQLITE_FULL',
  );
  hook.mock.restore();
  assert.equal((await readExit(id)).code, 0);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.deepEqual(
    await query('SELECT counted,state FROM CronTriggers WHERE id=$id', {
      type: QueryTypes.SELECT,
      bind: { id },
    }),
    [{ counted: 0, state: 'running' }],
  );
  await db.query('DROP TRIGGER exhaust_pages');
  await Promise.all([publishFromPeer(id, 0, end), publishFromPeer(id, 0, end)]);
  await Promise.all([
    new TriggerHistory(db).interrupt('http'),
    history.retryPendingExits(),
  ]);
  assert.equal((await stats.CrontabStatModel.findOne()).success_count, 1);
});

for (const producer of ['python', 'crond']) {
  test(`a live ${producer} producer with no free inode books the original timestamp through SQLite`, async (t) => {
    const { db, history, root, stats, receiptPath } = await journalFixture(t);
    const day = require('dayjs')().startOf('day');
    const end = day.valueOf() - 300,
      id = 'system-1-no-inode';
    await fs.mkdir(path.dirname(receiptPath(id)), { recursive: true });
    await fs.symlink(
      path.join(root, 'database.sqlite'),
      path.join(root, 'db', 'database.sqlite'),
    );
    await fs.writeFile(path.join(root, '.env'), '');
    await history.enqueue(
      id,
      1,
      producer === 'crond' ? 'system' : 'manual',
      null,
      end - 1000,
    );
    await history.start(id, end - 1000, true);
    await history.bindCommand(id, process.pid);
    const failWrites = path.join(root, 'full-inodes.cjs');
    await fs.writeFile(
      failWrites,
      `const fs=require('node:fs'), write=fs.writeFileSync;
      fs.writeFileSync=function(file,...args){
        if (typeof file==='string' && file.includes('/cron-exits/')) throw Object.assign(Error('no free inode'),{code:'ENOSPC'});
        return write.call(this,file,...args);
      };`,
    );
    const env = {
      ...process.env,
      QL_TRIGGER_ID: id,
      ID: '1',
      TS_NODE_PROJECT: path.resolve('back/tsconfig.json'),
    };
    const { spawnSync } = require('node:child_process');
    if (producer === 'crond') {
      const args = [
        '-r',
        failWrites,
        '-r',
        'ts-node/register/transpile-only',
        require.resolve('../../back/bootstrap/systemCron.ts'),
        'finish',
        '1',
        String(process.pid),
        id,
        '23',
        String(end),
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(process.execPath, args, {
          env,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
      }
    } else {
      // The Python parent is still alive. Force the independent reporter to
      // return its capacity-retry code once before it reaches the real DB.
      const wrapper = path.join(root, 'reporter.cjs'),
        attempts = path.join(root, 'attempts');
      await fs.writeFile(
        wrapper,
        `require('node:fs').appendFileSync(process.env.ATTEMPTS,process.argv[2]+'\\n');
        if(require('node:fs').readFileSync(process.env.ATTEMPTS,'utf8').trim().split('\\n').length===1)process.exit(75);
        const cmd=require('node:child_process').spawnSync(process.execPath,['-r',process.env.FULL_WRITES,process.env.REAL_REPORTER,process.argv[2]],{stdio:'inherit',env:process.env});
        process.exit(cmd.status);`,
      );
      const result = spawnSync(
        'python3',
        [
          '-I',
          '-S',
          '-c',
          `
import errno,os,runpy,sys,tempfile,time
def full(*args,**kwargs):raise OSError(errno.ENOSPC,'no free inode')
tempfile.NamedTemporaryFile=full
time.time_ns=lambda: int(os.environ['FINISH'])*1000000
sys.argv=sys.argv[1:]
sys.exit(runpy.run_path(sys.argv[0])['main']())
`,
          path.resolve('shell/cron-command.py'),
          'exit 23',
          String(process.pid),
          receiptPath(id),
          process.execPath,
          wrapper,
        ],
        {
          input: 'run\n',
          encoding: 'utf8',
          env: {
            ...env,
            ATTEMPTS: attempts,
            FULL_WRITES: failWrites,
            FINISH: String(end),
            REAL_REPORTER: require.resolve('../../back/shared/managedExit.cjs'),
          },
        },
      );
      assert.equal(result.status, 23, result.stderr);
      const messages = (await fs.readFile(attempts, 'utf8')).trim().split('\n');
      assert.equal(messages.length, 2);
      assert.equal(messages[0], messages[1]);
    }
    assert.deepEqual(await fs.readdir(path.dirname(receiptPath(id))), []);
    await history.complete(id, 'failed', null, 23); // The ordinary late supervisor-close callback.
    const [row] = await history.visibleTriggers(1, [id]);
    assert.deepEqual(
      [row.state, row.exit_code, row.finished_at],
      ['failed', 23, end],
    );
    assert.deepEqual(
      (await stats.CrontabStatModel.findAll()).map((r) => [
        r.date,
        r.run_count,
        r.fail_count,
      ]),
      [[day.subtract(1, 'day').format('YYYY-MM-DD'), 1, 1]],
    );
  });
}

test('a full-volume marker restored with a different valid body preserves both observed exits', async (t) => {
  const { db, history, stats, writeExit, retiringExits, receiptPath } =
    await journalFixture(t);
  const id = 'restored-metadata',
    end = Date.now() - 500;
  await history.enqueue(id, 1, 'manual', null, end - 500);
  await history.start(id, end - 500, true);
  const noBlocks = t.mock.method(require('node:fs'), 'statfsSync', () => ({
    bavail: 0,
  }));
  writeExit(id, 0, null, end);
  noBlocks.mock.restore();
  const [{ file }] = await retiringExits();
  writeSingleFileExit(id, 17, null, end + 1);
  await fs.rename(receiptPath(id), file);
  await Promise.all([
    history.retryPendingExits(),
    new TriggerHistory(db).interrupt('http'),
  ]);
  assert.deepEqual(
    (
      await db.query(
        'SELECT outcome,finished_at FROM CronBoundExitConflicts ORDER BY finished_at',
        { type: QueryTypes.SELECT },
      )
    ).map((r) => [r.outcome, r.finished_at]),
    [
      ['0', end],
      ['17', end + 1],
    ],
  );
  assert.equal(
    (await history.visibleTriggers(1, [id]))[0].reason,
    'exit_conflict',
  );
  assert.equal(await stats.CrontabStatModel.count(), 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).code, 17);
});

test('SQLite cannot open its rollback journal on an inode-exhausted database filesystem', async (t) => {
  const { storageFull, receiptPath } = await journalFixture(t);
  const sync = require('node:fs');
  const error = { original: { code: 'SQLITE_CANTOPEN' } };
  const dbDir = path.dirname(path.dirname(receiptPath('capacity')));
  let capacity = { files: 64, ffree: 0, bavail: 100 };
  t.mock.method(sync, 'statfsSync', (dir) => {
    assert.equal(dir, dbDir);
    return capacity;
  });
  assert.equal(storageFull(error), true);
  capacity = { files: 64, ffree: 13, bavail: 0 };
  assert.equal(storageFull(error), true);
  capacity = { files: 64, ffree: 13, bavail: 100 };
  assert.equal(storageFull(error), false);
  assert.equal(storageFull({ original: { code: 'SQLITE_CONSTRAINT' } }), false);
});

test('a full SQLite volume at crond start reports failure and keeps the overlap exit code for actual overlap', async (t) => {
  const { root } = await journalFixture(t);
  const hook = path.join(root, 'reject-registration.cjs');
  await fs.writeFile(path.join(root, '.env'), '');
  await fs.writeFile(
    hook,
    `require(${JSON.stringify(
      require.resolve('sequelize'),
    )}).Sequelize.prototype.query = async () => {
    throw Object.assign(Error('registration failed'),{original:{code:'SQLITE_FULL'}});
  };`,
  );
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [
      '-r',
      hook,
      '-r',
      'ts-node/register/transpile-only',
      require.resolve('../../back/bootstrap/systemCron.ts'),
      'start',
      '1',
      String(process.pid),
      'system-1-missing',
      String(process.pid),
    ],
    { env: process.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /registration failed/);
});

test('the first ext4 receipt and its containing directory must be durable before publication succeeds', async (t) => {
  const { writeExit, receiptPath } = await journalFixture(t);
  const native = require('node:fs');
  const directory = path.dirname(receiptPath('power-cut'));
  const synced = [];
  const realSync = native.fsyncSync;
  const hook = t.mock.method(native, 'fsyncSync', (fd) => {
    const stat = native.fstatSync(fd);
    if (stat.isDirectory()) synced.push(stat.ino);
    return realSync(fd);
  });
  writeExit('power-cut', 17, null, Date.now());
  for (const dir of [directory, path.dirname(directory)]) {
    assert.ok(
      synced.includes((await fs.stat(dir)).ino),
      'publication did not sync ' + dir,
    );
  }
  hook.mock.restore();
  t.mock.method(native, 'fsyncSync', () => {
    throw Object.assign(Error('writeback full'), { code: 'ENOSPC' });
  });
  assert.throws(() => writeExit('failed-barrier', 0, null, Date.now()), {
    code: 'ENOSPC',
  });
});

test('the Python supervisor reports the original exit when its directory sync fails', async (t) => {
  const { root, receiptPath } = await journalFixture(t);
  const id = 'failed-directory-flush',
    finish = Date.now(),
    output = path.join(root, 'reported.json');
  const reporter = path.join(root, 'report.cjs');
  await fs.writeFile(
    reporter,
    "require('fs').writeFileSync(process.env.REPORT, process.argv[2])",
  );
  const run = require('node:child_process').spawnSync(
    'python3',
    [
      '-I',
      '-S',
      '-c',
      `
import errno, os, runpy, stat, sys, time
original = os.fsync
def no_space(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode):
        raise OSError(errno.ENOSPC, 'directory cannot be flushed')
    return original(fd)
os.fsync = no_space
time.time_ns = lambda: int(os.environ['FINISH']) * 1000000
sys.argv = sys.argv[1:]
sys.exit(runpy.run_path(sys.argv[0])['main']())
`,
      path.resolve('shell/cron-command.py'),
      'exit 23',
      String(process.pid),
      receiptPath(id),
      process.execPath,
      reporter,
    ],
    {
      input: 'run\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        QL_TRIGGER_ID: id,
        FINISH: String(finish),
        REPORT: output,
      },
    },
  );
  assert.equal(run.status, 23, run.stderr);
  const receipt = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual([receipt.code, receipt.time], [23, finish]);
});

test('SQLite syncs rollback-journal removal on every panel connection before work starts', async (t) => {
  const { db } = await fixture(t, true);
  const level = async (tx) =>
    (
      await db.query('PRAGMA synchronous', {
        transaction: tx,
        type: QueryTypes.SELECT,
      })
    )[0].synchronous;
  assert.deepEqual(await Promise.all([level(), level()]), [3, 3]);
  for (let retry = 0; retry < 2; retry++)
    assert.equal(await db.transaction(level), 3);
});

test('the legacy JSON body is flushed before linking, and its published name is synced before return', async (t) => {
  const { writeExit } = await journalFixture(t);
  const native = require('node:fs'),
    order = [];
  const write = native.writeFileSync,
    link = native.linkSync,
    sync = native.fsyncSync;
  t.mock.method(native, 'writeFileSync', (file, body, options) => {
    if (body) {
      assert.equal(options.flush, true);
      order.push('JSON');
    }
    return write(file, body, options);
  });
  t.mock.method(native, 'linkSync', (...args) => {
    link(...args);
    order.push('link');
  });
  t.mock.method(native, 'fsyncSync', (fd) => {
    if (native.fstatSync(fd).isDirectory()) order.push('directory');
    return sync(fd);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    order.length = 0;
    writeExit('legacy-fence', 23, null, 1790000000123);
    assert.deepEqual(order, [
      'directory',
      'directory',
      'JSON',
      'link',
      'directory',
    ]);
  }
});

test('concurrent first queries wait for the SQLite durability setting and retry a failed initialization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-sqlite-barrier-'));
  const db = load('back/data/index.ts', {
    '../config/index': { dbPath: root },
  }).sequelize;
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  // Open the handle before either caller starts its first query.
  await db.connectionManager.getConnection({ type: 'read' });
  const native = require('sqlite3').Database.prototype,
    run = native.run;
  let attempts = 0,
    fail;
  t.mock.method(native, 'run', function (sql, ...args) {
    if (sql === 'PRAGMA synchronous=EXTRA' && ++attempts === 1) {
      fail = () =>
        args.at(-1)(Object.assign(Error('full'), { code: 'SQLITE_FULL' }));
      return this;
    }
    return run.call(this, sql, ...args);
  });
  const query = () =>
    db.query('PRAGMA synchronous', { type: QueryTypes.SELECT });
  const first = Promise.allSettled([query(), query()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof fail, 'function');
  fail();
  assert.deepEqual(
    (await first).map((r) => [r.status, r.reason?.code]),
    [
      ['rejected', 'SQLITE_FULL'],
      ['rejected', 'SQLITE_FULL'],
    ],
  );
  assert.deepEqual(await Promise.all([query(), query()]), [
    [{ synchronous: 3 }],
    [{ synchronous: 3 }],
  ]);
  assert.equal(attempts, 2);
});

test(
  'Linux full-volume retry unlinks only from the directory it inspected when a claim name is reused',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const { receiptPath, readExit, retireLegacyFile } = await journalFixture(t);
    const id = 'full-claim-reuse',
      end = Date.now();
    writeSingleFileExit(id, 23, null, end);
    const publicFile = receiptPath(id),
      root = path.dirname(publicFile);
    const claim = await fs.mkdtemp(path.join(root, '.claim.' + id + '.'));
    const slot = path.join(claim, 'receipt');
    await fs.rename(publicFile, slot);
    writeSingleFileExit(id, 17, null, end + 1);
    t.mock.method(fs, 'mkdtemp', async () => {
      throw Object.assign(Error('no inodes'), { code: 'ENOSPC' });
    });
    const unlink = fs.unlink.bind(fs);
    let switched = false;
    t.mock.method(fs, 'unlink', async (target) => {
      if (!switched) {
        switched = true;
        await fs.rename(claim, claim + '-original');
        await fs.mkdir(claim);
        await fs.copyFile(publicFile, slot);
      }
      return unlink(target);
    });
    await retireLegacyFile(id, slot, { outcome: '23', time: end });
    assert.equal(switched, true);
    assert.equal(
      await readExit(id, path.join(claim + '-original', 'receipt')),
      undefined,
    );
    assert.equal((await readExit(id, slot)).code, 17);
    assert.equal((await readExit(id, publicFile)).time, end + 1);
  },
);

test(
  'Linux full-volume recovery verifies the private marker name and preserves a contradictory body',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const {
      receiptPath,
      readExit,
      retireLegacyFile,
      retiringExits,
      writeExit,
    } = await journalFixture(t);
    const id = 'full-claim-metadata',
      end = Date.now();
    writeExit(id, 17, null, end);
    const publicFile = receiptPath(id);
    const files = await retiringExits();
    const marker = (
      await Promise.all(
        files.map(async (row) =>
          (await fs.stat(row.file)).size === 0 ? row.file : null,
        ),
      )
    ).find(Boolean);
    const claim = marker + 'ABC';
    const slot = path.join(claim, '.pending.claimed');
    await fs.mkdir(claim);
    await fs.rename(marker, slot);
    const full = () => {
      throw Object.assign(Error('quota'), { code: 'EDQUOT' });
    };
    t.mock.method(fs, 'mkdtemp', full);
    await retireLegacyFile(id, publicFile, { outcome: '17', time: end });
    assert.equal(await readExit(id, publicFile), undefined);
    await retireLegacyFile(id, slot, { outcome: '0', time: end });
    assert.equal((await readExit(id, slot)).code, 17);
    writeSingleFileExit(id, 23, null, end + 1);
    await fs.copyFile(publicFile, slot);
    await retireLegacyFile(id, slot, { outcome: '23', time: end + 1 });
    const both = await readExit(id, slot);
    assert.deepEqual([both.code, both.namedExit.code], [23, 17]);
    await fs.truncate(slot, 0);
    await retireLegacyFile(id, slot, { outcome: '17', time: end });
    assert.equal(await readExit(id, slot), undefined);
    assert.equal((await readExit(id, publicFile)).code, 23);
  },
);

for (const operation of ['rename', 'unlink']) {
  test(
    'a ' +
      operation +
      ' capacity error preserves replacement and replay evidence for a pruned day',
    async (t) => {
      const { history, db, receiptPath, writeExit, readExit, stats } =
        await journalFixture(t);
      const id = 'pruned-full-' + operation,
        end = require('dayjs')().subtract(4, 'day').valueOf();
      await history.enqueue(id, 1, 'manual', null, end - 1000);
      await history.start(id, end - 1000, true);
      writeSingleFileExit(id, 23, null, end);
      await history.complete(id, 'unknown', null, null);
      const policy = new (load('back/services/retention.ts', {
        '../data': { sequelize: db },
        '../data/cronStats': stats,
        '../data/runningInstance': {
          RunningInstanceModel: db.models.RunningInstance,
          InstanceStatus: { running: 0 },
        },
        '../data/system': {},
        '../config': {},
      }).default)();
      await policy.cleanup({
        runningInstanceRetentionDays: 1,
        cronStatRetentionDays: 1,
      });
      const file = receiptPath(id),
        now = Date.now();
      writeSingleFileExit(id, 23, null, end);
      const original = fs[operation].bind(fs);
      let failed = false;
      const hook = t.mock.method(fs, operation, async (src, ...args) => {
        if (
          (operation === 'rename'
            ? src === file
            : path.basename(src).startsWith('.pending.' + id + '.')) &&
          !failed
        ) {
          failed = true;
          writeExit(id, 42, null, now);
          throw Object.assign(Error('capacity exhausted'), { code: 'ENOSPC' });
        }
        return original(src, ...args);
      });
      await history.complete(id, 'unknown', null, null);
      assert.equal(failed, true);
      hook.mock.restore();
      await Promise.all([
        publishFromPeer(id, 23, end),
        publishFromPeer(id, 42, now),
        history.retryPendingExits(),
      ]);
      await new TriggerHistory(db).interrupt('http');
      const evidence = await db.query(
        'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
        { bind: { id }, type: QueryTypes.SELECT },
      );
      assert.deepEqual(
        evidence.map((v) => [v.outcome, v.finished_at]),
        [
          ['23', end],
          ['42', now],
        ],
      );
      assert.deepEqual(await history.visibleTriggers(1, [id]), []);
      assert.equal(await stats.CrontabStatModel.count(), 0);
    },
  );
}

for (const replace of ['directory', 'file', 'file-before-final-unlink'])
  test(
    'two Linux collectors retry after replacing the verified ' + replace,
    {
      skip: process.platform !== 'linux',
      timeout: 25000,
    },
    async (t) => {
      const { receiptPath, readExit, retiringExits } = await journalFixture(t);
      const id = 'reappeared',
        end = Date.now();
      writeSingleFileExit(id, 17, null, end);
      const file = receiptPath(id),
        root = path.dirname(file);
      const claim = await fs.mkdtemp(path.join(root, '.claim.' + id + '.'));
      const slot = path.join(claim, 'receipt');
      await fs.rename(file, slot);
      const original = await fs.stat(claim);
      const workers = ['first', 'second'].map((label) => {
        const barrier = path.join(root, label);
        const child = require('node:child_process').spawn(
          process.execPath,
          [
            path.resolve('test/helpers/receipt-claim-reuse-worker.cjs'),
            path.resolve('back/cron/settlement/exitReceipt.cjs'),
            slot,
            id,
            '17',
            String(end),
            barrier,
            '',
            replace === 'file-before-final-unlink' ? 'holdUnlink' : '',
          ],
          { stdio: 'inherit' },
        );
        t.after(() => {
          if (child.exitCode === null) child.kill();
        });
        return {
          barrier,
          done: new Promise((resolve) => child.once('exit', resolve)),
        };
      });
      for (const { barrier } of workers) {
        const limit = Date.now() + 10000;
        while (!require('node:fs').existsSync(barrier + '.ready')) {
          assert.ok(
            Date.now() < limit,
            'collector did not reach the verified inode',
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          JSON.parse(await fs.readFile(barrier + '.ready', 'utf8'))
            .directoryInode,
          original.ino,
        );
      }
      if (replace === 'file-before-final-unlink') {
        const { barrier } = workers[0];
        await fs.writeFile(barrier + '.go', '');
        const limit = Date.now() + 5000;
        while (!require('node:fs').existsSync(barrier + '.checked')) {
          assert.ok(Date.now() < limit, 'collector never reached final unlink');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (replace === 'directory') {
        await fs.rename(claim, claim + '-old');
        await fs.mkdir(claim);
      }
      writeSingleFileExit(id, 42, null, end + 1);
      await fs.rename(file, slot);
      if (replace === 'file-before-final-unlink')
        await fs.writeFile(workers[0].barrier + '.release', '');
      for (const { barrier } of workers)
        await fs.writeFile(barrier + '.go', '');
      assert.deepEqual(await Promise.all(workers.map((w) => w.done)), [0, 0]);
      assert.equal(
        await readExit(id, path.join(claim + '-old', 'receipt')),
        undefined,
      );
      const recovered = await Promise.all(
        (await retiringExits()).map((f) => readExit(f.id, f.file)),
      );
      assert.deepEqual(
        recovered.map((r) => r?.code),
        [42],
      );
    },
  );

for (const first of [17, 42]) {
  test(`pruned exit stores a lone bound tuple across restart before the other arrives: ${first}`, async (t) => {
    const { db, history, receiptPath, readExit, stats } = await journalFixture(
      t,
    );
    const id = 'pruned-sequential',
      end = Date.now(),
      other = first === 17 ? 42 : 17;
    const time = (code) => (code === 17 ? end - 86400000 : end);
    // No booking or trigger survives pruning. The only new bytes reside in
    // the private directory restored by ext4.
    writeSingleFileExit(id, first, null, time(first));
    const file = receiptPath(id),
      claim = await fs.mkdtemp(
        path.join(path.dirname(file), '.claim.' + id + '.'),
      );
    const slot = path.join(claim, 'receipt');
    await fs.rename(file, slot);
    await db.query('CREATE TABLE missing_parent (id INTEGER PRIMARY KEY)');
    await db.query(
      'CREATE TABLE deferred_exit (id INTEGER REFERENCES missing_parent(id) DEFERRABLE INITIALLY DEFERRED)',
    );
    await db.query(
      'CREATE TRIGGER fail_unmatched AFTER INSERT ON CronUnmatchedBoundExits BEGIN INSERT INTO deferred_exit VALUES(1); END',
    );
    await assert.rejects(
      history.complete(id, 'unknown', null, null),
      /constraint|foreign key/i,
    );
    assert.equal((await readExit(id, slot)).code, first);
    await db.query('DROP TRIGGER fail_unmatched');
    await history.interrupt('http');
    assert.equal(await readExit(id, slot), undefined);
    const evidence = (table) =>
      db.query(
        'SELECT outcome,finished_at FROM ' +
          table +
          ' WHERE trigger_id=$id ORDER BY finished_at',
        { bind: { id }, type: QueryTypes.SELECT },
      );
    assert.deepEqual(await evidence('CronUnmatchedBoundExits'), [
      { outcome: String(first), finished_at: time(first) },
    ]);
    writeSingleFileExit(id, other, null, time(other));
    await new TriggerHistory(db).retryPendingExits();
    await Promise.all([
      publishFromPeer(id, first, time(first)),
      publishFromPeer(id, other, time(other)),
    ]);
    assert.deepEqual(
      await evidence('CronBoundExitConflicts'),
      [17, 42].map((code) => ({
        outcome: String(code),
        finished_at: time(code),
      })),
    );
    assert.deepEqual(await evidence('CronUnmatchedBoundExits'), []);
    assert.deepEqual(await history.visibleTriggers(1, [id]), []);
    assert.equal(await stats.CrontabStatModel.count(), 0);
  });
}

test(
  'concurrent collectors use distinct disposal names outside the occupied private directory',
  {
    skip: process.platform !== 'linux',
    timeout: 15000,
  },
  async (t) => {
    const { receiptPath, readExit, retireLegacyFile } = await journalFixture(t);
    const id = 'allocator-reuse',
      time = Date.now();
    writeSingleFileExit(id, 17, null, time);
    const older = receiptPath(id),
      root = path.dirname(older);
    const newer = path.join(
      root,
      '.collecting.' + id + '.' + require('node:crypto').randomUUID(),
    );
    await fs.rename(older, newer);
    writeSingleFileExit(id, 42, null, time + 1);
    const claim = await fs.mkdtemp(path.join(root, '.claim.' + id + '.'));
    const slot = path.join(claim, 'receipt');
    await fs.copyFile(older, slot);
    const targets = [];
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, 'rename', async (from, to) => {
      targets.push(to);
      return rename(from, to);
    });
    await Promise.all([
      retireLegacyFile(id, older, { outcome: '0', time }),
      retireLegacyFile(id, newer, { outcome: '17', time }),
    ]);
    assert.equal(new Set(targets).size, 2);
    assert.ok(targets.every((f) => path.dirname(f) === path.dirname(root)));
    assert.equal((await readExit(id, slot)).code, 42);
    const retained = await Promise.all(targets.map((f) => readExit(id, f)));
    assert.deepEqual(
      retained.filter(Boolean).map((r) => r.code),
      [42],
    );
  },
);

test(
  'Linux uses the supervisor Python runtime for the inode lock when flock is absent',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const { receiptPath, retireLegacyFile } = await journalFixture(t);
    const id = 'python-lock',
      when = Date.now();
    writeSingleFileExit(id, 0, null, when);
    const proc = require('node:child_process'),
      spawn = proc.spawn;
    const programs = [];
    t.mock.method(proc, 'spawn', (name, args, options) => {
      programs.push(name);
      return spawn(
        name === 'flock' ? '/missing-flock-on-test-panel' : name,
        args,
        options,
      );
    });
    const file = receiptPath(id),
      claim = await fs.mkdtemp(
        path.join(path.dirname(file), '.claim.' + id + '.'),
      );
    const slot = path.join(claim, 'receipt');
    await fs.rename(file, slot);
    await retireLegacyFile(id, slot, { outcome: '0', time: when });
    assert.deepEqual(programs, ['flock', 'python3']);
    assert.deepEqual(await fs.readdir(path.dirname(receiptPath(id))), []);
  },
);

for (const replacement of ['changed-code', 'changed-millis', 'torn', 'bound']) {
  test(
    'recovery preserves a replacement in an unbound slot across retries: ' +
      replacement,
    async (t) => {
      const { receiptPath, readExit, retiringExits, retireLegacyFile } =
        await journalFixture(t);
      const id = 'weak-slot',
        file = receiptPath(id),
        time = Date.now();
      const claim = path.join(path.dirname(file), '.claim.' + id + '.ab1234');
      const slot = path.join(claim, 'receipt');
      await fs.mkdir(claim, { recursive: true });
      await fs.writeFile(slot, JSON.stringify({ code: 0, signal: null, time }));
      writeSingleFileExit(id, 17, null, time);
      let body = await fs.readFile(file, 'utf8');
      if (replacement !== 'bound')
        body =
          replacement === 'torn'
            ? '{"code":'
            : JSON.stringify({
                code: replacement === 'changed-code' ? 17 : 0,
                signal: null,
                time: time + Number(replacement === 'changed-millis'),
              });
      await fs.writeFile(file, body);
      const rename = fs.rename.bind(fs);
      const hook = t.mock.method(fs, 'rename', async (src, dest) => {
        await rename(file, slot);
        await rename(src, dest);
        throw Object.assign(Error('interrupted after capture'), {
          code: 'EIO',
        });
      });
      await assert.rejects(retireLegacyFile(id, slot), { code: 'EIO' });
      hook.mock.restore();
      const [capture] = await retiringExits();
      assert.equal(capture.id, id);
      for (let i = 0; i < 2; i++) {
        const value = await readExit(id, capture.file);
        if (replacement === 'bound') assert.equal(value.code, 17);
        else assert.equal(value, null);
        await retireLegacyFile(id, capture.file);
        assert.equal(await fs.readFile(capture.file, 'utf8'), body);
      }
    },
  );
}

test('a separately mounted journal retains the replacement in a recoverable same-device directory', async (t) => {
  const { receiptPath, retiringExits, readExit, retireLegacyFile } =
    await journalFixture(t);
  const id = 'external-spool',
    time = Date.now(),
    file = receiptPath(id);
  writeSingleFileExit(id, 17, null, time);
  const spool = path.dirname(file),
    db = path.dirname(spool),
    claim = await fs.mkdtemp(path.join(spool, '.claim.' + id + '.'));
  const slot = path.join(claim, 'receipt');
  await fs.rename(file, slot);
  writeSingleFileExit(id, 42, null, time + 1);
  const rename = fs.rename.bind(fs);
  const hook = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.dirname(to) === db) {
      await rename(file, slot);
      throw Object.assign(Error('cross-device rename'), { code: 'EXDEV' });
    }
    return rename(from, to);
  });
  await retireLegacyFile(id, slot, { outcome: '17', time });
  hook.mock.restore();
  const [capture] = await retiringExits();
  assert.equal(path.dirname(capture.file), path.join(spool, '.reclaim'));
  assert.equal((await readExit(id, capture.file)).code, 42);
  await retireLegacyFile(id, capture.file, { outcome: '42', time: time + 1 });
  assert.deepEqual(await retiringExits(), []);
});

test('an unbound receipt cannot become disposable after an unreadable source changes during capture', async (t) => {
  const { receiptPath, retireLegacyFile, retiringExits, history } =
    await journalFixture(t);
  const id = 'blind-capture',
    file = receiptPath(id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'damaged');
  const bytes = JSON.stringify({ code: 17, signal: null, time: Date.now() });
  const rename = fs.rename.bind(fs);
  const hook = t.mock.method(fs, 'rename', async (from, to) => {
    await fs.writeFile(file + '.restored', bytes);
    await rename(file + '.restored', file);
    await rename(from, to);
  });
  await retireLegacyFile(id, file);
  hook.mock.restore();
  await history.interrupt('http');
  await history.retryPendingExits();
  const [copy] = await retiringExits();
  assert.equal(await fs.readFile(copy.file, 'utf8'), bytes);
});

for (const fault of ['rename', 'directory-sync', 'unlink']) {
  test(
    'two collectors with a replaced private receipt recover after ENOSPC at ' +
      fault,
    { timeout: 20000 },
    async (t) => {
      const {
        db,
        history,
        receiptPath,
        retireLegacyFile,
        retiringExits,
        readExit,
        stats,
      } = await journalFixture(t);
      const retained = fault === 'unlink';
      const id = 'capacity-slot',
        today = require('dayjs')().startOf('day');
      const old = retained
          ? today.valueOf() + 2000
          : today.subtract(4, 'day').valueOf(),
        late = today.valueOf() + 2200;
      const policy = new (load('back/services/retention.ts', {
        '../data': { sequelize: db },
        '../data/cronStats': stats,
        '../data/runningInstance': {
          RunningInstanceModel: db.models.RunningInstance,
          InstanceStatus: { running: 0 },
        },
        '../data/system': {},
        '../config': {},
      }).default)();
      const clean = () =>
        policy.cleanup({
          runningInstanceRetentionDays: 1,
          cronStatRetentionDays: 1,
        });
      for (const [key, code, end] of [
        [id, 17, old],
        ['sibling', 0, late],
      ]) {
        await history.enqueue(key, 1, 'manual', null, end - 1000);
        await history.start(key, end - 1000, true);
        if (key === 'sibling' && fault === 'directory-sync') continue;
        writeSingleFileExit(key, code, null, end);
        await history.complete(key, 'unknown', null, null);
      }
      await clean();
      assert.equal(
        (await history.visibleTriggers(1, [id])).length,
        Number(retained),
      );
      if (!retained) {
        // A late confirmation preserves the tuple after pruning.
        writeSingleFileExit(id, 17, null, old);
        await history.complete(id, 'unknown', null, null);
      }
      const file = receiptPath(id),
        claim = await fs.mkdtemp(
          path.join(path.dirname(file), '.claim.' + id + '.'),
        );
      const slot = path.join(claim, 'receipt');
      writeSingleFileExit(id, 17, null, old);
      const rename = fs.rename.bind(fs);
      await rename(file, slot);
      writeSingleFileExit(id, 42, null, late);
      const staged = path.join(claim, 'third-party');
      await rename(file, staged);
      const full = () =>
        Object.assign(Error('capacity exhausted'), { code: 'ENOSPC' });
      const collectors = [barrier(), barrier()];
      const finalUnlink = barrier();
      let entered = 0,
        failures = 0;
      const move = t.mock.method(fs, 'rename', async (from, to) => {
        const index = entered++;
        await collectors[index].wait();
        if (fault === 'rename') {
          failures++;
          throw full();
        }
        return rename(from, to);
      });
      const remove = fs.unlink.bind(fs);
      const deleting = t.mock.method(fs, 'unlink', async (target) => {
        if (fault !== 'unlink') return remove(target);
        await finalUnlink.wait();
        failures++;
        throw full();
      });
      const native = require('node:fs'),
        sync = native.fsyncSync;
      const syncing = t.mock.method(native, 'fsyncSync', (fd) => {
        if (fault === 'directory-sync') {
          failures++;
          throw full();
        }
        return sync(fd);
      });
      const workers = Promise.allSettled(
        [0, 1].map(() =>
          retireLegacyFile(id, slot, { outcome: '17', time: old }),
        ),
      );
      await Promise.all(collectors.map((gate) => gate.entered));
      if (fault === 'unlink') {
        collectors[0].release();
        await finalUnlink.entered;
      }
      await rename(staged, slot);
      collectors.forEach((gate) => gate.release());
      finalUnlink.release();
      const results = await workers;
      move.mock.restore();
      deleting.mock.restore();
      syncing.mock.restore();
      assert.equal(failures, fault === 'rename' ? 2 : 1);
      assert.deepEqual(
        results
          .filter((r) => r.status === 'rejected')
          .map((r) => r.reason.code),
        Array(failures).fill('ENOSPC'),
      );
      const survivors = await Promise.all(
        (await retiringExits()).map((row) => readExit(row.id, row.file)),
      );
      assert.equal(
        survivors.filter((r) => r?.code === 42 && r.time === late).length,
        1,
      );
      // Only the old tuple is redelivered. The replacement must be found on disk.
      if (fault === 'directory-sync')
        writeSingleFileExit('sibling', 0, null, late);
      await Promise.all([
        publishFromPeer(id, 17, old),
        publishFromPeer(id, 17, old),
      ]);
      await Promise.all([
        new TriggerHistory(db).interrupt('http'),
        history.retryPendingExits(),
        clean(),
      ]);
      await new TriggerHistory(db).retryPendingExits();
      const conflicts = await db.query(
        'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
        { bind: { id }, type: QueryTypes.SELECT },
      );
      assert.deepEqual(conflicts, [
        { outcome: '17', finished_at: old },
        { outcome: '42', finished_at: late },
      ]);
      const visible = await history.visibleTriggers(1, [id]);
      assert.deepEqual(
        visible.map((row) => [row.state, row.reason, row.exit_code]),
        retained ? [['unknown', 'exit_conflict', null]] : [],
      );
      const [sibling] = await history.visibleTriggers(1, ['sibling']);
      assert.deepEqual(
        [sibling.state, sibling.exit_code, sibling.finished_at],
        ['finished', 0, late],
      );
      const ledger = await stats.CrontabStatModel.findAll();
      assert.deepEqual(
        ledger.map((r) => [r.date, r.run_count, r.success_count, r.fail_count]),
        [[today.format('YYYY-MM-DD'), 1, 1, 0]],
      );
    },
  );
}

test('polling a restored canonical exit after an evidence-free restart isolates other unknown instances', async (t) => {
  const { db, history, stats } = await journalFixture(t);
  const end = Date.now() - 20;
  const ids = ['restored-after-startup', 'no-durable-exit'];
  for (const id of ids) {
    await history.enqueue(id, 1, 'manual', null, end - 1000);
    await history.start(id, end - 1000, true);
  }
  await history.interrupt('http');
  const results = async () =>
    (await history.visibleTriggers(1, ids))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((row) => [row.state, row.exit_code, row.finished_at]);
  assert.deepEqual(await results(), [
    ['unknown', null, null],
    ['unknown', null, null],
  ]);
  writeSingleFileExit(ids[0], 29, null, end);
  await Promise.all([
    history.retryPendingExits(),
    new TriggerHistory(db).retryPendingExits(),
  ]);
  assert.deepEqual(await results(), [
    ['failed', 29, end],
    ['unknown', null, null],
  ]);
  await new TriggerHistory(db).interrupt('http');
  await history.retryPendingExits();
  const [day] = await stats.CrontabStatModel.findAll();
  assert.deepEqual(
    [day.run_count, day.success_count, day.fail_count],
    [1, 0, 1],
  );
});

test('first receipt creation fails before power loss and replay of a pruned sibling cannot book that run', async (t) => {
  const { db, history, receiptPath, readExit, writeExit, stats } =
    await journalFixture(t);
  const day = require('dayjs')().startOf('day');
  const end = day.valueOf() + 1500;
  const expired = day.subtract(4, 'day').valueOf();
  const old = 'expired-execution',
    saved = 'last-free-inode',
    missing = 'no-free-inode';
  for (const [id, time] of [
    [old, expired],
    [saved, end],
    [missing, end],
  ]) {
    await history.enqueue(id, 1, 'manual', null, time - 2000);
    await history.start(id, time - 2000, true);
  }
  writeSingleFileExit(old, 0, null, expired);
  await history.complete(old, 'unknown', null, null);
  const policy = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  const clean = () =>
    policy.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 1,
    });
  await clean();
  const sync = require('node:fs');
  const full = t.mock.method(sync, 'statfsSync', () => ({ bavail: 0 }));
  writeExit(saved, 29, null, end);
  full.mock.restore();
  const noInode = t.mock.method(sync, 'writeFileSync', (file) => {
    assert.ok(path.basename(file).startsWith('.pending.' + missing + '.full-'));
    throw Object.assign(Error('no free inode'), { code: 'ENOSPC' });
  });
  assert.throws(() => writeExit(missing, 0, null, end), { code: 'ENOSPC' });
  noInode.mock.restore();
  assert.equal(await readExit(missing), undefined);
  assert.deepEqual(
    (await fs.readdir(path.dirname(receiptPath(missing)))).filter((file) =>
      file.includes(missing),
    ),
    [],
  );
  await new TriggerHistory(db).interrupt('http');
  await Promise.all([
    publishFromPeer(old, 0, expired),
    publishFromPeer(old, 0, expired),
    clean(),
  ]);
  await new TriggerHistory(db).interrupt('http');
  const [unknown] = await history.visibleTriggers(1, [missing]);
  assert.deepEqual(
    [unknown.state, unknown.exit_code, unknown.finished_at],
    ['unknown', null, null],
  );
  const [recovered] = await history.visibleTriggers(1, [saved]);
  assert.deepEqual(
    [recovered.state, recovered.exit_code, recovered.finished_at],
    ['failed', 29, end],
  );
  assert.deepEqual(await history.visibleTriggers(1, [old]), []);
  const ledger = await stats.CrontabStatModel.findAll();
  assert.deepEqual(
    ledger.map((r) => [r.date, r.run_count, r.fail_count]),
    [[day.format('YYYY-MM-DD'), 1, 1]],
  );
});

test('cleanup racing the return of a canonical receipt books its retained day even after both histories expire', async (t) => {
  const { db, history, stats } = await journalFixture(t);
  const today = require('dayjs')().startOf('day');
  const end = today.subtract(2, 'day').valueOf() + 10000;
  const older = today.subtract(9, 'day').valueOf();
  const policy = new (load('back/services/retention.ts', {
    '../data': { sequelize: db },
    '../data/cronStats': stats,
    '../data/runningInstance': {
      RunningInstanceModel: db.models.RunningInstance,
      InstanceStatus: { running: 0 },
    },
    '../data/system': {},
    '../config': {},
  }).default)();
  const clean = () =>
    policy.cleanup({
      runningInstanceRetentionDays: 1,
      cronStatRetentionDays: 4,
    });
  const ids = ['late-canonical', 'lost-at-syscall', 'expired-replay'];
  for (const id of ids) {
    const start = id === ids[2] ? older : end - 2000;
    await history.enqueue(id, 1, 'manual', null, start);
    await history.start(id, start, true);
  }
  writeSingleFileExit(ids[2], 0, null, older + 500);
  await history.complete(ids[2], 'unknown', null, null);
  await history.interrupt('http');
  // A later cleanup runs after the two restart observations have aged out.
  await db.query(
    "UPDATE CronTriggers SET finished_at=$observed WHERE state='unknown' AND reason='restart'",
    { bind: { observed: end + 100 } },
  );
  await clean();
  assert.deepEqual(await history.visibleTriggers(1, ids), []);
  assert.equal(await stats.CrontabStatModel.count(), 0);
  writeSingleFileExit(ids[0], 29, null, end);
  await Promise.all([
    history.retryPendingExits(),
    clean(),
    publishFromPeer(ids[2], 0, older + 500),
  ]);
  await new TriggerHistory(db).interrupt('http');
  await publishFromPeer(ids[0], 29, end);
  const ledger = await stats.CrontabStatModel.findAll();
  assert.deepEqual(
    ledger.map((r) => [r.date, r.run_count, r.fail_count, r.total_time]),
    [[today.subtract(2, 'day').format('YYYY-MM-DD'), 1, 1, 2000]],
  );
  assert.deepEqual(await history.visibleTriggers(1, ids), []);
  const bindings = () =>
    db.query('SELECT trigger_id FROM CronPrunedUnknownRuns', {
      type: QueryTypes.SELECT,
    });
  assert.deepEqual(await bindings(), [{ trigger_id: ids[1] }]);
  await policy.cleanup({
    runningInstanceRetentionDays: 0,
    cronStatRetentionDays: 1,
  });
  assert.deepEqual(await bindings(), []);
  await publishFromPeer(ids[0], 29, end);
  assert.equal(await stats.CrontabStatModel.count(), 0);
});

test('pruned unknown settlement rolls back with its booking and a later conflict withdraws only that contribution', async (t) => {
  const { db, history, stats, readExit } = await journalFixture(t);
  const start = Date.now() - 4000,
    end = start + 1000;
  const id = 'pruned-and-restored',
    sibling = 'already-booked-sibling';
  for (const key of [id, sibling]) {
    await history.enqueue(key, 1, 'manual', null, start);
    await history.start(key, start, true);
  }
  writeSingleFileExit(sibling, 0, null, end);
  await history.complete(sibling, 'unknown', null, null);
  await history.interrupt('http');
  await db.transaction((tx) => history.deleteExpired(Date.now() + 10, tx));
  writeSingleFileExit(id, 31, null, end);
  await db.query(`CREATE TRIGGER block_new_booking BEFORE INSERT ON CronLegacyExitBookings
    WHEN NEW.trigger_id='pruned-and-restored' BEGIN SELECT RAISE(ABORT, 'booking unavailable'); END`);
  await assert.rejects(history.retryPendingExits(), (error) =>
    /booking unavailable/.test(error.original?.message),
  );
  assert.equal((await readExit(id)).code, 31);
  const daily = async () =>
    (await stats.CrontabStatModel.findAll()).map((row) => [
      row.run_count,
      row.success_count,
      row.fail_count,
      row.total_time,
    ]);
  assert.deepEqual(await daily(), [[1, 1, 0, 1000]]);
  await db.query('DROP TRIGGER block_new_booking');
  await new TriggerHistory(db).interrupt('http');
  assert.deepEqual(await daily(), [[2, 1, 1, 2000]]);
  await Promise.all([
    publishFromPeer(id, 0, end + 1),
    publishFromPeer(id, 31, end),
  ]);
  await new TriggerHistory(db).interrupt('http');
  await history.retryPendingExits();
  assert.deepEqual(await daily(), [[1, 1, 0, 1000]]);
  assert.deepEqual(await history.visibleTriggers(1, [id, sibling]), []);
  assert.deepEqual(
    await db.query(
      'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at',
      { bind: { id }, type: QueryTypes.SELECT },
    ),
    [
      { outcome: '31', finished_at: end },
      { outcome: '0', finished_at: end + 1 },
    ],
  );
});

for (const cleanupFirst of [true, false]) {
  test(
    'committed pruned booking survives power loss and a conflicting replay with daily cleanup ' +
      (cleanupFirst ? 'first' : 'last'),
    async (t) => {
      const { db, history, stats, receiptPath, readExit } =
        await journalFixture(t);
      const today = require('dayjs')().startOf('day');
      const end = today.subtract(2, 'day').valueOf() + 5000;
      const other = today.valueOf() + 1000;
      const id = 'late-at-commit',
        sameDay = 'same-day-peer',
        keep = 'later-peer';
      const policy = new (load('back/services/retention.ts', {
        '../data': { sequelize: db },
        '../data/cronStats': stats,
        '../data/runningInstance': {
          RunningInstanceModel: db.models.RunningInstance,
          InstanceStatus: { running: 0 },
        },
        '../data/system': {},
        '../config': {},
      }).default)();
      const clean = () =>
        policy.cleanup({
          runningInstanceRetentionDays: 0,
          cronStatRetentionDays: 1,
        });
      const start = end - 2000;
      for (const key of [id, sameDay, keep]) {
        await history.enqueue(key, 1, 'manual', null, start);
        await history.start(key, start, true);
        if (key !== id) {
          writeSingleFileExit(key, 0, null, key === keep ? other : end - 500);
          await history.complete(key, 'unknown', null, null);
        }
      }
      await history.interrupt('http');
      await db.transaction((tx) =>
        history.deleteExpired(Math.max(Date.now(), other) + 10000, tx),
      );
      writeSingleFileExit(id, 31, null, end);
      // A separate connection sees the commit, but the original file has not
      // been reclaimed when power is lost. The real VM also exercises this cut.
      await db.transaction(async (tx) => {
        t.mock.method(tx, 'afterCommit', () => {});
        await history.replayPublishedExits(tx);
      });
      assert.equal((await readExit(id)).code, 31);
      const totals = async () =>
        (
          await stats.CrontabStatModel.findAll({ order: [['date', 'ASC']] })
        ).map((row) => [
          row.date,
          row.run_count,
          row.success_count,
          row.fail_count,
          row.total_time,
          row.max_time,
        ]);
      const oldDay = today.subtract(2, 'day').format('YYYY-MM-DD');
      const retained = [
        today.format('YYYY-MM-DD'),
        1,
        1,
        0,
        other - start,
        other - start,
      ];
      assert.deepEqual(await totals(), [
        [oldDay, 2, 1, 1, 3500, 2000],
        retained,
      ]);
      assert.deepEqual(
        await db.query(
          'SELECT outcome,finished_at FROM CronUnmatchedBoundExits WHERE trigger_id=$id',
          { bind: { id }, type: QueryTypes.SELECT },
        ),
        [{ outcome: '31', finished_at: end }],
      );
      // A previous panel can leave a committed booking and the canonical file
      // as the only witnesses. Resume on that database and drain the duplicate.
      if (cleanupFirst)
        await db.query(
          'DELETE FROM CronUnmatchedBoundExits WHERE trigger_id=$id',
          { bind: { id } },
        );
      const boot = new TriggerHistory(db);
      await boot.interrupt('http');
      await assert.rejects(fs.access(receiptPath(id)), { code: 'ENOENT' });
      if (cleanupFirst) await clean();
      const conflictCode = cleanupFirst ? 31 : 0;
      const conflictEnd = cleanupFirst ? other : end;
      writeSingleFileExit(id, conflictCode, null, conflictEnd);
      await boot.retryPendingExits();
      const conflicts = () =>
        db.query(
          'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id ORDER BY finished_at,outcome',
          { bind: { id }, type: QueryTypes.SELECT },
        );
      const original = { outcome: '31', finished_at: end };
      const changed = {
        outcome: String(conflictCode),
        finished_at: conflictEnd,
      };
      const expected = cleanupFirst ? [original, changed] : [changed, original];
      assert.deepEqual(await conflicts(), expected);
      if (!cleanupFirst) {
        assert.deepEqual(await totals(), [
          [oldDay, 1, 1, 0, 1500, 1500],
          retained,
        ]);
        await clean();
      }
      await Promise.all([
        clean(),
        publishFromPeer(id, 31, end),
        publishFromPeer(id, conflictCode, conflictEnd),
      ]);
      await new TriggerHistory(db).interrupt('http');
      assert.deepEqual(await conflicts(), expected);
      assert.deepEqual(await totals(), [retained]);
      assert.deepEqual(await boot.visibleTriggers(1, [id, sameDay, keep]), []);
    },
  );
}

test('registered plans distinguish absent, skipped, queued, confirmed command starts and late recovery', async (t) => {
  const { db, history } = await fixture(t);
  const {
    saveSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const start = new Date(2026, 0, 12, 8).getTime();
  const rule = '* * * * * *';
  const task = { id: '1', schedule: rule };
  const audit = () => auditSchedule(db, start, start + 10000); // five fully elapsed slots
  assert.equal(await audit(), null);
  await saveSchedulePlan(db, { crons: [task], replace: true }, start);
  let a = await audit();
  assert.deepEqual(
    [a.expected, a.missing, a.onTime, a.dispatched],
    [5, 5, 0, 0],
  );
  const id = (n) => slotId('1', 0, rule, start + n * 1000);
  const enqueue = (n) =>
    history.enqueue(id(n), 1, 'node', start + n * 1000, start + n * 1000 + 10);
  for (const n of [2, 3, 4, 5]) await enqueue(n);
  await history.finish(id(2), 'skipped', 'pending', null);
  await history.start(id(4), start + 4010, true);
  await history.recordCommandStart(id(4), start + 4200);
  await history.recordCommandStart(id(4), start + 4800);
  await history.start(id(5), start + 5010, true);
  await history.finish(id(5), 'failed', 'spawn', 127);
  await history.enqueue('manual', 1, 'manual', null, start + 100);
  await history.enqueue('wrong-rule', 1, 'node', start + 1000, start + 1000);
  a = await audit();
  assert.deepEqual(
    [
      a.expected,
      a.observed,
      a.missing,
      a.skipped,
      a.queued,
      a.dispatched,
      a.unconfirmed,
      a.onTime,
    ],
    [5, 4, 1, 1, 1, 1, 1, 4],
  );
  assert.deepEqual(
    [a.commandStartP95, a.scriptStartP95, a.scriptSamples],
    [200, null, 0],
  );
  await history.enqueue(id(1), 1, 'recovery', start + 1000, start + 9200);
  a = await audit();
  assert.deepEqual(
    [a.expected, a.observed, a.missing, a.onTime, a.triggerDeviationP95],
    [5, 5, 0, 4, 8200],
  );
  // A verified exit proves launch after losing the timing pipe, without adding a duration sample.
  await db.query(
    `INSERT INTO CronLegacyExitBookings(trigger_id,cron_id,source,started_at,finished_at,outcome,day,bound)
    VALUES($id,1,'node',$start,$end,'127','2026-01-12',1)`,
    { bind: { id: id(5), start: start + 5010, end: start + 9000 } },
  );
  a = await audit();
  assert.deepEqual(
    [a.dispatched, a.commandSamples, a.unconfirmed, a.commandStartP95],
    [2, 1, 0, 200],
  );
  // A new connection after restart must see the original plan, even if no timer ran.
  const reopened = new Sequelize({
    dialect: 'sqlite',
    storage: db.options.storage,
    logging: false,
  });
  try {
    assert.deepEqual(await auditSchedule(reopened, start, start + 10000), a);
  } finally {
    await reopened.close();
  }
});

test('plan revisions preserve prior slots, duplicate rules and a cross-midnight late receipt', async (t) => {
  const { db, history } = await fixture(t);
  const {
    saveSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const day = new Date(2026, 0, 13).getTime();
  const rule = '* * * * * *',
    task = { id: '2', schedule: rule, extra_schedules: [{ schedule: rule }] };
  const save = (change, at) => saveSchedulePlan(db, change, day + at);
  await save({ crons: [task], replace: true }, -1800);
  await save({ crons: [task], replace: true }, 300);
  await history.enqueue(slotId('2', 1, rule, day), 2, 'node', day, day + 100);
  await history.enqueue(
    slotId('2', 0, rule, day - 1000),
    2,
    'recovery',
    day - 1000,
    day + 500,
  );
  await save(
    { crons: [{ id: '2', schedule: '*/2 * * * * *' }], replace: false },
    1500,
  );
  await save({ ids: ['2'] }, 2600);
  await save({ crons: [], replace: true }, 7500);
  const a = await auditSchedule(db, day, day + 16000);
  // Two rules at midnight and at second 1, one edited rule at second 2.
  assert.deepEqual([a.expected, a.observed, a.missing, a.onTime], [5, 1, 4, 1]);
  assert.equal(
    (await db.query('SELECT * FROM CronPlanRules', { type: QueryTypes.SELECT }))
      .length,
    3,
  );
});

test('bounded audit calendars agree with scheduled slots at minute and day boundaries', () => {
  const base = new Date(2026, 0, 11, 23, 59, 50, 950).getTime();
  for (const rule of [
    '*/2 * * * * *',
    '2,7,59 * * * * *',
    '0 * * * *',
    '*/13 * * 12 * MON',
  ]) {
    const reference = upcomingSlots(rule, base, 33);
    const last = reference[31];
    assert.deepEqual(
      upcomingSlots(rule, base, Infinity, last),
      reference.slice(0, 32),
    );
  }
});

test('scheduler registration acknowledges durable plans and serializes invalid edits, publication failures and deletes', async (t) => {
  const { db } = await fixture(t);
  const scheduleStacks = new Map();
  const mocks = {
    './data': { scheduleStacks },
    '../loaders/logger': logger,
    '../cron/execution/runCron': { runCron() {} },
  };
  const { registeredAdd, registeredDelete } = load(
    'back/schedule/registeredPlans.ts',
    {
      '../data': { sequelize: db },
      './addCron': load('back/schedule/addCron.ts', mocks),
      './delCron': load('back/schedule/delCron.ts', mocks),
    },
  );
  const apply = (request, handler = registeredAdd) =>
    new Promise((resolve, reject) => {
      handler({ request }, (error) => (error ? reject(error) : resolve()));
    });
  const id = '757575',
    rule = '0 0 1 * *';
  const add = (schedule) => ({
    crons: [{ id, schedule, command: 'true' }],
    replace: false,
  });
  t.after(() => {
    scheduleStacks.get(id)?.forEach((job) => job.cancel());
    scheduleStacks.delete(id);
  });
  await apply({ crons: [], replace: true });
  await apply({
    replace: false,
    crons: [
      { id, schedule: '10 0 1 * *', command: 'true' },
      ...add(rule).crons,
    ],
  });
  const original = scheduleStacks.get(id);
  assert.ok(original?.length);
  const active = () =>
    db.query('SELECT schedule FROM CronPlanRules WHERE until IS NULL', {
      type: QueryTypes.SELECT,
    });
  await assert.rejects(apply(add('impossible ! !')));
  await db.query(
    "CREATE TRIGGER reject_new_rule BEFORE INSERT ON CronPlanRules BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  await assert.rejects(apply(add('10 0 1 * *')), (err) =>
    err.original?.message.includes('injected'),
  );
  assert.equal(scheduleStacks.get(id), original);
  assert.deepEqual(await active(), [{ schedule: rule }]);
  await db.query('DROP TRIGGER reject_new_rule');
  await Promise.all([
    apply({ ids: [id] }, registeredDelete),
    apply(add('10 0 1 * *')),
  ]);
  assert.deepEqual(await active(), [{ schedule: '10 0 1 * *' }]);
  assert.notEqual(scheduleStacks.get(id), original);
});

test('schedule audit uses the runtime cutover when saving rules crosses a due slot, and keeps a prior day bounded', async (t) => {
  const { db, history } = await fixture(t);
  const {
    saveSchedulePlan,
    confirmSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const midnight = new Date(2026, 0, 13).getTime();
  const rule = '* * * * * *',
    replacement = '*/2 * * * * *';
  const apply = (schedule, at, token) =>
    saveSchedulePlan(
      db,
      { replace: true, crons: [{ id: '2', schedule }] },
      at,
      token,
    );
  await apply(rule, midnight - 4001);
  await apply(replacement, midnight - 2900, 'change');
  await history.enqueue(
    slotId('2', 0, rule, midnight - 1000),
    2,
    'node',
    midnight - 1000,
    midnight + 350,
  );
  await confirmSchedulePlan(db, 'change', midnight - 500, midnight - 490, true);
  await history.enqueue(
    slotId('2', 0, replacement, midnight),
    2,
    'node',
    midnight,
    midnight + 150,
  );
  const oldDay = await auditSchedule(db, midnight - 86400000, midnight + 10000);
  assert.deepEqual(
    [oldDay.expected, oldDay.observed, oldDay.missing, oldDay.through],
    [4, 1, 3, midnight - 1],
  );
  const today = await auditSchedule(db, midnight, midnight + 10000);
  assert.deepEqual(
    [today.expected, today.observed, today.missing, today.partial],
    [3, 1, 2, false],
  );
});

test('an interrupted timer switch keeps uncertain slots separate across retries and full reconciliation', async (t) => {
  const { db } = await fixture(t);
  const {
    saveSchedulePlan,
    confirmSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const base = new Date(2026, 0, 12, 8).getTime(),
    schedule = '* * * * * *';
  const task = (id) => ({ id, schedule });
  await saveSchedulePlan(db, { replace: true, crons: [task('1')] }, base);
  await saveSchedulePlan(
    db,
    { replace: false, crons: [task('2')] },
    base + 100,
    'unacknowledged',
  );
  const audit = () => auditSchedule(db, base, base + 10000);
  let a = await audit();
  assert.deepEqual([a.expected, a.missing, a.partial], [5, 5, true]);
  await saveSchedulePlan(
    db,
    { replace: true, crons: [task('1'), task('2')] },
    base + 3400,
    'restart',
  );
  await confirmSchedulePlan(db, 'restart', base + 3490, base + 3500, true);
  await confirmSchedulePlan(db, 'restart', base + 8490, base + 8500, true);
  a = await audit();
  assert.deepEqual([a.expected, a.missing, a.partial], [7, 7, true]);
});

test('periodic recovery accepts live and late entry samples by trigger ID without changing outcomes or daily counts', async (t) => {
  const { root, history, stats } = await journalFixture(t);
  await fs.mkdir(path.join(root, '.tmp'));
  const marker = (id) => path.join(root, '.tmp', 'cron-start-' + id);
  const start = Date.now() - 5000;
  for (const id of ['live-entry', 'late-entry', 'past-exit']) {
    await history.enqueue(id, 1, 'manual', null, start);
    await history.start(id, start, true);
    await history.bindCommand(id, process.pid);
  }
  await history.complete('late-entry', 'failed', null, 7, start + 1000);
  await history.complete('past-exit', 'finished', null, 0, start + 1000);
  await fs.writeFile(marker('late-entry'), 'partial');
  await fs.writeFile(marker('live-entry'), String(start + 50));
  await fs.writeFile(marker('past-exit'), String(start + 1001));
  const read = async (id) => (await history.visibleTriggers(1, [id]))[0];
  await history.retryPendingExits();
  assert.equal((await read('live-entry')).script_started_at, start + 50);
  assert.equal((await read('late-entry')).script_started_at, null);
  assert.equal((await read('past-exit')).script_started_at, null);
  await fs.writeFile(marker('late-entry'), String(start + 70));
  await history.retryPendingExits();
  const late = await read('late-entry');
  assert.deepEqual(
    [late.state, late.exit_code, late.finished_at, late.script_started_at],
    ['failed', 7, start + 1000, start + 70],
  );
  await assert.rejects(fs.stat(marker('late-entry')), { code: 'ENOENT' });
  await fs.writeFile(marker('late-entry'), String(start + 90));
  await history.retryPendingExits();
  assert.equal((await read('late-entry')).script_started_at, start + 70);
  assert.equal((await read('live-entry')).state, 'running');
  const stat = await stats.CrontabStatModel.findOne();
  assert.equal(stat.run_count, 2);
  assert.equal(stat.fail_count, 1);
});

test('system crond reconciles confirmed minutes separately, preserving duplicates, skips and unidentified receipts', async (t) => {
  const { db, history, models } = await fixture(t);
  const {
    stageSystemPlan,
    confirmSystemPlan,
    suspendSystemPlan,
    systemScheduleAudit,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const minute = 60000,
    start = new Date(2026, 10, 16, 0, 0).getTime();
  const rule = { id: 1, schedule: '* * * * *', name: 'per minute' };
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    allow_multiple_instances: 1,
  });
  const first = await stageSystemPlan(db, [rule], start);
  await confirmSystemPlan(db, first, start + 3);
  const rows = [
    [1, 'started', 'running', rule.schedule],
    [1, 'duplicate', 'skipped', rule.schedule],
    [2, 'skip', 'skipped', rule.schedule],
    [3, 'old-format', 'finished', null],
    [4, 'late-old-rule', 'finished', rule.schedule],
  ];
  for (const [offset, id, state, schedule] of rows) {
    const at = start + offset * minute + 200;
    await db.query(
      `INSERT INTO CronTriggers(id,cron_id,source,state,system_rule,observed_at,command_started_at,system_dispatch_at)
      VALUES($id,1,'system',$state,$schedule,$at,$launch,$dispatch)`,
      {
        bind: {
          id,
          state,
          schedule,
          at,
          launch: state === 'running' ? at : null,
          dispatch: offset < 3 ? at : null,
        },
      },
    );
  }
  await stageSystemPlan(db, [], start + 3 * minute + 3000); // install failed or crashed
  const switched = await stageSystemPlan(db, [rule], start + 5 * minute - 50);
  await confirmSystemPlan(db, switched, start + 5 * minute + 50);
  const audit = await systemScheduleAudit(db, start, start + 8 * minute + 6000);
  assert.deepEqual(
    [
      audit.expected,
      audit.observed,
      audit.missing,
      audit.dispatched,
      audit.actualStarts,
      audit.skipped,
      audit.duplicates,
      audit.unmatched,
    ],
    [4, 2, 1, 1, 1, 1, 1, 2],
  );
  assert.equal(audit.actualSkips, 2);
  assert.deepEqual(
    audit.recent
      .filter((r) => r.triggerCount)
      .map((r) => [r.triggerCount, r.startCount, r.skipCount]),
    [
      [1, 0, 1],
      [2, 1, 1],
    ],
  );
  assert.equal(audit.partial, true);
  assert.deepEqual(
    audit.recent.map((r) => [r.time - start, r.status]),
    [
      [8 * minute, 'awaiting'],
      [7 * minute, 'missing'],
      [6 * minute, 'switch'],
      [5 * minute, 'switch'],
      [4 * minute, 'switch'],
      [3 * minute, 'switch'],
      [2 * minute, 'skipped'],
      [minute, 'started'],
      [0, 'switch'],
    ],
  );
  await db.query(
    "UPDATE CronTriggers SET script_started_at=observed_at+1 WHERE id='old-format'",
  );
  const withLegacy = await systemScheduleAudit(
    db,
    start,
    start + 8 * minute + 6000,
  );
  assert.equal(withLegacy.actualStarts, 2);
  assert.equal(withLegacy.dispatched, 1);
  assert.equal(withLegacy.unmatched, 2);
  const legacy = await history.startSystem('legacy-system-untimed', 1, 'test');
  assert.equal(legacy, true);
  assert.equal((await history.recent(1, 0))[0].command_started_at, null);
  await suspendSystemPlan(db);
  await suspendSystemPlan(db);
  const [last] = await db.query(
    "SELECT COUNT(*) AS n FROM CronSystemPlans WHERE rules='[]' AND confirmed IS NULL",
    { type: QueryTypes.SELECT },
  );
  assert.equal(last.n, 2);
});

test('queue admission captures shared budget holders and freezes the wait on dispatch', async (t) => {
  const { db, history, models } = await fixture(t);
  const limit = load('back/cron/execution/cronLimit.ts', {
    '../../data/system': {
      SystemModel: { sync: async () => {}, findOne: async () => null },
      AuthDataType: {},
    },
    '../../loaders/logger': logger,
    '../../services/notify': class {},
    '../../config': {},
    '../../config/grpcCerts': {},
    '../../protos/api': {},
  }).default;
  await limit.setCustomLimit(2);
  await db.query(
    "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('systemConfig','{\"cronConcurrency\":2}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  await models.CrontabModel.create({ id: 1, command: 'true' });
  for (const id of ['A', 'B', 'scheduled-A'])
    await history.enqueue(id, 1, 'manual', null, Date.now());
  const holders = [];
  const hold = (id, scheduled = false) => {
    const job = () => new Promise((resolve) => holders.push({ id, resolve }));
    return scheduled
      ? limit.runWithCronLimit(
          { id, name: id },
          job,
          undefined,
          () => true,
          undefined,
          undefined,
          id,
          db,
        )
      : limit.manualRunWithCronLimit(job, undefined, { id, name: id }, db);
  };
  const work = [hold('A'), hold('B'), hold('scheduled-A', true)];
  t.after(async () => {
    holders.forEach((x) => x.resolve());
    await Promise.all(work);
  });
  const queued = Date.now();
  await history.enqueue('short', 1, 'manual', null, queued);
  const short = limit.manualRunWithCronLimit(
    async () => {
      await history.start('short');
      await history.complete('short', 'finished', null, 0);
    },
    undefined,
    { id: 'short', name: 'C' },
    db,
  );
  const { oldestQueued } = require('../../back/cron/queries/queueDiagnostics');
  let row;
  for (let i = 0; i < 100; i++) {
    row = (await oldestQueued(db)).find((entry) => entry.id === 'short');
    if (row?.queue_context) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const context = JSON.parse(row.queue_context);
  assert.deepEqual(context, {
    queue: 'global',
    limit: 2,
    occupied: 2,
    holders: [
      { id: 'A', name: 'true' },
      { id: 'B', name: 'true' },
    ],
  });
  holders.find((x) => x.id === 'A').resolve();
  holders.find((x) => x.id === 'B').resolve();
  await short;
  holders.forEach((holder) => holder.resolve());
  await Promise.all(work);
  const [done] = await history.recent(1, 0);
  assert.equal(done.state, 'finished');
  assert.equal(done.queue_context, row.queue_context);
  assert.ok(done.started_at >= queued);
  assert.deepEqual(await oldestQueued(db), []);
});

test('changing the limit resamples remaining holders and ends waiting at dequeue before command preparation', async (t) => {
  const { db, history, models } = await fixture(t);
  const limit = load('back/cron/execution/cronLimit.ts', {
    '../../data/system': {
      SystemModel: { sync: async () => {}, findOne: async () => null },
      AuthDataType: {},
    },
    '../../loaders/logger': logger,
    '../../services/notify': class {},
    '../../config': {},
    '../../config/grpcCerts': {},
    '../../protos/api': {},
  }).default;
  await limit.setCustomLimit(3);
  await db.query(
    "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('systemConfig','{\"cronConcurrency\":3}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  for (const id of ['A', 'B', 'C'])
    await history.enqueue(id, 1, 'manual', null, Date.now());
  await models.CrontabModel.create({ id: 1, command: 'true' });
  const gates = new Map(),
    work = [];
  const gate = (id) => new Promise((resolve) => gates.set(id, resolve));
  for (const id of ['A', 'B', 'C'])
    work.push(
      limit.manualRunWithCronLimit(
        () => gate(id),
        undefined,
        { id, name: id },
        db,
      ),
    );
  await history.enqueue('D', 1, 'manual', null, Date.now());
  work.push(
    limit.manualRunWithCronLimit(
      async () => {
        await gate('prepare');
        await history.start('D');
        await history.complete('D', 'finished', null, 0);
      },
      undefined,
      { id: 'D', name: 'D' },
      db,
    ),
  );
  t.after(async () => {
    for (const done of gates.values()) done();
  });
  const read = async () => (await history.recent(1, 0))[0];
  async function sample(check) {
    for (let i = 0; i < 150; i++) {
      const row = await read();
      if (check(row)) return row;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('queue did not publish expected sample');
  }
  await sample((r) => JSON.parse(r.queue_context)?.occupied === 3);
  await limit.setCustomLimit(1);
  await db.query(
    "UPDATE Auths SET info='{\"cronConcurrency\":1}' WHERE type='systemConfig'",
  );
  gates.get('B')();
  const cut = await sample((r) => {
    const v = JSON.parse(r.queue_live_context);
    return v?.limit === 1 && v.occupied === 2;
  });
  assert.deepEqual(
    JSON.parse(cut.queue_live_context).holders.map((h) => h.id),
    ['A', 'C'],
  );
  gates.get('A')();
  await sample((r) => JSON.parse(r.queue_live_context)?.occupied === 1);
  await limit.setCustomLimit(2);
  await db.query(
    "UPDATE Auths SET info='{\"cronConcurrency\":2}' WHERE type='systemConfig'",
  );
  const preparing = await sample((r) => r.dequeued_at != null);
  assert.equal(preparing.state, 'queued');
  assert.equal(preparing.started_at, null);
  assert.equal(preparing.queue_live_context, null);
  await new Promise((r) => setTimeout(r, 30));
  gates.get('prepare')();
  gates.get('C')();
  await Promise.all(work);
  const ended = await read();
  assert.equal(ended.dequeued_at, preparing.dequeued_at);
  assert.ok(ended.started_at - ended.dequeued_at >= 25);
  assert.deepEqual(
    JSON.parse(ended.queue_context).holders.map((h) => h.id),
    ['A', 'B', 'C'],
  );
});

test('a stamped late system receipt stays on its dispatch day and an unstamped one cannot claim the next minute', async (t) => {
  const { db } = await fixture(t),
    {
      stageSystemPlan,
      confirmSystemPlan,
      systemScheduleAudit,
    } = require('../../back/cron/scheduling/systemScheduleAudit');
  const day = +new Date(2026, 10, 16),
    m = 60000,
    rule = { id: 1, schedule: '* * * * *' };
  const id = await stageSystemPlan(db, [rule], day - 4 * m);
  await confirmSystemPlan(db, id, day - 4 * m + 30);
  const midnight = new Date(day);
  midnight.setHours(0, 0, 0, 0);
  const prev = new Date(midnight);
  prev.setDate(prev.getDate() - 1);
  for (const [id, stamp, at] of [
    ['late', day - m, day + 2100],
    ['legacy', null, day + m + 500],
  ]) {
    await db.query(
      "INSERT INTO CronTriggers(id,cron_id,source,state,system_rule,system_dispatch_at,observed_at,command_started_at) VALUES($id,1,'system','finished',$rule,$stamp,$at,$at)",
      { bind: { id, rule: rule.schedule, stamp, at } },
    );
  }
  const before = await systemScheduleAudit(db, +prev, day + 3 * m),
    after = await systemScheduleAudit(db, day, day + 3 * m + 5000);
  assert.equal(before.recent.find((r) => r.time === day - m).id, 'late');
  assert.equal(after.observed, 0);
  assert.equal(after.unmatched, 1);
  assert.equal(after.uncertain, 2);
  assert.equal(after.missing, 1);
  assert.equal(after.awaiting, 1);
});

test('repeated failed installs retain the original uncertain interval across reopening the DB', async (t) => {
  const { db, root } = await fixture(t);
  const {
    stageSystemPlan,
    confirmSystemPlan,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const rules = [
    { id: 2, schedule: '* * * * *' },
    { id: 1, schedule: '0 * * * *' },
  ];
  const first = await stageSystemPlan(db, rules, 1000);
  const reopened = new Sequelize({
    dialect: 'sqlite',
    storage: db.options.storage,
    logging: false,
  });
  try {
    assert.equal(
      await stageSystemPlan(reopened, [...rules].reverse(), 61000),
      first,
    );
    await confirmSystemPlan(reopened, first, 64000);
    const [[row]] = await db.query('SELECT * FROM CronSystemPlans');
    assert.equal(row.staged, 1000);
    assert.equal(row.confirmed, 64000);
    const next = await stageSystemPlan(db, rules, 65000);
    assert.notEqual(first, next);
    assert.notEqual(await stageSystemPlan(db, [], 66000), next);
  } finally {
    await reopened.close();
  }
});

test('a delayed system dispatch reaching a disabled task records one skip in its original minute', async (t) => {
  const { db, models, history } = await fixture(t);
  const {
    stageSystemPlan,
    confirmSystemPlan,
    systemScheduleAudit,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const start = +new Date(2026, 10, 16),
    minute = 60000,
    schedule = '* * * * *';
  await models.CrontabModel.create({ id: 1, isDisabled: 1, command: 'true' });
  const plan = await stageSystemPlan(
    db,
    [{ id: 1, schedule }],
    start - 3 * minute,
  );
  await confirmSystemPlan(db, plan, start - 3 * minute + 1);
  const off = await stageSystemPlan(db, [], start + minute + 50);
  await confirmSystemPlan(db, off, start + minute + 100);
  const wrapper = {
    rule: schedule,
    dispatch: start + minute,
    at: start + 2 * minute + 100,
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      await history.startSystem('delayed', 1, 'test', 'test', wrapper),
      false,
    );
  const [row] = await history.recent(1, 0);
  assert.equal(row.state, 'skipped');
  assert.equal(row.reason, 'changed');
  assert.equal(row.command_started_at, null);
  const audit = await systemScheduleAudit(db, start, start + 3 * minute);
  assert.equal(audit.skipped, 1);
  assert.equal(audit.actualStarts, 0);
  assert.equal(
    audit.recent.find((r) => r.id === 'delayed').time,
    wrapper.dispatch,
  );
});

test('recovery of an unclaimed trigger starts a new wait measurement without the previous holders', async (t) => {
  const { db, history } = await fixture(t);
  await history.enqueue('reclaim', 1, 'node', 1000, 1001);
  await db.query(
    "UPDATE CronTriggers SET state='skipped',reason='restart',dequeued_at=1030,queue_context='{}',queue_live_context='{}' WHERE id='reclaim'",
  );
  assert.equal(
    await history.enqueue('reclaim', 1, 'recovery', 1000, 5000),
    true,
  );
  const [row] = await history.recent(1, 0);
  assert.equal(row.queued_at, 5000);
  for (const col of ['dequeued_at', 'queue_context', 'queue_live_context'])
    assert.equal(row[col], null);
});

test('a late duplicate skip survives reopening and retries without moving to the next crond minute', async (t) => {
  const { db, models, history } = await fixture(t);
  const {
    stageSystemPlan,
    confirmSystemPlan,
    systemScheduleAudit,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const minute = 60000;
  const first = +new Date(2026, 10, 16),
    next = first + minute;
  const schedule = '* * * * *';
  await models.CrontabModel.create({
    id: 1,
    command: 'true',
    allow_multiple_instances: 0,
  });
  const plan = await stageSystemPlan(
    db,
    [{ id: 1, schedule }],
    first - 3 * minute,
  );
  await confirmSystemPlan(db, plan, first - 2 * minute);
  const start = (store, id, dispatch, at) =>
    store.startSystem(id, 1, 'test-owner', 'test-command', {
      rule: schedule,
      dispatch,
      at,
    });
  async function check(connection, now, duplicates, slots) {
    const audit = await systemScheduleAudit(connection, first, now);
    assert.deepEqual(
      audit.recent.map((r) => [
        r.time,
        r.triggerCount,
        r.startCount,
        r.skipCount,
      ]),
      slots,
    );
    assert.deepEqual(
      [
        audit.expected,
        audit.observed,
        audit.actualStarts,
        audit.actualSkips,
        audit.duplicates,
        audit.missing,
        audit.unmatched,
      ],
      [slots.length, slots.length, slots.length, duplicates, duplicates, 0, 0],
    );
  }
  assert.equal(await start(history, 'first', first, first + 100), true);
  await history.finish('first', 'finished', null, 0);
  const original = [first, 1, 1, 0],
    following = [next, 1, 1, 0];
  await check(db, first + 8000, 0, [original]);

  const reopened = new Sequelize({
    dialect: 'sqlite',
    storage: db.options.storage,
    logging: false,
  });
  try {
    const recovered = new TriggerHistory(reopened);
    assert.equal(await start(recovered, 'following', next, next + 100), true);
    await check(reopened, next + 8000, 0, [following, original]);
    assert.equal(
      await start(recovered, 'duplicate', first, next + 10000),
      false,
    );
    await check(db, next + 11000, 1, [following, [first, 2, 1, 1]]);
    await recovered.finish('following', 'finished', null, 0);
    assert.equal(await start(history, 'duplicate', first, next + 15000), false);
    await check(reopened, next + 16000, 1, [following, [first, 2, 1, 1]]);
  } finally {
    await reopened.close();
  }
});

test('system crond publishes an exit only for a claimed command, including command exit 75', async (t) => {
  const { root } = await fixture(t);
  const client = path.join(root, 'node');
  const trace = path.join(root, 'receipts');
  await fs.writeFile(
    client,
    [
      '#!/bin/sh',
      'if [ "$1" = -p ]; then echo uuid; exit 0; fi',
      'if [ "$2" = start ]; then echo start >> "$TRACE"; exit "$CLAIM_STATUS"; fi',
      'echo "finish $6" >> "$TRACE"',
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const [claim, exit, expectedStatus, receipts] of [
    [75, 0, 0, ['start']],
    [1, 0, 1, ['start']],
    [0, 75, 75, ['start', 'finish 75']],
    [0, 0, 0, ['start', 'finish 0']],
  ]) {
    await fs.writeFile(trace, '');
    const run = require('node:child_process').spawnSync(
      '/bin/bash',
      [
        path.resolve('shell/system-cron.sh'),
        'echo task-output; exit "$EXIT_STATUS"',
      ],
      {
        env: {
          ...process.env,
          QL_DIR: root,
          ID: '7',
          TRACE: trace,
          CLAIM_STATUS: String(claim),
          EXIT_STATUS: String(exit),
          PATH: root + ':' + process.env.PATH,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(run.status, expectedStatus, run.stderr);
    assert.equal(run.stdout, claim === 0 ? 'task-output\n' : '');
    assert.deepEqual(
      (await fs.readFile(trace, 'utf8')).trim().split('\n'),
      receipts,
    );
  }
});

test('crond restart keeps an interrupted run unknown and only counts committed duplicate skips', async (t) => {
  const { db, models, history } = await fixture(t);
  const {
    stageSystemPlan,
    confirmSystemPlan,
    systemScheduleAudit,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const minute = 60000;
  const first = +new Date(2026, 10, 16),
    next = first + minute;
  const schedule = '* * * * *',
    owner = systemOwner(process.pid);
  await models.CrontabModel.create({ id: 1, command: 'true', isDisabled: 0 });
  const plan = await stageSystemPlan(
    db,
    [{ id: 1, schedule }],
    first - 3 * minute,
  );
  await confirmSystemPlan(db, plan, first - 2 * minute);
  const start = (store, id, dispatch, birth) =>
    store.startSystem(id, 1, birth, birth, {
      rule: schedule,
      dispatch,
      at: dispatch + 50,
    });
  assert.equal(await start(history, 'old-run', first, owner + '-old'), true);
  // The insert has succeeded inside the transaction, but even an interrupted
  // skip decision must leave no durable trigger if the transaction rolls back.
  await db.query(`CREATE TRIGGER abort_duplicate BEFORE UPDATE OF state ON CronTriggers
    WHEN OLD.id='unsaved' AND NEW.state='skipped' BEGIN SELECT RAISE(ABORT,'interrupted skip'); END`);
  await assert.rejects(start(history, 'unsaved', first, owner), (error) =>
    /interrupted skip/.test(error.parent?.message),
  );
  const reopened = new Sequelize({
    dialect: 'sqlite',
    storage: db.options.storage,
    logging: false,
  });
  try {
    const recovered = new TriggerHistory(reopened);
    await recovered.interrupt('http');
    assert.equal(await start(recovered, 'new-run', next, owner), true);
    assert.equal(await start(recovered, 'confirmed-skip', next, owner), false);
    for (let retry = 0; retry < 2; retry++) {
      assert.equal(await start(recovered, 'old-run', first, owner), false);
      await recovered.interrupt('http');
      const rows = await recovered.visibleTriggers(1, [
        'unsaved',
        'old-run',
        'new-run',
        'confirmed-skip',
      ]);
      assert.deepEqual(rows.map((r) => [r.id, r.state, r.exit_code]).sort(), [
        ['confirmed-skip', 'skipped', null],
        ['new-run', 'running', null],
        ['old-run', 'unknown', null],
      ]);
      const audit = await systemScheduleAudit(reopened, first, next + 8000);
      assert.deepEqual(
        [
          audit.expected,
          audit.observed,
          audit.actualStarts,
          audit.actualSkips,
          audit.duplicates,
          audit.missing,
          audit.unmatched,
        ],
        [2, 2, 2, 1, 1, 0, 0],
      );
      assert.deepEqual(
        audit.recent.map((r) => [
          r.time,
          r.triggerCount,
          r.startCount,
          r.skipCount,
          r.unknownExitCount,
        ]),
        [
          [next, 2, 1, 1, 0],
          [first, 1, 1, 0, 1],
        ],
      );
    }
  } finally {
    await reopened.close();
  }
});

test('a late skipped timer affects trigger deviation but only valid queue endpoints enter wait P95', async (t) => {
  const { db, history } = await fixture(t);
  const {
    saveSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const day = +new Date(2026, 10, 16);
  const rule = '* * * * *';
  await saveSchedulePlan(
    db,
    { crons: [{ id: '1', schedule: rule }], replace: true },
    day,
  );
  for (const [minute, deviation, dequeue, start, state] of [
    [1, 1703994, null, null, 'skipped'],
    [2, 18, null, 136, 'finished'],
    [3, 20, 24, 850, 'finished'],
    [4, 12, null, null, 'queued'],
    [5, 15, -1, 65, 'finished'],
    [6, 5, 0, 7, 'finished'],
  ]) {
    const scheduled = day + minute * 60000;
    const observed = scheduled + deviation;
    await db.query(
      `INSERT INTO CronTriggers
      (id,cron_id,source,state,scheduled_at,observed_at,queued_at,dequeued_at,started_at)
      VALUES($id,1,'node',$state,$scheduled,$observed,$observed,$dequeue,$start)`,
      {
        bind: {
          id: slotId('1', 0, rule, scheduled),
          state,
          scheduled,
          observed,
          dequeue: dequeue == null ? null : observed + dequeue,
          start: start == null ? null : observed + start,
        },
      },
    );
  }
  const audit = await auditSchedule(db, day, day + 60 * 60000);
  assert.equal(audit.observed, 6);
  assert.equal(audit.triggerDeviationP95, 1703994);
  assert.equal(audit.waitSamples, 3);
  assert.equal(audit.waitP95, 136);
  const metrics = await history.metrics(day);
  assert.equal(metrics.samples, 3);
  assert.equal(metrics.waitP95, 136);
});

test('overview clock pins the original server day when its data query crosses midnight', async (t) => {
  const { root, models, stats } = await fixture(t);
  const day = require('dayjs')().startOf('day');
  const midnight = day.add(1, 'day').valueOf();
  let clock = midnight - 100;
  t.mock.method(Date, 'now', () => clock);
  const router = express.Router();
  load('back/api/dashboard.ts', {
    '../config': { logPath: root },
    '../data/cron': models,
    '../data/cronStats': stats,
    '../cron/history': {
      TriggerHistory: class {
        async metrics(since) {
          assert.equal(since, day.valueOf());
          clock = midnight + 100;
          return { audit: { through: midnight - 5100 } };
        }
      },
    },
  }).default(router);
  const handler = router.stack[0].handle.stack
    .find((x) => x.route?.path === '/overview')
    .route.stack.at(-1).handle;
  let result;
  await handler(
    {},
    {
      send(value) {
        result = value;
      },
    },
    (error) => {
      throw error;
    },
  );
  assert.equal(result.code, 200);
  assert.equal(result.data.serverNow, midnight - 100);
  assert.equal(result.data.expiresAt, midnight);
  assert.equal(result.data.todayRuns, 0);
});

test('panel anomaly pages match scheduled counts, isolate overlapping rules and restart paging on late evidence', async (t) => {
  const { db, history } = await fixture(t);
  const { AnomalyPage } = require('../../back/cron/queries/scheduleAnomalies');
  const {
    saveSchedulePlan,
    auditSchedule,
  } = require('../../back/cron/scheduling/scheduleAudit');
  const start = new Date(2026, 1, 1, 9).getTime(),
    rule = '* * * * * *';
  await saveSchedulePlan(
    db,
    {
      replace: true,
      crons: [
        { id: '9', schedule: rule, extra_schedules: [{ schedule: rule }] },
      ],
    },
    start,
  );
  const read = async (kind, page = 1, revision) => {
    const rows = new AnomalyPage(kind, page, revision);
    const audit = await auditSchedule(db, start, start + 35000, rows);
    const result = rows.result();
    assert.equal(result.total, audit[kind]);
    return result;
  };
  const put = (i, n, source = 'node') => {
    const at = start + n * 1000;
    return history.enqueue(slotId('9', i, rule, at), 9, source, at, at);
  };
  const first = await read('missing'),
    second = await read('missing', 2, first.revision);
  assert.equal(first.total, 60);
  assert.equal(second.page, 2);
  assert.equal(
    new Set(
      [...first.rows, ...second.rows].map((r) => r.ruleIndex + '/' + r.time),
    ).size,
    50,
  );
  await put(0, 1, 'recovery');
  await put(1, 1);
  await put(0, 2);
  await put(1, 2);
  const id = (i, n) => slotId('9', i, rule, start + n * 1000);
  await history.finish(id(0, 1), 'skipped', 'overlap', null);
  await history.start(id(1, 1), start + 1100, true);
  await history.finish(id(1, 1), 'failed', 'spawn', 127);
  await db.query("UPDATE CronTriggers SET log_path='one.log' WHERE id=$id", {
    bind: { id: id(1, 1) },
  });
  await history.recordCommandStart(id(0, 2), start + 2100);
  const late = await read('missing', 2, first.revision);
  assert.deepEqual([late.changed, late.page, late.total], [true, 1, 56]);
  assert.ok(late.rows.every((r) => r.trigger === null && !r.logPath));
  assert.deepEqual(
    (await read('skipped')).rows.map((r) => [r.trigger, r.reason, r.source]),
    [[id(0, 1), 'overlap', 'recovery']],
  );
  assert.deepEqual(
    (await read('unconfirmed')).rows.map((r) => [r.trigger, !!r.logPath]),
    [[id(1, 1), true]],
  );
});

test('crond anomaly details count individual duplicate and unmatched receipts without inventing their schedule', async (t) => {
  const { db } = await fixture(t);
  const { AnomalyPage } = require('../../back/cron/queries/scheduleAnomalies');
  const {
    stageSystemPlan,
    confirmSystemPlan,
    systemScheduleAudit,
  } = require('../../back/cron/scheduling/systemScheduleAudit');
  const m = 60000,
    start = new Date(2026, 1, 1, 9).getTime(),
    schedule = '* * * * *';
  const plan = await stageSystemPlan(
    db,
    [{ id: 1, name: 'minute', schedule }],
    start - 2 * m,
  );
  await confirmSystemPlan(db, plan, start - 2 * m + 1);
  for (const [id, state, launch, rule, dispatch, observed, log] of [
    ['ran', 'finished', start + 1, schedule, start, start, null],
    ['skip', 'skipped', null, schedule, start, start + m + 7, null],
    ['unknown', 'unknown', null, schedule, start, start + 2, null],
    ['old', 'skipped', null, null, null, start + 3, '/dev/null'],
    [
      'unmatched',
      'unknown',
      null,
      '0 0 * * *',
      start + m,
      start + m + 4,
      'task/x.log',
    ],
  ])
    await db.query(
      "INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,system_rule,system_dispatch_at,command_started_at,log_path) VALUES($id,1,'system',$state,$observed,$rule,$dispatch,$launch,$log)",
      { bind: { id, state, launch, rule, dispatch, observed, log } },
    );
  for (const [kind, field, count] of [
    ['missing', 'missing', 2],
    ['skipped', 'actualSkips', 2],
    ['unconfirmed', 'actualUnconfirmed', 2],
  ]) {
    const page = new AnomalyPage(kind, 1);
    const audit = await systemScheduleAudit(
        db,
        start,
        start + 4 * m + 6000,
        page,
      ),
      report = page.result();
    assert.equal(report.total, count);
    assert.equal(audit[field], count);
    assert.equal(
      audit.actualStarts + audit.actualSkips + audit.actualUnconfirmed,
      5,
    );
    if (kind === 'missing')
      assert.deepEqual(
        report.rows.map((r) => r.time),
        [start + 2 * m, start + 3 * m],
      );
    if (kind === 'skipped')
      assert.deepEqual(
        report.rows.map((r) => [r.trigger, r.time, r.logPath]),
        [
          ['old', null, '/dev/null'],
          ['skip', start, null],
        ],
      );
    if (kind === 'unconfirmed')
      assert.deepEqual(
        report.rows.map((r) => [r.trigger, r.time, r.logPath]),
        [
          ['unknown', start, null],
          ['unmatched', null, 'task/x.log'],
        ],
      );
  }
});

test('anomaly endpoint resolves task names and offers only the retained log for the exact trigger', async (t) => {
  const { root, db, models, stats } = await fixture(t);
  const at = require('dayjs')().subtract(1, 'day').hour(12).valueOf();
  await models.CrontabModel.create({
    id: 4,
    name: 'Report',
    command: 'echo report',
  });
  const logs = path.join(root, 'logs');
  await fs.mkdir(logs);
  await fs.writeFile(path.join(logs, 'one.log'), 'only for run one');
  await fs.symlink(path.join(root, 'panel.sqlite'), path.join(logs, 'outside'));
  for (const [id, file] of [
    ['one', 'one.log'],
    ['two', 'missing.log'],
    ['three', 'outside'],
    ['four', '/dev/null'],
  ]) {
    await db.query(
      `INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,log_path)
      VALUES($id,4,'system','unknown',$at,$file)`,
      { bind: { id, at: at - 10000, file } },
    );
  }
  const router = express.Router();
  load('back/api/dashboard.ts', {
    '../config': { logPath: logs },
    '../data/cron': models,
    '../data/cronStats': stats,
  }).default(router);
  const handle = router.stack[0].handle.stack
    .find((layer) => layer.route?.path === '/schedule-anomalies')
    .route.stack.at(-1).handle;
  const read = async () => {
    let result;
    await handle(
      { query: { source: 'system', kind: 'unconfirmed', page: 1, at } },
      {
        send(value) {
          result = value.data;
        },
      },
      (error) => {
        throw error;
      },
    );
    assert.equal(result.total, 4);
    assert.ok(
      result.rows.every(
        (row) =>
          row.name === 'Report' && row.time === null && !('logPath' in row),
      ),
    );
    return result.rows.filter((row) => row.hasLog).map((row) => row.trigger);
  };
  assert.deepEqual(await read(), ['one']);
  await fs.unlink(path.join(logs, 'one.log'));
  assert.deepEqual(await read(), []);
});

for (const source of ['node', 'system'])
  test(
    source +
      ' anomaly pages reset after late reports and expose the same summary as starts are confirmed',
    async (t) => {
      const { root, db, models, stats, history } = await fixture(t);
      const {
        saveSchedulePlan,
      } = require('../../back/cron/scheduling/scheduleAudit');
      const {
        stageSystemPlan,
        confirmSystemPlan,
      } = require('../../back/cron/scheduling/systemScheduleAudit');
      const day = require('dayjs')()
        .subtract(1, 'day')
        .startOf('day')
        .valueOf();
      const start = day + 9 * 3600000;
      const period = source === 'node' ? 1000 : 60000;
      const rule = source === 'node' ? '* * * * * *' : '* * * * *';
      const at = start + 61 * period + 5000;
      await models.CrontabModel.create({
        id: 7,
        name: 'Late',
        command: 'echo late',
      });
      if (source === 'node')
        await saveSchedulePlan(
          db,
          { replace: true, crons: [{ id: '7', schedule: rule }] },
          start,
        );
      else {
        const plan = await stageSystemPlan(
          db,
          [{ id: 7, name: 'Late', schedule: rule }],
          start,
        );
        await confirmSystemPlan(db, plan, start + 1);
      }
      const router = express.Router();
      load('back/api/dashboard.ts', {
        '../config': { logPath: root },
        '../data/cron': models,
        '../data/cronStats': stats,
      }).default(router);
      const handler = router.stack[0].handle.stack
        .find((x) => x.route?.path === '/schedule-anomalies')
        .route.stack.at(-1).handle;
      const read = async (kind, page = 1, revision) => {
        let result;
        await handler(
          {
            query: {
              source: source === 'node' ? 'panel' : 'system',
              kind,
              at,
              page,
              revision,
            },
          },
          {
            send(value) {
              result = value.data;
            },
          },
          (error) => {
            throw error;
          },
        );
        const summary =
          result.summary[source === 'node' ? 'audit' : 'systemAudit'];
        const field =
          source === 'node' || kind === 'missing'
            ? kind
            : kind === 'skipped'
            ? 'actualSkips'
            : 'actualUnconfirmed';
        assert.equal(result.total, summary[field]);
        return result;
      };
      const first = await read('missing');
      assert.ok(first.total > 50);
      const second = await read('missing', 2, first.revision);
      const third = await read('missing', 3, first.revision);
      assert.equal(
        new Set(
          [...first.rows, ...second.rows, ...third.rows].map((r) => r.time),
        ).size,
        first.total,
      );
      const slot = first.rows[0];
      const id =
        source === 'node' ? slotId('7', 0, rule, slot.time) : 'system-late';
      await history.enqueue(id, 7, source, slot.time, at);
      await history.start(id, at, true);
      if (source === 'system')
        await db.query(
          'UPDATE CronTriggers SET system_rule=$rule,system_dispatch_at=$time WHERE id=$id',
          { bind: { rule, time: slot.time, id } },
        );
      await history.finish(id, 'failed', 'spawn', 127);
      const filled = await read('missing', 3, first.revision);
      assert.equal(filled.page, 1);
      assert.equal(filled.changed, true);
      assert.equal(filled.total, first.total - 1);
      assert.ok(filled.rows.every((row) => row.time !== slot.time));
      const unknown = await read('unconfirmed');
      assert.deepEqual(
        unknown.rows.map((r) => r.trigger),
        [id],
      );
      await history.recordCommandStart(id, at);
      const started = await read('unconfirmed', 1, unknown.revision);
      assert.equal(started.changed, true);
      assert.equal(started.total, 0);
      assert.deepEqual(started.rows, []);
      const summary =
        started.summary[source === 'node' ? 'audit' : 'systemAudit'];
      assert.equal(
        summary[source === 'node' ? 'dispatched' : 'actualStarts'],
        1,
      );
      // Same count with a different member must also invalidate page offsets.
      await db.query('DELETE FROM CronTriggers WHERE id=$id', { bind: { id } });
      const nextSlot = second.rows[0];
      const nextId =
        source === 'node'
          ? slotId('7', 0, rule, nextSlot.time)
          : 'system-other';
      await history.enqueue(nextId, 7, source, nextSlot.time, at);
      if (source === 'system')
        await db.query(
          'UPDATE CronTriggers SET system_rule=$rule,system_dispatch_at=$time WHERE id=$id',
          { bind: { rule, time: nextSlot.time, id: nextId } },
        );
      const replaced = await read('missing', 2, filled.revision);
      assert.equal(replaced.total, filled.total);
      assert.equal(replaced.changed, true);
      assert.equal(replaced.page, 1);
      const retried = await read('missing', 2, replaced.revision);
      assert.equal(retried.page, 2);
      assert.equal(retried.changed, false);
      assert.equal(
        new Set([...replaced.rows, ...retried.rows].map((r) => r.time)).size,
        50,
      );
    },
  );

for (const source of ['node', 'system'])
  test(
    source +
      ' partial history cleanup fences in-flight anomaly pages and preserves retained pagination',
    async (t) => {
      const { root, db, models, stats, history } = await fixture(t);
      const dayjs = require('dayjs');
      const at = dayjs().startOf('day').hour(12).valueOf(),
        start = at - 70 * 60000,
        rule = '* * * * *';
      t.mock.method(Date, 'now', () => at + 1000);
      await models.CrontabModel.create({
        id: 12,
        name: 'Partial cleanup',
        command: 'echo retained',
      });
      if (source === 'node')
        await require('../../back/cron/scheduling/scheduleAudit').saveSchedulePlan(
          db,
          { replace: true, crons: [{ id: '12', schedule: rule }] },
          start,
        );
      else {
        const {
          stageSystemPlan,
          confirmSystemPlan,
        } = require('../../back/cron/scheduling/systemScheduleAudit');
        const plan = await stageSystemPlan(
          db,
          [{ id: 12, schedule: rule }],
          start - 60000,
        );
        await confirmSystemPlan(db, plan, start - 60000 + 1);
      }
      const ids = [];
      for (let n = 1; n <= 60; n++) {
        const time = start + n * 60000;
        const id =
          source === 'node'
            ? slotId('12', 0, rule, time)
            : 'partial-system-' + n;
        ids.push(id);
        await history.enqueue(id, 12, source, time, time + 10);
        await history.start(id, time + 20, true);
        await history.finish(id, 'failed', 'spawn', 127);
        await db.query(
          "UPDATE CronTriggers SET finished_at=$end,log_path='retained.log',system_rule=$rule,system_dispatch_at=$time WHERE id=$id",
          { bind: { id, time, rule, end: time + 1000 } },
        );
      }
      await fs.writeFile(path.join(root, 'retained.log'), 'retained log');
      // After an upgrade the earliest known installation can be newer than
      // retained unmatched receipts. Plan coverage is not the retention boundary.
      if (source === 'system')
        await db.query(
          'UPDATE CronSystemPlans SET staged=$time,confirmed=$confirmed',
          {
            bind: {
              time: start + 40 * 60000,
              confirmed: start + 40 * 60000 + 1,
            },
          },
        );
      let cleanOnStat = false;
      const cutoff = start + 20 * 60000 + 2000;
      const router = express.Router();
      load('back/api/dashboard.ts', {
        '../config': { logPath: root },
        '../data/cron': models,
        '../data/cronStats': stats,
        'fs/promises': {
          stat: async (file) => {
            if (cleanOnStat) {
              cleanOnStat = false;
              await db.transaction((transaction) =>
                history.deleteExpired(cutoff, transaction),
              );
            }
            return fs.stat(file);
          },
        },
      }).default(router);
      const handler = router.stack[0].handle.stack
        .find((x) => x.route?.path === '/schedule-anomalies')
        .route.stack.at(-1).handle;
      const read = async (page = 1, revision, kind = 'unconfirmed') => {
        let result;
        await handler(
          {
            query: {
              source: source === 'node' ? 'panel' : 'system',
              kind,
              at,
              page,
              revision,
              live: true,
            },
          },
          {
            send(value) {
              result = value.data;
            },
          },
          (error) => {
            throw error;
          },
        );
        return result;
      };
      const first = await read();
      assert.equal(first.total, 60);
      assert.equal((await read(3, first.revision)).rows.length, 10);
      cleanOnStat = true;
      assert.deepEqual(await read(2, first.revision), {
        status: 'unavailable',
      });
      const retained = await read(3, first.revision);
      assert.equal(retained.total, 40);
      assert.equal(retained.page, 1);
      assert.equal(retained.changed, true);
      const second = await read(2, retained.revision);
      const rows = [...retained.rows, ...second.rows];
      assert.equal(new Set(rows.map((r) => r.trigger)).size, 40);
      assert.deepEqual(rows.map((r) => r.trigger).sort(), ids.slice(20).sort());
      assert.ok(rows.every((r) => r.hasLog));
      for (const kind of ['missing', 'skipped', 'unconfirmed']) {
        const result = await read(1, undefined, kind);
        const summary =
          result.summary[source === 'node' ? 'audit' : 'systemAudit'];
        const field =
          source === 'node' || kind === 'missing'
            ? kind
            : kind === 'skipped'
            ? 'actualSkips'
            : 'actualUnconfirmed';
        assert.equal(result.total, summary[field]);
        assert.ok(result.rows.every((r) => r.time == null || r.time >= cutoff));
      }
      assert.deepEqual(await history.visibleTriggers(12, ids.slice(0, 20)), []);
    },
  );

for (const source of ['node', 'system'])
  test(
    source +
      ' live anomaly sessions expire across midnight and after retained history is cleared',
    async (t) => {
      const { root, db, models, stats, history } = await fixture(t);
      const dayjs = require('dayjs');
      const {
        saveSchedulePlan,
      } = require('../../back/cron/scheduling/scheduleAudit');
      const {
        stageSystemPlan,
        confirmSystemPlan,
      } = require('../../back/cron/scheduling/systemScheduleAudit');
      const at = dayjs().startOf('day').hour(12).valueOf(),
        start = at - 180000,
        rule = '* * * * *';
      const expiresAt = dayjs(at).startOf('day').add(1, 'day').valueOf();
      let clock = at + 10000,
        crossOnStat = false;
      t.mock.method(Date, 'now', () => clock);
      await models.CrontabModel.create({
        id: 11,
        name: 'Midnight',
        command: 'echo midnight',
      });
      if (source === 'node')
        await saveSchedulePlan(
          db,
          { replace: true, crons: [{ id: '11', schedule: rule }] },
          start,
        );
      else {
        const plan = await stageSystemPlan(
          db,
          [{ id: 11, schedule: rule }],
          start - 60000,
        );
        await confirmSystemPlan(db, plan, start - 60000 + 1);
      }
      const time = Math.ceil((start + 60000) / 60000) * 60000;
      const id =
        source === 'node' ? slotId('11', 0, rule, time) : 'system-midnight';
      await history.enqueue(id, 11, source, time, time + 10);
      await history.start(id, time + 20, true);
      await history.finish(id, 'failed', 'spawn', 127);
      await fs.writeFile(path.join(root, 'midnight.log'), id);
      await db.query(
        "UPDATE CronTriggers SET finished_at=$end,log_path='midnight.log',system_rule=$rule,system_dispatch_at=$time WHERE id=$id",
        { bind: { end: time + 1000, id, rule, time } },
      );
      const router = express.Router();
      load('back/api/dashboard.ts', {
        '../config': { logPath: root },
        '../data/cron': models,
        '../data/cronStats': stats,
        'fs/promises': {
          stat: async (file) => {
            if (crossOnStat) clock = expiresAt;
            return fs.stat(file);
          },
        },
      }).default(router);
      const handler = router.stack[0].handle.stack
        .find((x) => x.route?.path === '/schedule-anomalies')
        .route.stack.at(-1).handle;
      const read = async (kind) => {
        let result;
        const res = {
          status() {
            return this;
          },
          send(value) {
            result = value;
          },
        };
        await handler(
          {
            query: {
              source: source === 'node' ? 'panel' : 'system',
              kind,
              at,
              page: 1,
              live: true,
            },
          },
          res,
          (error) => {
            throw error;
          },
        );
        assert.equal(result.code, 200);
        return result.data;
      };
      const first = await read('unconfirmed');
      assert.deepEqual(
        first.rows.map((row) => row.trigger),
        [id],
      );
      assert.equal(first.expiresAt, expiresAt);
      crossOnStat = true;
      assert.deepEqual(await read('unconfirmed'), { status: 'expired' });
      crossOnStat = false;
      assert.deepEqual(await read('missing'), { status: 'expired' });
      clock = at + 10000;
      await db.transaction((transaction) =>
        history.deleteExpired(at + 1000, transaction),
      );
      assert.deepEqual(await history.visibleTriggers(11, [id]), []);
      for (const kind of ['missing', 'skipped', 'unconfirmed'])
        assert.deepEqual(await read(kind), { status: 'unavailable' });
      // Repeated reads do not reconstitute the missing plan or the old log entry.
      assert.deepEqual(await read('unconfirmed'), { status: 'unavailable' });
      assert.deepEqual(await history.visibleTriggers(11, [id]), []);
    },
  );
