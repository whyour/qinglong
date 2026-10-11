const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const {
  writeManifest,
  sourceCommit,
} = require('../helpers/upgrade-fixture.cjs');
const { waitForHealth, withUpgradeLock } = require('../../shell/upgrade.cjs');

const share = `
export dir_root="$QL_DIR" dir_shell="$QL_DIR/shell" dir_tmp="$QL_DIR/.tmp"
export dir_data="$QL_DIR/data" dir_static="$QL_DIR/static" dir_log="$QL_DIR/data/log" dir_config="$QL_DIR/data/config"
load_ql_envs() { :; }
import_config() { :; }
fix_config() { :; }
make_dir() { mkdir -p "$1"; }
format_timestamp() { date +%s; }
format_time() { printf '%s' "$2"; }
t() { printf "$@"; }
npm_install_2() {
  printf installed > "$QL_DIR/installed"
  exit_status="$DEP_STATUS"
  mkdir -p "$1/node_modules"
  printf new > "$1/node_modules/dependency"
}
delete_pm2() { printf stopped >> "$QL_DIR/stops"; }
reload_pm2() {
  printf started >> "$QL_DIR/starts"
  if [[ "$FAIL_START" == 'true' ]] && [[ ! -f "$QL_DIR/failed-once" ]]; then
    touch "$QL_DIR/failed-once"; return 1
  fi
}
`;

function write(root, name, content) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
}

function run(program, args, options) {
  return new Promise((resolve, reject) => {
    const cp = spawn(program, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    cp.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    cp.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    cp.on('error', reject);
    cp.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-shell-upgrade-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'panel'),
    payload = path.join(base, 'payload'),
    archives = path.join(base, 'archives');
  const branch = ['develop', 'debian-dev'].includes(options.branch)
    ? 'develop'
    : 'master';
  const source = path.join(payload, `qinglong-${sourceCommit}`),
    staticRoot = path.join(payload, `qinglong-static-${branch}`);
  const packageJson = '{"version":"2.22.0"}';
  for (const target of [root, source]) {
    write(target, 'shell/update.sh', fs.readFileSync('shell/update.sh'));
    write(target, 'shell/upgrade.cjs', fs.readFileSync('shell/upgrade.cjs'));
    write(
      target,
      'cli/src/internal/maintenance/upgradeArtifacts.cjs',
      fs.readFileSync('cli/src/internal/maintenance/upgradeArtifacts.cjs'),
    );
    write(target, 'shell/share.sh', share);
    write(target, 'shell/api.sh', '');
    write(target, 'shell/env.sh', '');
    write(target, 'sample/config.sample.sh', 'sample');
    write(target, 'package.json', packageJson);
    write(
      target,
      'pnpm-lock.yaml',
      target === source && options.lockChange ? 'new lock' : 'old lock',
    );
    write(target, 'back/app.ts', target === source ? 'new' : 'old');
    write(
      target,
      'version.yaml',
      target === source ? 'version: 2.22.0' : 'version: 2.21.0',
    );
  }
  write(root, 'node_modules/dependency', 'old');
  write(root, '.env', 'private setting');
  write(root, 'data/config/config.sh', 'custom');
  write(root, 'static/build/app.js', 'old backend');
  write(root, 'static/dist/index.html', 'old frontend');
  write(root, '.tmp/import-in-progress', 'keep');
  write(staticRoot, 'build/app.js', 'new backend');
  write(staticRoot, 'dist/index.html', '<script src="umi.js"></script>');
  write(staticRoot, 'dist/umi.js', 'dashboard');
  write(source, '.env.example', 'new example');
  writeManifest(source, staticRoot);
  const manifestFile = path.join(staticRoot, 'build-info.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (options.manifest === 'missing') fs.unlinkSync(manifestFile);
  else if (options.manifest === 'dirty')
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, dirty: true }),
    );
  else if (options.manifest === 'lock')
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, lockfileSha256: '0'.repeat(64) }),
    );
  else if (options.manifest === 'commit')
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, sourceCommit: 'b'.repeat(40) }),
    );
  else if (options.manifest === 'checksum')
    write(staticRoot, 'dist/umi.js', 'stale frontend');
  else if (options.manifest === 'extra')
    write(staticRoot, 'build/stale.js', 'stale backend');
  else if (options.manifest === 'frontend')
    fs.unlinkSync(path.join(staticRoot, 'dist/index.html'));
  fs.mkdirSync(archives);
  for (const repo of ['qinglong', 'qinglong-static']) {
    const archive = path.join(archives, `${repo}.zip`);
    execFileSync(
      'zip',
      [
        '-qr',
        archive,
        `${repo}-${repo === 'qinglong' ? sourceCommit : branch}`,
      ],
      { cwd: payload },
    );
    if (options.corrupt === repo) fs.writeFileSync(archive, 'invalid zip');
  }
  const curl = write(
    base,
    'bin/curl',
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args.includes('--head')) process.exit(7);
const repo=args.at(-1).includes('/qinglong-static/')?'qinglong-static':'qinglong';
fs.appendFileSync(process.env.TRACE,args.at(-1)+'\\n');
if(process.env.FAIL_DOWNLOAD===repo) process.exit(22);
fs.copyFileSync(path.join(process.env.ARCHIVES,repo+'.zip'),args[args.indexOf('--output')+1]);
`,
  );
  fs.chmodSync(curl, 0o755);
  const server = http.createServer((req, res) =>
    res.end('{"code":200,"data":{"status":"ok"}}'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    QL_DIR: root,
    QL_BRANCH: options.branch || 'master',
    PATH: `${path.join(base, 'bin')}:${process.env.PATH}`,
    QlPort: String(server.address().port),
    ARCHIVES: archives,
    TRACE: path.join(base, 'trace'),
    real_time: options.tee ? 'false' : 'true',
    FAIL_DOWNLOAD: options.download || '',
    DEP_STATUS: options.depFail ? '1' : '0',
    FAIL_START: options.failStart ? 'true' : 'false',
  };
  return {
    root,
    env,
    execute: (...args) =>
      run('bash', [path.join(root, 'shell/update.sh'), ...args], { env }),
    read: (name) => fs.readFileSync(path.join(root, name), 'utf8'),
  };
}

for (const options of [
  { download: 'qinglong' },
  { download: 'qinglong-static', tee: true },
  { corrupt: 'qinglong' },
  { corrupt: 'qinglong-static', tee: true },
  ...[
    'missing',
    'dirty',
    'lock',
    'commit',
    'checksum',
    'extra',
    'frontend',
  ].map((manifest) => ({ manifest })),
  { lockChange: true, depFail: true, tee: true },
])
  test(`failed update preserves the running panel: ${JSON.stringify(
    options,
  )}`, async (t) => {
    const f = await fixture(t, options);
    const result = await f.execute('update');
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.equal(f.read('version.yaml'), 'version: 2.21.0');
    assert.equal(f.read('node_modules/dependency'), 'old');
    assert.equal(f.read('static/dist/index.html'), 'old frontend');
    assert.equal(fs.existsSync(path.join(f.root, 'stops')), false);
    assert.equal(f.read('.tmp/import-in-progress'), 'keep');
    assert.deepEqual(fs.readdirSync(path.join(f.root, '.tmp')), [
      'import-in-progress',
    ]);
  });

for (const branch of ['master', 'develop', 'debian', 'debian-dev'])
  test(`download-only then reload installs matching artifacts and lockfile dependencies: ${branch}`, async (t) => {
    const f = await fixture(t, { branch, lockChange: true, tee: true });
    let result = await f.execute('update', 'false');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(f.read('version.yaml'), 'version: 2.21.0');
    assert.equal(fs.existsSync(path.join(f.root, 'stops')), false);
    assert.match(
      fs.readFileSync(f.env.TRACE, 'utf8'),
      new RegExp(`qinglong/repository/archive/${sourceCommit}\\.zip`),
    );
    result = await f.execute('reload', 'system');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(f.read('node_modules/dependency'), 'new');
    assert.equal(f.read('pnpm-lock.yaml'), 'new lock');
    assert.equal(f.read('static/dist/umi.js'), 'dashboard');
    assert.equal(f.read('back/app.ts'), 'new');
    assert.equal(f.read('.env'), 'private setting');
    assert.equal(f.read('.env.example'), 'new example');
    assert.equal(f.read('data/config/config.sh'), 'custom');
    assert.deepEqual(fs.readdirSync(path.join(f.root, '.tmp')), [
      'import-in-progress',
    ]);
    assert.ok(
      !fs.readdirSync(f.root).some((name) => name.includes('ql-backup')),
    );
  });

test('a failed start rolls code, frontend and node_modules back and exits nonzero through tee', async (t) => {
  const f = await fixture(t, { lockChange: true, failStart: true, tee: true });
  const result = await f.execute('update');
  assert.notEqual(result.code, 0);
  assert.equal(f.read('version.yaml'), 'version: 2.21.0');
  assert.equal(f.read('node_modules/dependency'), 'old');
  assert.equal(f.read('static/dist/index.html'), 'old frontend');
  assert.equal(f.read('starts'), 'startedstarted');
  assert.ok(!fs.readdirSync(f.root).some((name) => name.includes('ql-backup')));
});

test('reload revalidates staged files before stopping the old panel', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute('update', 'false')).code, 0);
  const directory = JSON.parse(
    f.read('.tmp/upgrade-ready-master.json'),
  ).directory;
  write(
    f.root,
    `.tmp/${directory}/qinglong-static-master/dist/umi.js`,
    'corrupt',
  );
  assert.notEqual((await f.execute('reload', 'system')).code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'stops')), false);
});

test('a new successful stage retires only the previous ready workspace', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute('update', 'false')).code, 0);
  const previous = JSON.parse(
    f.read('.tmp/upgrade-ready-master.json'),
  ).directory;
  assert.equal((await f.execute('update', 'false')).code, 0);
  const current = JSON.parse(
    f.read('.tmp/upgrade-ready-master.json'),
  ).directory;
  assert.notEqual(previous, current);
  assert.equal(fs.existsSync(path.join(f.root, '.tmp', previous)), false);
  assert.equal(f.read('.tmp/import-in-progress'), 'keep');
});

test('failed health checks and concurrent upgrades are rejected', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-upgrade-lock-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await withUpgradeLock(tmp, async () => {
    await assert.rejects(
      withUpgradeLock(tmp, async () => {}),
      /Another upgrade/,
    );
  });
  assert.deepEqual(fs.readdirSync(tmp), []);
  const server = http.createServer((req, res) => {
    res.statusCode = 503;
    res.end('{"code":503}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    waitForHealth({ QlPort: String(server.address().port) }, 20),
    /health check/,
  );
});
