const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

function load(file, mocks) {
  const required = [];
  const localRequire = createRequire(path.resolve(file));
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
  });
  new Function('require', 'module', 'exports', outputText)(name => {
    required.push(name);
    return Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name);
  }, module, module.exports);
  return { exports: module.exports, required };
}

function notificationFixture() {
  const messages = [], transports = [];
  const loaded = load('back/services/notify.ts', {
    typedi: { Service: () => x => x, Inject: () => () => {} },
    './user': {},
    '../config/util': {},
    '../shared/i18n': { t: x => x },
    '../config/http': { httpClient: { post: async () => ({ id: 1 }) } },
    undici: {},
    nodemailer: {
      createTransport(options) {
        // Exercise real message generation entirely in memory; no SMTP traffic.
        const transport = require('nodemailer').createTransport({ jsonTransport: true });
        const record = { options, closed: false };
        transports.push(record);
        return {
          async sendMail(message) {
            const info = await transport.sendMail(message);
            messages.push(JSON.parse(info.message));
            return info;
          },
          close() { record.closed = true; transport.close(); },
        };
      },
    },
  });
  return { service: new loaded.exports.default(), required: loaded.required, messages, transports };
}

test('non-email notifications do not load the SMTP dependency', async () => {
  const { service, required } = notificationFixture();
  assert.equal(required.includes('nodemailer'), false);
  assert.equal(await service.testNotify({ type: 'gotify', gotifyUrl: 'http://example.invalid', gotifyToken: 'test' }, 'title', 'body'), true);
  assert.equal(required.includes('nodemailer'), false);
});

test('first concurrent emails preserve their own recipients, credentials, subject and body across lazy loading', async () => {
  const f = notificationFixture();
  const results = await Promise.all([
    f.service.testNotify({ type: 'email', emailUser: 'a@example.invalid', emailPass: 'first', emailService: 'test-a', emailTo: 'one@example.invalid;two@example.invalid' }, 'first title', 'first\nbody'),
    f.service.testNotify({ type: 'email', emailUser: 'b@example.invalid', emailPass: 'second', emailService: 'test-b' }, 'second title', 'second\nbody'),
  ]);
  assert.deepEqual(results, [true, true]);
  assert.ok(f.required.includes('nodemailer'));
  const first = f.messages.find(x => x.subject === 'first title');
  const second = f.messages.find(x => x.subject === 'second title');
  assert.equal(first.html, 'first<br/>body');
  assert.deepEqual(first.to.map(x => x.address), ['one@example.invalid', 'two@example.invalid']);
  assert.equal(first.from.address, 'a@example.invalid');
  assert.equal(second.html, 'second<br/>body');
  assert.deepEqual(second.to.map(x => x.address), ['b@example.invalid']);
  assert.equal(second.from.address, 'b@example.invalid');
  assert.deepEqual(f.transports.map(x => x.options.auth), [
    { user: 'a@example.invalid', pass: 'first' },
    { user: 'b@example.invalid', pass: 'second' },
  ]);
  assert.ok(f.transports.every(x => x.closed));
});

test('gRPC loads the notification service only on demand and preserves results and callback errors', async () => {
  class EnvService {}
  class SystemService {}
  const payloads = [];
  const failure = new Error('notification unavailable');
  let fail = false;
  const loaded = load('back/schedule/api.ts', {
    typedi: { Container: {
      set() {},
      get(type) {
        if (type === EnvService) return { envs: async () => [] };
        assert.equal(type, SystemService);
        return { notify: async payload => {
          payloads.push(payload);
          if (fail) throw failure;
          return { code: 200, message: 'ok' };
        } };
      },
    } },
    '../services/env': EnvService,
    '../services/cron': {},
    '../services/system': SystemService,
    '../loaders/logger': {},
    sequelize: { Model: class Model {} },
  });
  assert.equal(loaded.required.includes('../services/system'), false);
  let envCalls = 0;
  await loaded.exports.getEnvs({ request: {} }, (error, data) => {
    envCalls++;
    assert.equal(error, null);
    assert.deepEqual(data, { code: 200, data: [] });
  });
  assert.equal(envCalls, 1);
  assert.equal(loaded.required.includes('../services/system'), false);
  const request = { title: 'title', content: 'body', notificationInfo: { type: -1 } };
  let callbacks = 0;
  await loaded.exports.systemNotify({ request }, (error, data) => {
    callbacks++;
    assert.equal(error, null);
    assert.deepEqual(data, { code: 200, message: 'ok' });
  });
  assert.equal(callbacks, 1);
  assert.deepEqual(payloads[0], request);
  assert.ok(loaded.required.includes('../services/system'));
  fail = true;
  await loaded.exports.systemNotify({ request }, (error, data) => {
    callbacks++;
    assert.equal(error, failure);
    assert.equal(data, undefined);
  });
  assert.equal(callbacks, 2);
});

test('task queues keep concurrency and repeated-task RPC alerts without constructing a local notification service', async () => {
  const alerts = [];
  const loaded = load('back/shared/pLimit.ts', {
    '../data/system': { AuthDataType: { systemConfig: 1 }, SystemModel: { sync: async () => {}, findOne: async () => null } },
    '../loaders/logger': { info() {}, warn() {}, error() {} },
    '../shared/i18n': { t: x => x, tf: x => x },
    '../config': { grpcPort: 5500 },
    '@grpc/grpc-js': { credentials: { createInsecure: () => ({}) } },
    '../config/grpcCerts': { getGrpcCerts: () => null },
    '../protos/api': { ApiClient: class {
      systemNotify(request, callback) { alerts.push(request); callback(null, { code: 200 }); }
    } },
    '../services/notify': class {
      constructor() { throw new Error('unused notification service constructed'); }
    },
  });
  const limit = loaded.exports.default;
  await limit.setCustomLimit(1);
  let release, active = 0, maximum = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const runs = Array.from({ length: 9 }, (_, i) => limit.runWithCronLimit({ id: 'same', name: 'test' }, async () => {
    maximum = Math.max(maximum, ++active);
    await pending;
    active--;
    return i;
  }));
  release();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4, undefined, undefined, undefined, undefined]);
  assert.equal(maximum, 1);
  assert.equal(alerts.length, 3);
  assert.ok(alerts.every(x => x.title === '任务重复运行'));
  assert.equal(loaded.required.includes('../services/notify'), false);
});
