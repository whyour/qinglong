const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const source = ts.createSourceFile(
  'app.ts',
  fs.readFileSync('back/app.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const application = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name.text === 'Application',
);
const method = application.members.find(
  (node) => node.name?.getText(source) === 'startMasterProcess',
);
const compiled = ts.transpileModule(
  `class Application { ${method.getText(
    source,
  )} }\nmodule.exports = Application;`,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  },
).outputText;

for (const [arch, armVersion, timeout] of [
  ['arm', 6, 120000],
  ['arm', 7, 30000],
  ['arm64', undefined, 30000],
]) {
  test(`${arch} v${
    armVersion ?? ''
  } waits for scheduler readiness before HTTP and job recovery`, async () => {
    const cluster = new EventEmitter();
    const module = { exports: {} };
    const logger = { info() {}, warn() {}, error() {} };
    new Function(
      'module',
      'cluster',
      'Logger',
      'errStack',
      'process',
      compiled,
    )(module, cluster, logger, String, {
      arch,
      config: { variables: { arm_version: armVersion } },
      exit() {
        assert.fail('unexpected application exit');
      },
    });
    const app = new module.exports();
    app.workerMetadataMap = new Map();
    const forks = [],
      waits = [],
      notifications = [];
    let ready;
    app.forkWorker = (serviceType) => {
      const worker = {
        id: forks.length + 1,
        process: { pid: 100 + forks.length },
        send: (message) => notifications.push(message),
      };
      forks.push({ serviceType, worker });
      app.workerMetadataMap.set(worker.id, { serviceType });
      return worker;
    };
    app.waitForWorkerReady = (worker, milliseconds) => {
      waits.push({ worker, milliseconds });
      return new Promise((resolve) => {
        ready = resolve;
      });
    };
    app.setupMasterShutdown = () => {};
    app.startMasterProcess();
    assert.deepEqual(
      forks.map((fork) => fork.serviceType),
      ['grpc'],
    );
    assert.equal(waits[0].milliseconds, timeout);
    ready();
    await Promise.resolve();
    assert.deepEqual(
      forks.map((fork) => fork.serviceType),
      ['grpc', 'http'],
    );
    cluster.emit('exit', forks[0].worker, 1);
    assert.equal(waits[1].milliseconds, timeout);
    assert.deepEqual(notifications, ['scheduler-unavailable']);
    ready();
    await Promise.resolve();
    assert.deepEqual(notifications, [
      'scheduler-unavailable',
      'reregister-crons',
    ]);
  });
}
