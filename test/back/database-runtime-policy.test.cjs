const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { spawnSync } = require('node:child_process');
const { minimum, assertNodeRuntime } = require('../../shell/runtime-guard.cjs');
const { databaseStartupFailure } = require('../../back/data/databaseErrors');
const {
  dependencyFailure,
} = require('../../cli/src/internal/maintenance/upgradePrestart.cjs');

test('runtime policy matches package metadata and accepts the exact Node minimum', () => {
  assert.equal(minimum, require('../../package.json').qinglongRuntimeMinimum);
  for (const version of ['22.17.0', '22.23.2', '24.18.1', '26.0.0'])
    assert.doesNotThrow(() => assertNodeRuntime(version));
  for (const version of ['20.20.2', '22.16.9', 'invalid'])
    assert.throws(() => assertNodeRuntime(version), {
      code: 'UNSUPPORTED_NODE',
    });
});

test('database startup repairs only third-party dependency import failures', () => {
  for (const message of [
    "Cannot find module '@mikro-orm/sql'",
    "Cannot find module '/candidate/node_modules/@mikro-orm/core/missing.js'",
    "Cannot find module './missing.js'\nRequire stack:\n- /candidate/node_modules/@mikro-orm/sql/index.js",
  ]) {
    const result = databaseStartupFailure(
      Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' }),
    );
    assert.equal(dependencyFailure(result), true);
  }
  for (const value of [
    new Error('heap out of memory'),
    undefined,
    Object.assign(
      new Error(
        "Cannot find module './schema'\nRequire stack:\n- /candidate/static/build/data/databaseWorker.js",
      ),
      { code: 'MODULE_NOT_FOUND' },
    ),
    Object.assign(new Error("Cannot find module 'node:sqlite'"), {
      code: 'MODULE_NOT_FOUND',
    }),
  ])
    assert.equal(dependencyFailure(databaseStartupFailure(value)), false);
});

test('Node 20 rejects backend initialization before changing its old database or .env', async (t) => {
  const node20 = process.env.QL_TEST_NODE20;
  if (!node20) {
    t.skip('Set QL_TEST_NODE20 to verify an existing Node 20 runtime');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-runtime-floor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'),
    db = path.join(data, 'db/database.sqlite'),
    env = path.join(dir, '.env');
  await fs.mkdir(path.dirname(db), { recursive: true });
  await fs.writeFile(db, 'old synthetic database marker');
  await fs.writeFile(env, 'SYNTHETIC_ENV=keep\n');
  const result = spawnSync(
    node20,
    [path.resolve('static/build/bootstrap/database.js')],
    {
      env: { ...process.env, QL_DIR: dir, QL_DATA_DIR: data },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node >=22\.17/);
  assert.equal(await fs.readFile(db, 'utf8'), 'old synthetic database marker');
  assert.equal(await fs.readFile(env, 'utf8'), 'SYNTHETIC_ENV=keep\n');
});
