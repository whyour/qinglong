const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseClient } = require('../../back/data/databaseClient');
const { Repository } = require('../../back/data/repository');
const { initialSchema } = require('../../back/data/schema');
const { migrateSchema } = require('../../back/shared/schemaMigrations');

test('requests buffered before bootstrap and during owner-monitor startup retain their order', async (t) => {
  const { fork } = require('node:child_process');
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-db-bootstrap-queue-'),
  );
  const script = path.join(directory, 'delayed.ts');
  await fs.writeFile(
    script,
    `setTimeout(()=>require(${JSON.stringify(
      require.resolve('../../back/data/databaseProcess'),
    )}),100)`,
  );
  const child = fork(script, [], {
    execArgv: [
      '--require',
      require.resolve('ts-node/register/transpile-only'),
      '--max-old-space-size=128',
    ],
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.resolve('back/data/tsconfig.worker.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await stopped;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const responses = new Promise((resolve, reject) => {
    const replies = [];
    const timer = setTimeout(
      () => reject(new Error('Buffered startup requests were lost')),
      30000,
    );
    child.on('message', (reply) => {
      if (reply.error) {
        clearTimeout(timer);
        reject(new Error(reply.error.message));
        return;
      }
      replies.push(reply);
      if (replies.length === 2) {
        clearTimeout(timer);
        resolve(replies);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Database exited during bootstrap: ' + stderr));
    });
    child.once('error', reject);
  });
  child.send({ storage: ':memory:', ownerPid: process.pid });
  child.send({ id: 1, operation: 'query', args: ['SELECT 42 AS value'] });
  child.send({ id: 2, operation: 'query', args: ['SELECT 43 AS value'] });
  assert.deepEqual(await responses, [
    { id: 1, value: [{ value: 42 }] },
    { id: 2, value: [{ value: 43 }] },
  ]);
});

test('killing the owner during synchronous SQL releases the write lock and rolls back before restart', async (t) => {
  const { fork } = require('node:child_process');
  const { DatabaseSync } = require('node:sqlite');
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-db-owner-exit-'),
  );
  const file = path.join(directory, 'data.sqlite');
  const script = path.join(directory, 'owner.cjs');
  await fs.writeFile(
    script,
    `
    const {DatabaseClient}=require(${JSON.stringify(
      require.resolve('../../back/data/databaseClient'),
    )});
    const db=new DatabaseClient(process.argv[2]);
    (async()=>{
      await db.query('CREATE TABLE probe(value INTEGER)');
      await db.query('INSERT INTO probe VALUES(1)');
      await db.transaction(async()=>{
        await db.query('UPDATE probe SET value=2');
        const running=db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000000000) SELECT SUM(x) FROM n');
        setTimeout(()=>process.send({databasePid:db.worker.pid}),300);
        await running;
      });
    })().catch(error=>{console.error(error);process.exitCode=1});
  `,
  );
  const owner = fork(script, [file], {
    execArgv: ['--require', require.resolve('ts-node/register/transpile-only')],
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.resolve('back/tsconfig.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = new Promise((resolve) => owner.once('exit', resolve));
  let databasePid,
    probe,
    stderr = '',
    unlocked = false;
  owner.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    probe?.close();
    owner.kill('SIGKILL');
    await exited;
    if (databasePid && !unlocked) {
      try {
        process.kill(databasePid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  databasePid = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Owner startup timed out: ' + stderr)),
      30000,
    );
    owner.once('message', (message) => {
      clearTimeout(timer);
      resolve(message.databasePid);
    });
    owner.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Owner exited before SQL: ' + stderr));
    });
    owner.once('error', reject);
  });
  probe = new DatabaseSync(file);
  probe.exec('PRAGMA busy_timeout=50');
  assert.throws(() => probe.exec('BEGIN IMMEDIATE'), /locked/);
  owner.kill('SIGKILL');
  await exited;
  const deadline = Date.now() + 5000;
  do {
    try {
      probe.exec('BEGIN IMMEDIATE;ROLLBACK');
      unlocked = true;
      break;
    } catch (error) {
      if (!/locked/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(
    unlocked,
    true,
    'The orphan database process still blocks the old service',
  );
  assert.equal(probe.prepare('SELECT value FROM probe').get().value, 1);
});

async function fixture(t, file = ':memory:') {
  const db = new DatabaseClient(file);
  t.after(() => db.close());
  await db.transaction(async () => {
    for (const sql of initialSchema) await db.query(sql);
    await migrateSchema(db);
  });
  return {
    db,
    env: new Repository('Env', () => db),
    auth: new Repository('Auth', () => db),
  };
}

test('direct ts-node CLI startup registers the isolated database worker compiler', async () => {
  const execute = require('node:util').promisify(
    require('node:child_process').execFile,
  );
  const result = await execute(
    process.execPath,
    [
      path.resolve('node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      '--project',
      'back/tsconfig.json',
      '-e',
      `const {DatabaseClient}=require('./back/data/databaseClient');const db=new DatabaseClient(':memory:');db.query('SELECT 42 AS value').then(async rows=>{console.log(JSON.stringify(rows));await db.close()}).catch(async error=>{console.error(error);process.exitCode=1;await db.close().catch(()=>{})})`,
    ],
    { cwd: path.resolve('.'), timeout: 30000 },
  );
  assert.deepEqual(JSON.parse(result.stdout), [{ value: 42 }]);
});

test('worker round-trips legacy field names, JSON, dates, null and precise positions', async (t) => {
  const { db, env } = await fixture(t);
  const row = await env.insert({
    name: '中文',
    value: 'keep',
    position: 4500000000000000,
    labels: ['old', '中文'],
    remarks: null,
  });
  assert.deepEqual((await env.findOne({ id: row.id })).labels, row.labels);
  assert.equal(row.position, 4500000000000000);
  assert.equal(row.remarks, null);
  assert(row.createdAt instanceof Date);
  const stored = (
    await db.query('SELECT typeof(createdAt) AS type,createdAt FROM Envs')
  )[0];
  assert.equal(stored.type, 'text');
  assert.match(
    stored.createdAt,
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \+00:00$/,
  );
  assert.equal(
    (await db.query('SELECT count(*) AS n FROM SchemaMigrations'))[0].n,
    15,
  );
});

test('JSON LIKE uses serialized text without quoting the pattern', async (t) => {
  const { env } = await fixture(t);
  await env.insert({ name: 'a', value: 'b', labels: ['中文', 'old'] });
  assert.equal((await env.find({ labels: { $like: '%old%' } })).length, 1);
  assert.equal(
    (await env.find({ $not: { labels: { $like: '%old%' } } })).length,
    0,
  );
});

test('transaction commit, failure and nested savepoints preserve ownership', async (t) => {
  const { db, env } = await fixture(t);
  await env.insert({ name: 'a', value: 'old' });
  await db.transaction(async () => {
    await env.nativeUpdate({ name: 'a' }, { value: 'committed' });
    await assert.rejects(
      db.transaction(async () => {
        await env.nativeUpdate({ name: 'a' }, { value: 'rollback' });
        throw Error('injected');
      }),
      /injected/,
    );
    assert.equal((await env.findOne({ name: 'a' })).value, 'committed');
  });
  await assert.rejects(
    db.transaction(async () => {
      await env.nativeUpdate({ name: 'a' }, { value: 'rollback all' });
      throw Error('outer failure');
    }),
    /outer failure/,
  );
  assert.equal((await env.findOne({ name: 'a' })).value, 'committed');
});

test('unrelated reads wait for rollback and cannot see uncommitted data', async (t) => {
  const { db, env } = await fixture(t);
  await env.insert({ name: 'a', value: 'old' });
  let release, writing;
  const started = new Promise((r) => {
    writing = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const transaction = db.transaction(async () => {
    await env.nativeUpdate({ name: 'a' }, { value: 'uncommitted' });
    writing();
    await gate;
    throw Error('rollback');
  });
  const rejected = assert.rejects(transaction, /rollback/);
  await started;
  const read = env.findOne({ name: 'a' });
  release();
  await rejected;
  assert.equal((await read).value, 'old');
});

test('expired async transaction scopes cannot write after commit', async (t) => {
  const { db, env } = await fixture(t);
  // Capture an asynchronous resource inside the scope, then release it afterwards.
  let release, result;
  const gate = new Promise((r) => {
    release = r;
  });
  await db.transaction(async () => {
    result = gate.then(() => env.insert({ name: 'late' }));
  });
  const rejected = assert.rejects(result, { code: 'TRANSACTION_SCOPE' });
  release();
  await rejected;
  assert.equal(await env.count(), 0);
});

test('conditional updates keep compare-and-swap counts and do not clear undefined data', async (t) => {
  const { env } = await fixture(t);
  const row = await env.insert({ name: 'a', value: 'old' });
  assert.equal(
    await env.nativeUpdate({ id: row.id, value: 'newer' }, { value: 'bad' }),
    0,
  );
  assert.equal(
    await env.nativeUpdate(
      { id: row.id, value: 'old' },
      { value: 'new', remarks: undefined },
    ),
    1,
  );
  assert.equal((await env.findOne({ id: row.id })).value, 'new');
  await assert.rejects(env.nativeUpdate({ id: undefined }, { value: 'bad' }));
});

test('missing predicates cannot become unrestricted writes or disappear inside an IN filter', async (t) => {
  const { env } = await fixture(t);
  const row = await env.insert({ name: 'retained', value: 'old' });
  for (const where of [undefined, null, { id: { $in: [row.id, undefined] } }]) {
    await assert.rejects(env.nativeUpdate(where, { value: 'must not write' }));
    await assert.rejects(env.nativeDelete(where));
  }
  assert.equal(await env.count(), 1);
  assert.equal((await env.findOne({ id: row.id })).value, 'old');
});

test('worker failures reject writes, never replay them, and roll back SQLite', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-db-worker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'database.sqlite');
  const { db, env } = await fixture(t, file);
  await env.insert({ name: 'a', value: 'old' });
  await assert.rejects(
    db.transaction(async () => {
      await env.nativeUpdate({ name: 'a' }, { value: 'uncommitted' });
      db.worker.kill('SIGKILL');
      await db.stopped;
      await env.count();
    }),
  );
  assert.equal(db.healthy, false);
  await assert.rejects(env.insert({ name: 'replayed' }));
  const reopened = new DatabaseClient(file);
  t.after(() => reopened.close());
  const records = new Repository('Env', () => reopened);
  assert.equal((await records.findOne({ name: 'a' })).value, 'old');
  assert.equal(await records.count(), 1);
});

test('a long database query leaves main-thread timers responsive', async (t) => {
  const { db } = await fixture(t);
  const started = performance.now();
  const expensive = db.query(
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT SUM(x) AS n FROM n',
  );
  const timer = await new Promise((r) =>
    setTimeout(() => r(performance.now() - started), 10),
  );
  assert(timer < 150, `main-thread timer delayed ${timer}ms`);
  assert.equal((await expensive)[0].n, 2000001000000);
});

test('existing Keyv authentication cache stays byte-compatible with legacy readers', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const Keyv = require('keyv').default;
  const { CacheStore } = require('../../back/data/cacheStore');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-cache-compat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'keyv.sqlite');
  const old = new DatabaseSync(cacheFile);
  old.exec('CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY,value TEXT)');
  const value = {
    username: 'synthetic-user',
    password: 'synthetic-hash',
    tokens: { desktop: ['keep'] },
  };
  old
    .prepare('INSERT INTO keyv VALUES(?,?)')
    .run('keyv:authInfo', JSON.stringify({ value, expires: null }));
  old.close();
  const db = new DatabaseClient(':memory:', cacheFile);
  t.after(() => db.close());
  const cache = new Keyv({ store: new CacheStore(() => db) });
  assert.deepEqual(await cache.get('authInfo'), value);
  const next = { ...value, username: 'new-synthetic-user' };
  await cache.set('authInfo', next);
  const legacy = new DatabaseSync(cacheFile, { readOnly: true });
  try {
    assert.deepEqual(
      JSON.parse(
        legacy
          .prepare('SELECT value FROM keyv WHERE key=?')
          .get('keyv:authInfo').value,
      ).value,
      next,
    );
  } finally {
    legacy.close();
  }
});

test('optional DTO fields and nested JSON values may be undefined on insert', async (t) => {
  const { env, auth } = await fixture(t);
  const created = await env.insert({
    name: 'optional',
    value: 'keep',
    id: undefined,
    remarks: undefined,
  });
  assert.equal(created.value, 'keep');
  const row = await auth.insert({
    type: 'notifyLog',
    info: { title: 'keep', taskId: undefined },
  });
  assert.deepEqual(row.info, { title: 'keep' });
});

test('legacy null pin flags sort like zero flags before comparing positions', async (t) => {
  const { env } = await fixture(t);
  await env.insert({ name: 'null', position: 20, isPinned: null });
  await env.insert({ name: 'zero', position: 10, isPinned: 0 });
  await env.insert({ name: 'pinned', position: 1, isPinned: 1 });
  assert.deepEqual(
    (
      await env.find(
        {},
        { orderBy: [{ isPinned: 'desc' }, { position: 'desc' }] },
      )
    ).map((x) => x.name),
    ['pinned', 'null', 'zero'],
  );
});

test('a stalled transaction callback times out and rolls back before unrelated reads', async (t) => {
  const { db, env } = await fixture(t);
  db.timeoutMs = 100;
  await env.insert({ name: 'a', value: 'old' });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  await assert.rejects(
    db.transaction(async () => {
      await env.nativeUpdate({ name: 'a' }, { value: 'uncommitted' });
      await gate;
      await env.insert({ name: 'too-late' });
    }),
    { code: 'DATABASE_TRANSACTION_TIMEOUT' },
  );
  release();
  assert.equal((await env.findOne({ name: 'a' })).value, 'old');
  assert.equal(await env.count(), 1);
  assert.equal(db.healthy, true);
});

test('a stuck database worker is terminated, rejects its queue and never replays writes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-db-timeout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'database.sqlite');
  const { db, env } = await fixture(t, file);
  await env.insert({ name: 'a', value: 'old' });
  db.timeoutMs = 100;
  await assert.rejects(
    db.transaction(async () => {
      await env.nativeUpdate({ name: 'a' }, { value: 'uncommitted' });
      await db.query(
        'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000000) SELECT SUM(x) FROM n',
      );
    }),
    (e) =>
      ['DATABASE_TRANSACTION_TIMEOUT', 'DATABASE_WORKER_TIMEOUT'].includes(
        e.code,
      ),
  );
  assert.equal(db.healthy, false);
  await assert.rejects(env.insert({ name: 'replayed' }));
  await db.close();
  const next = new DatabaseClient(file);
  t.after(() => next.close());
  const records = new Repository('Env', () => next);
  assert.equal((await records.findOne({ name: 'a' })).value, 'old');
  assert.equal(await records.count(), 1);
});

test('the database queue is bounded while a transaction owns its connection', async (t) => {
  const { db, env } = await fixture(t);
  db.queueLimit = 2;
  db.timeoutMs = 3000;
  let entered, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const transaction = db.transaction(async () => {
    entered();
    await gate;
  });
  await started;
  const waiting = env.count();
  await assert.rejects(env.count(), { code: 'DATABASE_BUSY' });
  release();
  await transaction;
  assert.equal(await waiting, 0);
});
