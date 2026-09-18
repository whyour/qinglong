const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync('back/app.ts', 'utf8');
const compiled = ts.transpileModule(
  source.slice(0, source.indexOf('\nconst app = new Application();')) +
    '\nmodule.exports = Application;',
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  },
).outputText;

function fixture() {
  const required = [],
    listeners = new Map();
  let invalidations = 0;
  const module = { exports: {} };
  const localRequire = createRequire(path.resolve('back/app.ts'));
  const mocks = {
    './config': { cors: { origin: ['http://localhost'] } },
    './loaders/logger': { error() {}, warn() {}, info() {} },
    './middlewares/monitoring': {
      monitoringMiddleware: (_req, _res, next) => next(),
    },
    './schedule/client': {
      default: { readiness: { invalidate: () => invalidations++ } },
      __esModule: true,
    },
  };
  new Function('require', 'module', 'exports', 'process', compiled)(
    (name) => {
      required.push(name);
      return Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name);
    },
    module,
    module.exports,
    { env: {}, on: (name, fn) => listeners.set(name, fn) },
  );
  return {
    app: new module.exports(),
    required,
    listeners,
    invalidations: () => invalidations,
  };
}

test('primary construction does not load HTTP middleware, metrics or the gRPC client', () => {
  const { required } = fixture();
  for (const name of [
    'express',
    'helmet',
    'cors',
    'compression',
    './middlewares/monitoring',
    './schedule/client',
    './config/util',
  ]) {
    assert.equal(required.includes(name), false, name);
  }
});

test('lazy HTTP initialization preserves query filtering, security headers, CORS and compression', async (t) => {
  const { app, required } = fixture();
  const http = await app.setupMiddlewares();
  http.get('/test', (req, res) =>
    res.json({ query: req.query, data: 'x'.repeat(2048) }),
  );
  const server = await new Promise((resolve) => {
    const server = http.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/test?t=123&keep=yes`,
    {
      headers: { Origin: 'http://localhost', 'Accept-Encoding': 'gzip' },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'http://localhost',
  );
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.deepEqual((await response.json()).query, { keep: 'yes' });
  assert.ok(required.includes('express'));
  assert.equal(required.includes('./schedule/client'), false);
});

test('worker recovery messages still invalidate HTTP readiness, but gRPC shutdown setup does not load its client', async () => {
  const grpc = fixture();
  grpc.app.setupWorkerShutdown('grpc');
  await grpc.listeners.get('message')('scheduler-unavailable');
  assert.equal(grpc.required.includes('./schedule/client'), false);
  const http = fixture();
  http.app.setupWorkerShutdown('http');
  await http.listeners.get('message')('scheduler-unavailable');
  await http.listeners.get('message')('reregister-crons');
  assert.equal(http.invalidations(), 2);
  const shutdowns = [];
  http.app.gracefulShutdown = (role) => shutdowns.push(role);
  await http.listeners.get('message')('shutdown');
  http.listeners.get('SIGTERM')();
  assert.deepEqual(shutdowns, ['http', 'http']);
});
