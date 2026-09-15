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
