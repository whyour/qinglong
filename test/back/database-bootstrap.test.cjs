const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Sequelize, QueryTypes } = require('sequelize');
const ts = require('typescript');
const { createRequire } = require('node:module');

const initializer = require.resolve('../../back/bootstrap/database');
const startup = require.resolve('../../back/shared/startupProcess');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data/db'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/syslog'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '');
  const wrapper = path.join(dir, 'parent.cjs');
  fs.writeFileSync(wrapper, `
    const cp = require('node:child_process');
    const original = cp.fork;
    cp.fork = (...args) => {
      const child = original(...args);
      process.send?.({ childPid: child.pid });
      return child;
    };
    const { runStartupProcess } = require(${JSON.stringify(startup)});
    runStartupProcess(process.argv[2]).then(() => {
      const modules = Object.keys(require.cache);
      process.send?.({ done: true, modules });
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    }).finally(() => { if (process.connected) process.disconnect(); });
  `);
  return {
    dir,
    storage: path.join(dir, 'data/db/database.sqlite'),
    run(entrypoint = initializer) {
      const child = fork(wrapper, [entrypoint], {
        env: { ...process.env, QL_DIR: dir, QL_DATA_DIR: path.join(dir, 'data') },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const messages = [];
      let output = '';
      child.on('message', (message) => messages.push(message));
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      const done = once(child, 'close').then(([code, signal]) => ({ code, signal, output, messages }));
      return { child, done, messages };
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for child');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('isolated initialization creates a fresh database and does not retain ORM modules in the parent', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const result = await f.run().done;
  assert.equal(result.code, 0, result.output);
  const done = result.messages.find(message => message.done);
  assert.ok(done);
  assert.equal(done.modules.some(file => /[\\/]sequelize[\\/]|[\\/]data[\\/]index\.ts$/.test(file)), false);
  const db = new Sequelize({ dialect: 'sqlite', storage: f.storage, logging: false });
  try {
    const tables = await db.getQueryInterface().showAllTables();
    for (const table of ['Crontabs', 'Envs', 'RunningInstances', 'SchemaMigrations']) assert.ok(tables.includes(table), table);
    assert.equal((await db.query('SELECT id FROM SchemaMigrations', { type: QueryTypes.SELECT })).length, 15);
  } finally { await db.close(); }
});

test('isolated initialization upgrades an existing database and remains idempotent', { timeout: 30000 }, async t => {
  const f = fixture(t);
  let db = new Sequelize({ dialect: 'sqlite', storage: f.storage, logging: false });
  await db.query('CREATE TABLE Crontabs (id INTEGER PRIMARY KEY, name TEXT)');
  await db.query("INSERT INTO Crontabs (id, name) VALUES (1, 'keep-me')");
  await db.close();
  for (let i = 0; i < 2; i++) {
    const result = await f.run().done;
    assert.equal(result.code, 0, result.output);
  }
  db = new Sequelize({ dialect: 'sqlite', storage: f.storage, logging: false });
  try {
    const rows = await db.query('SELECT * FROM Crontabs', { type: QueryTypes.SELECT });
    assert.equal(rows[0].name, 'keep-me');
    assert.ok(Object.hasOwn(rows[0], 'queued_token'));
    assert.equal((await db.query('SELECT id FROM SchemaMigrations', { type: QueryTypes.SELECT })).length, 15);
  } finally { await db.close(); }
});

test('database errors and missing initializer files reject startup', { timeout: 20000 }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.storage, 'invalid SQLite database');
  const invalid = await f.run().done;
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /SQLITE_NOTADB/);
  assert.equal(invalid.messages.some(message => message.done), false);
  const missing = await f.run(path.join(f.dir, 'missing.cjs')).done;
  assert.equal(missing.code, 1);
  assert.match(missing.output, /MODULE_NOT_FOUND/);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`startup ${signal} terminates the initializer and never reports success`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    const target = path.join(f.dir, 'waiting.cjs');
    const ready = path.join(f.dir, 'ready');
    fs.writeFileSync(target, `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const running = f.run(target);
    await waitFor(() => fs.existsSync(ready));
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(signal));
    assert.equal(result.messages.some(message => message.done), false);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('a database initializer blocked on SQLite exits when its parent disappears', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const db = new Sequelize({ dialect: 'sqlite', storage: f.storage, logging: false });
  await db.query('BEGIN EXCLUSIVE');
  try {
    const running = f.run();
    await waitFor(() => running.messages.some(message => message.childPid));
    const pid = running.messages.find(message => message.childPid).childPid;
    // Allow the real initializer to enter the database operation before losing IPC.
    await new Promise(resolve => setTimeout(resolve, 1000));
    running.child.kill('SIGKILL');
    await running.done;
    await waitFor(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
  } finally {
    await db.query('ROLLBACK');
    await db.close();
  }
});

test('application waits for isolated initialization and does not fork workers after a failure', async () => {
  const file = path.resolve('back/app.ts');
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source.slice(0, source.indexOf('\nconst app = new Application();')) + '\nmodule.exports = Application;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  for (const fail of [false, true]) {
    let complete;
    const pending = new Promise((resolve, reject) => { complete = () => fail ? reject(new Error('migration failed')) : resolve(); });
    const exits = [], calls = [];
    const localRequire = createRequire(file);
    const mocks = {
      cluster: { isPrimary: true },
      './config': {},
      './loaders/logger': { error() {} },
      './shared/startupProcess': { runStartupProcess: entry => { assert.equal(entry, initializer); return pending; } },
    };
    const req = Object.assign(name => {
      calls.push(name);
      return Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name);
    }, { resolve: localRequire.resolve });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'process', compiled)(req, module, module.exports, { exit: code => exits.push(code) });
    const app = new module.exports();
    let started = false;
    app.startMasterProcess = () => { started = true; };
    const start = app.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, false);
    complete();
    await start;
    assert.equal(started, !fail);
    assert.deepEqual(exits, fail ? [1] : []);
    assert.equal(calls.includes('./loaders/db'), false);
  }
});
