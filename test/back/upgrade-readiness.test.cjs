const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const load = require('../helpers/load-security-module.cjs');
const { SchedulerReadiness } = load('back/shared/schedulerReadiness.ts');
const { outputText } = ts.transpileModule(
  fs.readFileSync('back/bootstrap/upgradeProbe.ts', 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  },
);

// Run the real probe entry point, including its lifecycle and IPC reporting.
// Only external services and the clock are replaced; no test exports are needed.
async function runProbe({
  readiness,
  arch = 'x64',
  armVersion,
  supervised = true,
}) {
  let now = 0;
  const events = [],
    waits = [],
    messages = [];
  const build = { sourceCommit: 'a'.repeat(40) };
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const listener = { address: () => ({ port: 12345 }) };
  const server = {
    initialize: async () => {
      events.push('http');
      return listener;
    },
    shutdown: async () => {
      events.push('http-close');
    },
  };
  const grpc = {
    initialize: async () => {
      events.push('grpc');
      return 12346;
    },
    getServer: () => ({ forceShutdown: () => events.push('grpc-close') }),
  };
  class GrpcServerService {}
  class HttpServerService {}
  const modules = {
    'reflect-metadata': {},
    dns: { setDefaultResultOrder: () => {} },
    '../config': {},
    '../data': {
      database: {
        transaction: async (action) => action({}),
        query: async () => [{ value: 42 }],
        close: async () => {
          events.push('db-close');
        },
      },
    },
    '../loaders/db': async () => {
      events.push('db');
    },
    typedi: {
      Container: {
        get: (service) => (service === GrpcServerService ? grpc : server),
      },
    },
    '../services/grpc': { GrpcServerService },
    '../services/http': { HttpServerService },
    '../loaders/httpApplication': { createHttpApplication: async () => ({}) },
    '../loaders/server': async () => {},
    '../loaders/express': () => {},
    '../loaders/app': {},
    '../loaders/depInjector': () => {},
    '../schedule/client': {
      readiness: {
        configure: (restore) => readiness.configure(restore),
        recover: async () => {
          const ready = await readiness.recover();
          if (ready) events.push('ready');
          return ready;
        },
      },
    },
    http: {
      get: (url, respond) => {
        events.push('health');
        const request = new EventEmitter();
        request.setTimeout = () => {};
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          respond(response);
          response.emit(
            'data',
            JSON.stringify({
              code: 200,
              data: {
                status: 'ok',
                services: { grpc: true, http: true },
                build,
              },
            }),
          );
          response.emit('end');
        });
        return request;
      },
    },
  };
  vm.runInNewContext(
    outputText,
    {
      exports: {},
      require: (name) => {
        assert.ok(
          Object.hasOwn(modules, name),
          `Unexpected probe dependency: ${name}`,
        );
        return modules[name];
      },
      process: {
        env: { QL_UPGRADE_PROBE: supervised ? '1' : '0' },
        arch,
        config: { variables: { arm_version: armVersion } },
        pid: 123,
        once: () => {},
        memoryUsage: () => ({}),
        send: (message) => {
          messages.push(message);
          events.push('report');
        },
        exit: finish,
      },
      Date: { now: () => now },
      setTimeout: (callback, ms) => {
        assert.ok(ms > 0 && ms <= 250);
        waits.push(ms);
        now += ms;
        queueMicrotask(callback);
      },
      console: { error: () => {} },
    },
    { filename: 'upgradeProbe.js' },
  );
  const exitCode = await completed;
  return { exitCode, events, waits, messages, elapsed: now, build };
}

test('upgrade probe survives cold scheduler recovery before checking HTTP and reporting readiness', async () => {
  let attempts = 0,
    restored = false;
  const readiness = new SchedulerReadiness(async () => {
    if (++attempts < 3)
      throw new Error('Failed to connect before the deadline');
  });
  // The probe must configure and finish restoration before reporting readiness.
  const configure = readiness.configure.bind(readiness);
  readiness.configure = (restore) =>
    configure(async () => {
      await restore();
      restored = true;
    });
  const result = await runProbe({ readiness });
  assert.equal(result.exitCode, 0);
  assert.equal(restored, true);
  assert.equal(await readiness.check(), true);
  assert.deepEqual(result.waits, [250, 250]);
  assert.deepEqual(result.events, [
    'db',
    'grpc',
    'ready',
    'http',
    'health',
    'report',
    'http-close',
    'grpc-close',
    'db-close',
  ]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].ok, true);
  assert.equal(
    result.messages[0].build.sourceCommit,
    result.build.sourceCommit,
  );
});

for (const [arch, armVersion, timeout] of [
  ['x64', undefined, 10000],
  ['arm', 7, 10000],
  ['arm', '6', 60000],
]) {
  test(`unavailable ${arch}/v${armVersion} scheduler fails at its startup budget and cleans up`, async () => {
    let attempts = 0;
    const result = await runProbe({
      arch,
      armVersion,
      readiness: {
        configure: () => {},
        recover: async () => {
          attempts++;
          return false;
        },
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.elapsed, timeout);
    assert.equal(attempts, timeout / 250);
    assert.deepEqual(result.events, [
      'db',
      'grpc',
      'http-close',
      'grpc-close',
      'db-close',
      'report',
    ]);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].ok, false);
    assert.match(
      result.messages[0].message,
      /Upgrade scheduler readiness failed/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, timeout / 250, 'no retries after failure');
  });
}

test('unexpected scheduler recovery errors fail prestart without retries or a success report', async () => {
  let attempts = 0;
  const result = await runProbe({
    readiness: {
      configure: () => {},
      recover: async () => {
        attempts++;
        throw new Error('broken scheduler configuration');
      },
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.waits, []);
  assert.deepEqual(result.events, [
    'db',
    'grpc',
    'http-close',
    'grpc-close',
    'db-close',
    'report',
  ]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].ok, false);
  assert.match(result.messages[0].message, /broken scheduler configuration/);
});

test('an already ready scheduler reaches health without waiting', async () => {
  const result = await runProbe({
    readiness: { configure: () => {}, recover: async () => true },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.waits, []);
  assert.equal(result.messages[0].ok, true);
});

test('the upgrade probe still requires its isolated supervisor', async () => {
  const result = await runProbe({ supervised: false });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.events, ['report']);
  assert.match(result.messages[0].message, /requires its isolated supervisor/);
});
