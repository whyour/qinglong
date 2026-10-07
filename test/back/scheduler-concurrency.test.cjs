const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const load = require('../helpers/load-security-module.cjs');
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const tick = () => new Promise(setImmediate);
function createLimit() {
  return load('back/shared/pLimit.ts', {
    '../data/system': {
      AuthDataType: { systemConfig: 'systemConfig' },
      SystemModel: {
        sync: async () => {},
        findOne: async () => ({ info: { cronConcurrency: 1 } }),
      },
    },
    '../loaders/logger': logger,
    '../services/notify': class {},
    '../shared/i18n': { t: (x) => x, tf: (x) => x },
    '../config': {},
    '../config/grpcCerts': { getGrpcCerts: () => null },
    '../protos/api': {},
  }).default;
}
function createSystem(client, limit, options = {}) {
  const store = options.store || {
    state: {
      id: 1,
      type: 'systemConfig',
      info: { cronConcurrency: 1, timezone: 'Asia/Shanghai' },
    },
  };
  const writes = [];
  const Service = load('back/services/system.ts', {
    '../config': options.config || {},
    '../shared/schedulerMutationLock': options.config
      ? load('back/shared/schedulerMutationLock.ts', {
          '../config': options.config,
        })
      : { withSchedulerMutation: (operation) => operation() },
    '../config/const': {},
    '../config/util': {},
    '../data/dependence': {},
    '../data/notify': {},
    '../data/system': {
      AuthDataType: { systemConfig: 'systemConfig' },
      SystemModel: {
        findOne: async () => ({
          ...store.state,
          get: () => ({ ...store.state }),
        }),
        update: async (values) => {
          writes.push(values);
          store.state = { ...store.state, ...values };
        },
      },
    },
    '../shared/pLimit': limit,
    '../schedule/client': client,
    '../shared/i18n': { t: (x) => x },
    './notify': class {},
    './schedule': class {},
    './sock': class {},
  }).default;
  return {
    service: new Service(logger, {}, {}),
    writes,
    state: () => store.state,
  };
}
async function rpcFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-concurrency-rpc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const certs = await load('back/config/grpcCerts.ts', {
    './index': { configPath: root },
    './util': { fileExist: async (p) => fs.existsSync(p) },
    '../loaders/logger': logger,
  }).initGrpcCerts();
  const schedulerLimit = createLimit(),
    apiLimit = createLimit();
  await tick();
  const handler = load('back/schedule/setConcurrency.ts', {
    '../shared/pLimit': schedulerLimit,
  });
  let port;
  const Grpc = load('back/services/grpc.ts', {
    '../config': { bindHostGrpc: '127.0.0.1', grpcPort: 0 },
    '../config/grpcCerts': { initGrpcCerts: async () => certs },
    '../loaders/logger': logger,
    './metrics': { metricsService: { record() {} } },
    '../schedule/addCron': {},
    '../schedule/delCron': {},
    '../schedule/api': {},
    '../schedule/health': { check: (_call, cb) => cb(null, { status: 1 }) },
    '../schedule/setConcurrency': handler,
    '@grpc/grpc-js': {
      ...grpc,
      Server: class extends grpc.Server {
        bindAsync(address, creds, cb) {
          super.bindAsync(address, creds, (error, boundPort) => {
            port = boundPort;
            cb(error, boundPort);
          });
        }
      },
    },
  }).GrpcServerService;
  const server = new Grpc();
  await server.initialize();
  const client = load('back/schedule/client.ts', {
    '../config': { grpcPort: port },
    '../config/grpcCerts': { getGrpcCerts: () => certs },
  }).default;
  t.after(async () => {
    client._client?.close();
    await server.shutdown();
  });
  return {
    ...createSystem(client, apiLimit),
    schedulerLimit,
    apiLimit,
    client,
  };
}
function enqueue(t, limit, count) {
  const releases = [],
    runs = [];
  for (let i = 0; i < count; i++) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    runs.push(limit.runWithCronLimit({ id: String(i) }, () => gate));
  }
  t.after(async () => {
    releases.forEach((release) => release());
    await Promise.all(runs);
  });
  return { releases, runs };
}

test('concurrency changes reach the independent scheduler queue over mTLS immediately and preserve running jobs', async (t) => {
  const f = await rpcFixture(t);
  const { releases, runs } = enqueue(t, f.schedulerLimit, 3);
  await tick();
  assert.equal(f.schedulerLimit.cronLimitActiveCount, 1);
  assert.equal(f.schedulerLimit.cronLimitPendingCount, 2);
  assert.equal(
    (await f.service.updateCronConcurrency({ cronConcurrency: 2 })).code,
    200,
  );
  await tick();
  assert.equal(f.schedulerLimit.cronLimitActiveCount, 2);
  assert.equal(f.schedulerLimit.cronLimitPendingCount, 1);
  await f.service.updateCronConcurrency({ cronConcurrency: 1 });
  assert.equal(
    f.schedulerLimit.cronLimitActiveCount,
    2,
    'lowering the limit must not stop active jobs',
  );
  releases[0]();
  await runs[0];
  await tick();
  assert.equal(f.schedulerLimit.cronLimitActiveCount, 1);
  assert.equal(f.schedulerLimit.cronLimitPendingCount, 1);
  releases[1]();
  await runs[1];
  await tick();
  assert.equal(f.schedulerLimit.cronLimitActiveCount, 1);
  assert.equal(f.schedulerLimit.cronLimitPendingCount, 0);
  releases[2]();
  await runs[2];
  assert.equal(f.state().info.cronConcurrency, 1);
});

test('zero, null and omitted concurrency restore the default in both API and scheduler queues without a restart', async (t) => {
  const f = await rpcFixture(t);
  for (const value of [0, null, undefined]) {
    await f.service.updateCronConcurrency({ cronConcurrency: 1 });
    const scheduler = enqueue(t, f.schedulerLimit, 4),
      manual = enqueue(t, f.apiLimit, 4);
    await tick();
    assert.equal(f.schedulerLimit.cronLimitActiveCount, 1);
    assert.equal(f.apiLimit.cronLimitActiveCount, 1);
    await f.service.updateCronConcurrency(
      value === undefined ? {} : { cronConcurrency: value },
    );
    await tick();
    assert.equal(
      f.state().info.cronConcurrency,
      0,
      'persist the same default that both queues apply',
    );
    assert.equal(f.schedulerLimit.cronLimitActiveCount, 4);
    assert.equal(f.apiLimit.cronLimitActiveCount, 4);
    [...scheduler.releases, ...manual.releases].forEach((release) => release());
    await Promise.all([...scheduler.runs, ...manual.runs]);
  }
});

test('invalid concurrency is rejected before configuration writes or queue changes', async () => {
  const mutations = [];
  const f = createSystem(
    { setConcurrency: async (value) => mutations.push(value) },
    { setCustomLimit: async (value) => mutations.push(value) },
  );
  for (const value of [-1, 1.5, NaN, Infinity, 2147483648])
    await assert.rejects(
      f.service.updateCronConcurrency({ cronConcurrency: value }),
      { status: 400 },
    );
  assert.deepEqual(f.writes, []);
  assert.deepEqual(mutations, []);
  const handler = load('back/schedule/setConcurrency.ts', {
    '../shared/pLimit': {
      setCustomLimit: async (value) => mutations.push(value),
    },
  }).setConcurrency;
  for (const value of [-1, 0.5, 2147483648])
    await handler({ request: { concurrency: value } }, (error) =>
      assert.equal(error.code, grpc.status.INVALID_ARGUMENT),
    );
  assert.deepEqual(mutations, []);
});

for (const code of [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]) {
  test(`concurrency RPC failure ${code} invalidates readiness and is not reported as success or retried`, async () => {
    let writes = 0,
      invalidations = 0;
    const fake = {
      waitForReady: (_deadline, callback) => callback(),
      setConcurrency: (_request, _metadata, options, callback) => {
        assert.ok(options.deadline > Date.now());
        writes++;
        callback(Object.assign(new Error('scheduler unavailable'), { code }));
      },
    };
    const client = load('back/schedule/client.ts', {
      '../protos/cron': {
        CronClient: class {
          constructor() {
            return fake;
          }
        },
      },
      '../config': { grpcPort: 1 },
      '../config/grpcCerts': {
        getGrpcCerts: () => ({
          caCert: 'ca',
          clientKey: 'key',
          clientCert: 'cert',
        }),
      },
      '@grpc/grpc-js': { ...grpc, credentials: { createSsl: () => ({}) } },
    }).default;
    client.readiness.invalidate = () => invalidations++;
    const f = createSystem(client, { setCustomLimit: async () => {} });
    await assert.rejects(
      f.service.updateCronConcurrency({ cronConcurrency: 2 }),
      { status: 503 },
    );
    assert.equal(writes, 1);
    assert.equal(invalidations, 1);
  });
}

function mutationConfig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-concurrency-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { crontabFile: path.join(root, 'crontab.list') };
}

test('independent API service instances serialize database and scheduler updates with the shared filesystem lock', async (t) => {
  const config = mutationConfig(t);
  const store = { state: { id: 1, info: { cronConcurrency: 1 } } };
  let release, entered;
  const firstEntered = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  let scheduler = 1,
    api = 1;
  const client = {
    setConcurrency: async (value) => {
      if (value === 10) {
        entered();
        await gate;
      }
      scheduler = value;
    },
  };
  const limit = { setCustomLimit: async (value) => (api = value) };
  const a = createSystem(client, limit, { config, store });
  const b = createSystem(client, limit, { config, store });
  const first = a.service.updateCronConcurrency({ cronConcurrency: 10 });
  await firstEntered;
  const second = b.service.updateCronConcurrency({ cronConcurrency: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    b.writes.length,
    0,
    'a second writer cannot persist ahead of the first RPC',
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    [store.state.info.cronConcurrency, api, scheduler],
    [1, 1, 1],
  );
});

for (const newerLimit of [undefined, 2]) {
  test(`production recovery restores persisted concurrency before health becomes ready (newer limit: ${newerLimit})`, async (t) => {
    const config = mutationConfig(t);
    const store = { state: { id: 1, info: { cronConcurrency: 1 } } };
    let scheduler = 1,
      api = 1,
      fail = false,
      restoreJobs = 0;
    let unblockRecovery, recoveryEntered;
    const entered = new Promise((resolve) => (recoveryEntered = resolve));
    const gate = new Promise((resolve) => (unblockRecovery = resolve));
    t.after(() => unblockRecovery());
    const fake = {
      waitForReady: (_deadline, callback) => callback(),
      makeUnaryRequest: (...args) => args.at(-1)(null, { status: 1 }),
      setConcurrency: ({ concurrency }, _metadata, _options, callback) => {
        if (fail) {
          fail = false;
          callback(
            Object.assign(new Error('lost RPC'), {
              code: grpc.status.UNAVAILABLE,
            }),
          );
        } else {
          scheduler = concurrency;
          callback(null, {});
        }
      },
    };
    const client = load('back/schedule/client.ts', {
      '../protos/cron': {
        CronClient: class {
          constructor() {
            return fake;
          }
        },
      },
      '../config': { grpcPort: 1 },
      '../config/grpcCerts': {
        getGrpcCerts: () => ({
          caCert: 'ca',
          clientKey: 'key',
          clientCert: 'cert',
        }),
      },
      '@grpc/grpc-js': { ...grpc, credentials: { createSsl: () => ({}) } },
    }).default;
    const f = createSystem(
      client,
      { setCustomLimit: async (value) => (api = value) },
      { config, store },
    );
    const source = fs.readFileSync('back/loaders/initData.ts', 'utf8');
    const callback = source.match(
      /cronClient\.readiness\.configure\((async \(\) => \{[\s\S]*?\n  \})\);/,
    )[1];
    const restore = new Function(
      'cronService',
      'systemService',
      `return ${callback}`,
    )(
      {
        autosave_crontab: async (strict) => {
          assert.equal(strict, true);
          restoreJobs++;
          if (restoreJobs > 1) {
            recoveryEntered();
            await gate;
          }
        },
      },
      f.service,
    );
    client.readiness.configure(restore);
    assert.equal(await client.readiness.recover(), true);
    fail = true;
    await assert.rejects(
      f.service.updateCronConcurrency({ cronConcurrency: 10 }),
      { status: 503 },
    );
    await entered;
    assert.equal(await client.readiness.check(), false);
    assert.equal(scheduler, 1);
    // A newer successful request must win over the failed request being recovered.
    if (newerLimit !== undefined)
      await f.service.updateCronConcurrency({ cronConcurrency: newerLimit });
    scheduler = 1; // Simulate the scheduler restarting while recovery is in progress.
    const recovered = client.readiness.recover();
    unblockRecovery();
    assert.equal(await recovered, true);
    const expected = newerLimit ?? 10;
    assert.deepEqual(
      [store.state.info.cronConcurrency, api, scheduler],
      [expected, expected, expected],
    );
    assert.equal(await client.readiness.check(), true);
  });
}
