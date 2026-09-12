const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const load = require('../helpers/load-security-module.cjs');
const { SchedulerReadiness } = require('../../back/shared/schedulerReadiness');
const { AddCronRequest } = require('../../back/protos/cron');

function fixture(client) {
  const source = fs.readFileSync('back/services/cron.ts', 'utf8');
  const a = source.indexOf('  public async autosave_crontab(');
  const z = source.indexOf('  public async bootTask', a);
  const js = ts.transpileModule(
    'class Fixture {\n' + source.slice(a, z) + '}\nmodule.exports=Fixture;',
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const module = { exports: {} };
  new Function('module', 'isDemoEnv', 'cronClient', 'withSchedulerMutation', js)(
    module,
    () => false,
    client,
    (fn) => fn(),
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
            crons: [{ id: 'bad', schedule: '?', extra_schedules: [] }],
          },
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    ),
  );
  assert.deepEqual([...stacks.keys()], ['old']);
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
