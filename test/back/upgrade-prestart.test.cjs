const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  prestartBackend,
  dependencyFailure,
  probeLimits,
  repairDependencies,
} = require('../../cli/src/internal/maintenance/upgradePrestart.cjs');

test('real Node resolution failures distinguish broken dependency entries and internal imports from backend source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-missing-entry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/broken-entry');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ main: 'missing.js' }),
  );
  const load = require('node:module').createRequire(
    path.join(root, 'package.json'),
  );
  assert.throws(
    () => load('broken-entry'),
    (error) => dependencyFailure(error),
  );
  await fs.writeFile(
    path.join(directory, 'missing.js'),
    "require('./missing-internal-file')",
  );
  assert.throws(
    () => load('broken-entry'),
    (error) => dependencyFailure(error),
  );
  await fs.writeFile(
    path.join(root, 'api.js'),
    "require('./missing-api-route')",
  );
  assert.throws(
    () => load('./api.js'),
    (error) => !dependencyFailure(error),
  );
});

test('ARMv6 repair isolates configuration, uses frozen install, one compiler job and interpreted Node', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-repair-armv6-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    bin = path.join(root, 'bin');
  await fs.mkdir(source);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@8.3.1' }),
  );
  await fs.writeFile(path.join(source, 'pnpm-lock.yaml'), 'frozen lock');
  await fs.writeFile(
    path.join(bin, 'pnpm'),
    `#!${process.execPath}
    const fs=require('node:fs');
    if(process.argv[2]==='--version') {console.error('harmless runtime warning'); console.log('8.3.1');}
    else if(process.argv[2]==='install') {
      if(!process.argv.includes('--frozen-lockfile')||!process.argv.includes('--prod')) throw Error('not frozen production install');
      fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/flags.json',JSON.stringify({
        args:process.argv,options:process.env.NODE_OPTIONS,source:process.env.npm_config_build_from_source,
        processConfig:process.env.npm_config_force_process_config,jobs:process.env.npm_config_jobs,make:process.env.MAKEFLAGS
      }));
    } else if(process.argv.slice(2).join(' ')!=='rebuild sqlite3 @whyour/sqlite3') throw Error('unexpected command');
  `,
    { mode: 0o755 },
  );
  await repairDependencies(source, {
    target: { arch: 'armv6' },
    env: {
      PATH: bin,
      NODE_OPTIONS: '--require untrusted',
      npm_config_nodedir: '/wrong-node',
    },
  });
  const flags = JSON.parse(
    await fs.readFile(path.join(source, 'node_modules/flags.json')),
  );
  assert.match(flags.options, /--jitless/);
  assert.match(flags.options, /max-old-space-size=256/);
  assert.equal(flags.source, 'true');
  assert.equal(flags.processConfig, 'true');
  assert.equal(flags.jobs, '1');
  assert.equal(flags.make, '-j1');
  assert.deepEqual((await fs.readdir(root)).sort(), ['bin', 'source']);
});

test('repair classification excludes application, platform, config, database, OOM and timeouts', () => {
  for (const error of [
    { code: 'MODULE_NOT_FOUND', message: "Cannot find module './api/missing'" },
    { message: 'Bundle platform mismatch' },
    { message: 'SQLITE_CANTOPEN' },
    { message: 'Upgrade prestart timed out' },
    {
      code: 'ERR_DLOPEN_FAILED',
      message: 'node_modules/sqlite3/node.node',
      signal: 'SIGKILL',
    },
    { message: 'JavaScript heap out of memory' },
  ])
    assert.equal(dependencyFailure(error), false, JSON.stringify(error));
  assert.equal(
    dependencyFailure({
      code: 'MODULE_NOT_FOUND',
      message: "Cannot find module 'decimal.js'",
    }),
    true,
  );
  assert.equal(
    dependencyFailure({
      code: 'ERR_DLOPEN_FAILED',
      message: 'dlopen /tmp/node_modules/sqlite3/node.node: invalid ELF header',
    }),
    true,
  );
  assert.equal(
    dependencyFailure({
      message:
        'Could not locate the bindings file /tmp/node_modules/sqlite3/bindings',
    }),
    true,
  );
  assert.deepEqual(probeLimits({ arch: 'armv6' }), {
    heapMb: 128,
    timeoutMs: 300000,
  });
});

test('prestart deadline kills its process group and removes temporary data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-prestart-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    statics = path.join(root, 'static');
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(source, 'version.yaml'), 'version: 2.23.0');
  await fs.mkdir(path.join(statics, 'build/bootstrap'), { recursive: true });
  await fs.writeFile(path.join(statics, 'build/app.js'), 'backend');
  await fs.writeFile(
    path.join(statics, 'build-info.json'),
    JSON.stringify({ sourceCommit: 'a'.repeat(40) }),
  );
  const survivor = path.join(root, 'survivor');
  await fs.writeFile(
    path.join(statics, 'build/bootstrap/upgradeProbe.js'),
    `
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(
      `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(
        survivor,
      )},'escaped'),2200)`,
    )}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `,
  );
  await assert.rejects(
    prestartBackend(
      { source, static: statics },
      {
        target: { arch: 'armv6' },
        limits: { heapMb: 128, timeoutMs: 1000 },
      },
    ),
    /timed out/,
  );
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'static']);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await assert.rejects(fs.access(survivor), { code: 'ENOENT' });
});

test('repair refuses an unsupported package manager before invoking a network command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-repair-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'package.json'), '{}');
  await assert.rejects(
    repairDependencies(source, {
      target: { arch: 'armv6' },
      env: { PATH: '' },
    }),
    /Unsupported frozen-lockfile/,
  );
  assert.deepEqual(await fs.readdir(root), ['source']);
});
