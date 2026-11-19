const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

test('development launcher preserves cluster loading, decorator metadata and source locations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-dev-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'back'));
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.copyFileSync('back/tsconfig.json', path.join(root, 'back/tsconfig.json'));
  fs.writeFileSync(path.join(root, 'back/app.ts'), `
    import 'reflect-metadata';
    import cluster from 'node:cluster';
    class Dependency {}
    function decorated(target: Function) {}
    @decorated class Consumer { constructor(dependency: Dependency) {} }
    // Deliberate type error: development startup must skip type checking.
    const value: string = 42;
    if (cluster.isPrimary) {
      cluster.fork();
      cluster.on('exit', (_worker, code) => { process.exitCode = code; });
    } else {
      console.log('FIXTURE_RESULT=' + JSON.stringify({ value,
        metadata: Reflect.getMetadata('design:paramtypes', Consumer)[0] === Dependency,
        stack: new Error('source location').stack }));
      process.disconnect!();
    }
  `);
  const config = JSON.parse(fs.readFileSync('nodemon.json', 'utf8'));
  const [command, ...args] = config.execMap.ts.split(' ');
  assert.equal(command, 'node');
  const env = { ...process.env, ...config.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [...args, 'back/app.ts'], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout.split('FIXTURE_RESULT=')[1].split('\n')[0]);
  assert.equal(output.value, 42);
  assert.equal(output.metadata, true);
  assert.match(output.stack, /back[/\\]app\.ts:\d+:\d+/);
});

test('startup timing preserves results and failures with timing enabled or disabled', async (t) => {
  const loadModule = require('../helpers/load-security-module.cjs');
  const logs = [];
  const { startupStage } = loadModule('back/shared/startupTiming.ts', {
    '../loaders/logger': { info: (message) => logs.push(message) },
  });
  const original = process.env.QL_STARTUP_TIMING;
  const role = process.env.SERVICE_TYPE;
  t.after(() => {
    if (original === undefined) delete process.env.QL_STARTUP_TIMING;
    else process.env.QL_STARTUP_TIMING = original;
    if (role === undefined) delete process.env.SERVICE_TYPE;
    else process.env.SERVICE_TYPE = role;
  });
  process.env.SERVICE_TYPE = 'grpc';
  for (const enabled of ['0', '1']) {
    process.env.QL_STARTUP_TIMING = enabled;
    logs.length = 0;
    const value = {};
    const failure = new Error('startup failed');
    let calls = 0;
    assert.equal(await startupStage('success', async () => { calls++; return value; }), value);
    await assert.rejects(startupStage('failure', async () => { calls++; throw failure; }),
      (error) => error === failure);
    await assert.rejects(startupStage('sync-failure', () => { calls++; throw failure; }),
      (error) => error === failure);
    assert.equal(calls, 3);
    assert.equal(logs.length, enabled === '1' ? 3 : 0);
    if (enabled === '1') {
      for (const [index, stage] of ['success', 'failure', 'sync-failure'].entries()) {
        assert.match(logs[index], new RegExp('^\\[boot:timing\\] grpc:' + stage + ' \\d+ms \\(PID: \\d+\\)$'));
      }
    }
  }
});

test('frontend gzip assets are enabled for production only', () => {
  const source = ts.transpileModule(fs.readFileSync('.umirc.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const mode of ['development', 'production']) {
    const module = { exports: {} };
    class Compression { constructor(options) { this.options = options; } }
    new Function('require', 'module', 'exports', 'process', source)(
      (name) => name === '@umijs/max' ? { defineConfig: (config) => config } : Compression,
      module, module.exports, { env: { NODE_ENV: mode } },
    );
    const plugins = [];
    module.exports.default.chainWebpack({ plugin: (name) => ({ use: (plugin) => plugins.push({ name, plugin }) }) });
    assert.equal(plugins.length, mode === 'production' ? 1 : 0);
    if (mode === 'production') assert.equal(plugins[0].plugin.options.algorithm, 'gzip');
  }
});
