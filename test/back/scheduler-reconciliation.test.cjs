const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const load = require('../helpers/load-security-module.cjs');
const { SchedulerReadiness } = require('../../back/shared/schedulerReadiness');
const { AddCronRequest } = require('../../back/protos/cron');
const { getInvalidCronSchedules } = require('../../back/shared/cronSchedule');

function fixture(client) {
  const source = fs.readFileSync('back/services/cron.ts', 'utf8');
  const a = source.indexOf('  public async autosave_crontab(');
  const z = source.indexOf('  public async bootTask', a);
  const js = ts.transpileModule(
    'class Fixture {\n' + source.slice(a, z) + '}\nmodule.exports=Fixture;',
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const module = { exports: {} };
  new Function('module', 'isDemoEnv', 'cronClient', 'withSchedulerMutation', 'getInvalidCronSchedules', js)(
    module,
    () => false,
    client,
    (fn) => fn(),
    getInvalidCronSchedules,
  );
  const service = new module.exports();
  service.setCrontab = async () => {};
  service.logger = { warn() {} };
  service.shouldUseCronClient = () => true;
  service.makeCommand = () => 'true';
  return service;
}

test('recovery reconciles a surviving scheduler after missed deletes and disables, including an empty DB', async () => {
  const cancelled = [];
  const stacks = new Map(
    ['removed', 'disabled', 'kept'].map((id) => [
      id,
      [{ cancel: () => cancelled.push(id) }],
    ]),
  );
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    'node-schedule': {
      scheduleJob: (id) => ({ cancel: () => cancelled.push(id) }),
    },
    '../shared/runCron': {},
    '../loaders/logger': { info() {}, warn() {} },
    '../shared/i18n': { tf: (s) => s },
  });
  const client = {
    addCron: async (crons, replace) => {
      // Exercise the real protobuf field, not just a JavaScript-only flag.
      const request = AddCronRequest.decode(
        AddCronRequest.encode({ crons, replace }).finish(),
      );
      await new Promise((resolve, reject) =>
        addCron({ request }, (err) => (err ? reject(err) : resolve())),
      );
    },
  };
  const service = fixture(client);
  let rows = [
    { id: 'kept', schedule: '* * * * *', isDisabled: 0 },
    { id: 'disabled', schedule: '* * * * *', isDisabled: 1 },
  ];
  service.crontabs = async () => ({ data: rows });
  const state = new SchedulerReadiness(async () => {});
  state.configure(() => service.autosave_crontab(true));
  assert.equal(await state.recover(), true);
  assert.equal(await state.check(), true);
  assert.deepEqual([...stacks.keys()], ['kept']);
  assert.deepEqual(cancelled.sort(), ['disabled', 'kept', 'removed']);
  rows = [];
  state.invalidate();
  assert.equal(await state.recover(), true);
  assert.equal(stacks.size, 0);
  assert.equal(await state.check(), true);
});

test('invalid replacement leaves the previous schedule intact', async () => {
  const stacks = new Map([
    [
      'old',
      [
        {
          cancel: () => {
            throw Error('must not cancel');
          },
        },
      ],
    ],
  ]);
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../shared/runCron': {},
    '../loaders/logger': {},
    '../shared/i18n': { tf: (s) => s },
  });
  await assert.rejects(
    new Promise((resolve, reject) =>
      addCron(
        {
          request: {
            replace: true,
            crons: [{ id: 'bad', schedule: 'not a cron', extra_schedules: [] }],
          },
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    ),
  );
  assert.deepEqual([...stacks.keys()], ['old']);
});

test('invalid persisted schedules cannot block recovery, valid jobs or HTTP health', async (t) => {
  const stacks = new Map();
  const warnings = [];
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../shared/runCron': {},
    '../loaders/logger': { info() {}, warn() {} },
    '../shared/i18n': { tf: require('node:util').format },
  });
  const client = { addCron: (crons, replace) => new Promise((resolve, reject) => {
    addCron({ request: { crons, replace } }, (error) => error ? reject(error) : resolve());
  }) };
  const service = fixture(client);
  let snapshot;
  service.setCrontab = async (tabs) => { snapshot = tabs.data; };
  service.logger.warn = (...args) => warnings.push(require('node:util').format(...args));
  let rows = [
    { id: 'good', name: 'valid', schedule: '0 0/30 * * * ?', isDisabled: 0 },
    { id: 'bad-main', name: 'bad main', schedule: 'not a cron', isDisabled: 0 },
    { id: 'bad-extra', name: 'bad extra', schedule: '* * * * *', extra_schedules: [{ schedule: '0 70 * * * ?' }], isDisabled: 0 },
    { id: 'unsupported', name: 'unsupported', schedule: 'H * * * *', isDisabled: 0 },
    { id: 'disabled', name: 'disabled', schedule: 'bad', isDisabled: 1 },
  ];
  service.crontabs = async () => ({ data: rows });
  const state = new SchedulerReadiness(async () => {}, 60000);
  t.after(() => {
    clearTimeout(state.retry);
    for (const jobs of stacks.values()) for (const job of jobs) job.cancel();
  });
  state.configure(() => service.autosave_crontab(true));
  assert.equal(await state.recover(), true);
  assert.deepEqual([...stacks.keys()], ['good']);
  assert.deepEqual(snapshot.map((x) => x.id), ['good', 'disabled']);
  assert.equal(rows.length, 5, 'persisted rows are preserved for editing');
  assert.equal(rows[1].isDisabled, 0);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /bad-main.*bad main.*not a cron/);
  assert.match(warnings.join('\n'), /bad-extra.*0 70/);
  const { HealthService } = load('back/services/health.ts', {
    typedi: { Service: () => (x) => x }, './http': {},
    '../schedule/client': { readiness: state }, '../loaders/logger': { error() {} },
  });
  const health = new HealthService({ getServer: () => ({}) });
  assert.equal((await health.check()).status, 'ok');
  rows = rows.filter((x) => x.id !== 'good');
  assert.equal(await state.recover(), true, 'even all-invalid snapshots can recover');
  assert.equal(stacks.size, 0);
  assert.equal((await health.check()).status, 'ok');
});

test('pre-RPC channel failures invalidate readiness and return 503 without executing or replaying writes', async () => {
  for (const method of ['addCron', 'delCron']) {
    let invalidations = 0,
      writes = 0;
    const fake = {
      waitForReady: (_deadline, cb) => cb(Error('channel unavailable')),
      addCron: () => writes++,
      delCron: () => writes++,
    };
    const client = load('back/schedule/client.ts', {
      '../protos/cron': {
        CronClient: class {
          constructor() {
            return fake;
          }
        },
      },
      '../config': { grpcPort: 5500 },
      '../config/grpcCerts': {
        getGrpcCerts: () => ({
          caCert: 'ca',
          clientKey: 'key',
          clientCert: 'cert',
        }),
      },
      '@grpc/grpc-js': {
        ...require('@grpc/grpc-js'),
        credentials: { createSsl: () => ({}) },
      },
    }).default;
    client.readiness.invalidate = () => invalidations++;
    await assert.rejects(
      client[method]([]),
      (err) => err.status === 503 && /channel unavailable/.test(err.message),
    );
    assert.equal(invalidations, 1);
    assert.equal(writes, 0);
  }
});
