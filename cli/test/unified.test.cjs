const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installCliEntrypoints } = require('../dist/local/entrypoints');

test('unified ql groups and task shortcut preserve help, errors and local execution boundaries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-unified-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    QL_DIR: root,
    QL_CLI_CONFIG: path.join(root, 'credentials'),
    QL_LANG: 'en',
  };
  const call = (entry, args) =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, `../dist/${entry}.js`), ...args],
      { env, encoding: 'utf8', timeout: 10000 },
    );
  for (const group of ['', 'task', 'local']) {
    const result = call('ql', [...(group ? [group] : []), '--help', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).data.help, /ql/);
  }
  for (const kind of ['repo', 'raw']) {
    const help = call('ql', ['local', kind, '--help', '--json']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(JSON.parse(help.stdout).data.help, /ql repo/);
  }
  for (const args of [
    ['task', 'list'],
    ['task', 'run', '12'],
    ['subscription', 'list'],
    ['app', 'list'],
    ['system', 'info'],
    ['auth', 'status'],
    ['api', 'routes'],
  ]) {
    const result = call('ql', [...args, '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
  }
  const invalid = call('ql', ['task', 'run', 'demo.sh', '--json']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  const local = call('ql', [
    'local',
    'repair-config',
    '--root',
    'relative',
    '--json',
  ]);
  assert.equal(local.status, 2);
  assert.match(JSON.parse(local.stderr).message, /absolute/);
  await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/config/config.sh'),
    'no_tee=false\n',
  );
  await fs.writeFile(
    path.join(root, 'data/scripts/demo.sh'),
    'printf "script:%s\\n" "$1"; return 7\n',
  );
  for (const [entry, args] of [
    ['ql', ['task', 'demo.sh', 'now', '--', '--json']],
    ['ql', ['task', 'exec', 'demo.sh', 'now', '--', '--json']],
    ['task', ['demo.sh', 'now', '--', '--json']],
    ['task', ['exec', 'demo.sh', 'now', '--', '--json']],
  ]) {
    const result = call(entry, args);
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stdout, /script:--json/);
  }
  const shortcut = call('task', ['list', '--json']);
  assert.equal(shortcut.status, 2, shortcut.stderr);
  const legacy = call('ql', ['update', 'invalid']);
  assert.equal(legacy.status, 2, legacy.stderr);
  assert.ok(legacy.stderr.length > 0);
  for (const args of [['raw'], ['local', 'raw'], ['repo'], ['local', 'repo']]) {
    const result = call('ql', args);
    assert.equal(result.status, 2, result.stderr);
  }
  const bin = path.join(root, 'bin');
  await installCliEntrypoints(bin, path.resolve(__dirname, '..'));
  for (const name of ['ql', 'task']) {
    const result = spawnSync(path.join(bin, name), ['--help'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /task/);
  }
});

test('internal rejection never loads remote credentials or local operators', () => {
  const code = `process.stdout.write=()=>true;process.stderr.write=()=>true;
require('./cli/dist/ql').qlMain(['task','list','--json']).then(code=>{
if(code!==2) process.exit(1);
if(Object.keys(require.cache).some(p=>p.includes('/dist/local/') || p.includes('/dist/commands/auth') || p.includes('/dist/config/store'))) process.exit(2);
});`;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      PATH: process.env.PATH,
      QL_CLI_CONFIG: '/nonexistent-ql-unified-config',
      QL_URL: 'https://must-not-be-contacted.invalid',
      QL_ACCESS_TOKEN: 'test-only',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
