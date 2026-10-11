const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('back/app.ts', 'utf8');
const entry = source.indexOf('\nconst app = new Application();');
assert.ok(entry > 0, 'application entry point exists');
const compiled = ts.transpileModule(
  source.slice(0, entry) + '\nmodule.exports = Application;',
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;
function create(env) {
  const calls = [];
  const cluster = {
    fork(options) {
      const worker = {
        id: calls.length + 1,
        process: { pid: 100 + calls.length },
      };
      calls.push({ options, inherited: { ...env, ...options }, worker });
      return worker;
    },
  };
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    process: { env },
    require(name) {
      if (name === 'cluster') return cluster;
      if (name === 'express') return () => ({ use() {} });
      return {};
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return { app: new module.exports(), calls };
}
test('PM2-managed primary disables only inherited worker APM and keeps worker metadata', () => {
  const env = { pm_id: '0', pmx: 'true', CUSTOM_VALUE: 'kept' };
  const { app, calls } = create(env);
  for (const role of ['grpc', 'http']) app.forkWorker(role);
  assert.deepEqual(
    calls.map((x) => ({ ...x.options })),
    [
      { SERVICE_TYPE: 'grpc', pmx: 'false' },
      { SERVICE_TYPE: 'http', pmx: 'false' },
    ],
  );
  assert.equal(env.pmx, 'true');
  assert.equal(calls[0].inherited.CUSTOM_VALUE, 'kept');
  for (const call of calls) {
    const entry = app.workerMetadataMap.get(call.worker.id);
    assert.equal(entry.pid, call.worker.process.pid);
    assert.equal(entry.serviceType, call.options.SERVICE_TYPE);
  }
});
test('worker APM opt-in restores inherited PM2 settings, including explicit disable', () => {
  for (const pmx of ['true', 'false']) {
    const { app, calls } = create({ pm_id: '0', pmx, QL_WORKER_APM: 'true' });
    app.forkWorker('http');
    assert.equal(Object.hasOwn(calls[0].options, 'pmx'), false);
    assert.equal(calls[0].inherited.pmx, pmx);
  }
});
test('standalone startup does not introduce a PM2-specific override', () => {
  const { app, calls } = create({ CUSTOM_VALUE: 'kept' });
  app.forkWorker('grpc');
  assert.deepEqual({ ...calls[0].options }, { SERVICE_TYPE: 'grpc' });
  assert.equal(calls[0].inherited.CUSTOM_VALUE, 'kept');
});
test('replacement workers receive the same monitoring policy', () => {
  const { app, calls } = create({ pm_id: '0', pmx: 'true' });
  app.forkWorker('grpc');
  app.forkWorker('grpc');
  assert.equal(calls[1].inherited.pmx, 'false');
  assert.notEqual(calls[0].worker.id, calls[1].worker.id);
});
