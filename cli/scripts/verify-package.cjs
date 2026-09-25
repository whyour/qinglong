const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-package-'));
const run = (program, args, options = {}) =>
  execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    ...options,
  });
try {
  const cache = path.join(temp, 'cache');
  const manifest = JSON.parse(
    run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--cache',
        cache,
        '--pack-destination',
        temp,
      ],
      { cwd: root },
    ),
  )[0];
  for (const name of ['README.md', 'README.en.md', 'LICENSE', 'dist/npm/commander-LICENSE'])
    assert.ok(manifest.files.some((file) => file.path === name), name);
  assert.ok(manifest.files.every((file) => /^(dist\/npm\/|skills\/qinglong-cli\/|README(?:\.en)?\.md$|LICENSE$|package\.json$)/.test(file.path)));
  assert.ok(
    manifest.files.some((file) => file.path === 'skills/qinglong-cli/SKILL.md'),
  );
  assert.ok(
    !manifest.files.some(
      (file) => file.path.startsWith('src/') || file.path.startsWith('test/'),
    ),
  );
  const prefix = path.join(temp, 'install');
  run(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
      '--prefix',
      prefix,
      path.join(temp, manifest.filename),
    ],
    { cwd: temp },
  );
  const installed = path.join(prefix, 'node_modules/@qinglong/cli');
  const metadata = JSON.parse(
    fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
  assert.equal(metadata.bin['ql-dev-cli'], undefined);
  assert.ok(!manifest.files.some(file => /^dist\/developer(?:\/|\.)/.test(file.path)));
  assert.deepEqual(metadata.bin, { ql: 'dist/npm/ql.js' });
  for (const reference of ['panel.md'])
    assert.ok(fs.existsSync(path.join(installed, 'skills/qinglong-cli/references', reference)));

  assert.equal(
    fs.readFileSync(
      path.join(installed, 'skills/qinglong-cli/SKILL.md'),
      'utf8',
    ),
    fs.readFileSync(path.join(root, 'skills/qinglong-cli/SKILL.md'), 'utf8'),
  );
  const entries = [];
  for (const [name, target] of Object.entries(metadata.bin)) {
    const entry = path.join(prefix, 'node_modules/.bin', name);
    assert.equal(
      fs.realpathSync(entry),
      fs.realpathSync(path.join(installed, target)),
    );
    const output = run(entry, ['--help'], {
      cwd: temp,
      env: { ...process.env, QL_DIR: '', QL_DATA_DIR: '' },
    });
    assert.match(output, /Usage:|用法|usage/i);
    entries.push(name);
  }
  assert.ok(!manifest.files.some(file => file.path.includes('qinglong-local')));
  for (const args of [['reload'], ['resetpwd', 'fixture'], ['local', 'check'], ['task', 'exec', 'fixture.js'], ['task', 'fixture.js'], ['repo', 'fixture'], ['dev', 'release']]) {
    const result = spawnSync(process.execPath, [path.join(installed, metadata.bin.ql), ...args, '--json'], {
      cwd: temp, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, QL_CLI_CONFIG: path.join(temp, 'missing.json'), QL_DIR: '/nonexistent-panel' },
    });
    assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 2);
  }
  // CI uploads the exact archive whose isolated installation passed above.
  if (process.env.QL_CLI_PACKAGE_OUTPUT) {
    const output = path.resolve(process.env.QL_CLI_PACKAGE_OUTPUT);
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(path.join(temp, manifest.filename), path.join(output, manifest.filename));
  }
  process.stdout.write(
    JSON.stringify(
      {
        entries,
        packedBytes: manifest.size,
        unpackedBytes: manifest.unpackedSize,
        runtimeDependencies: 0,
        standaloneInstall: true,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
