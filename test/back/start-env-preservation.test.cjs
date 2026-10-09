const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the actual startup prefix, stopping before service initialization.
const source = fs
  .readFileSync('shell/start.sh', 'utf8')
  .split('. ${QL_DIR}/shell/share.sh')[0];

function fixture(t, existing) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'shell'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'shell/test.sh'), '# fixture');
  fs.writeFileSync(path.join(root, '.env.example'), 'BACK_PORT=5700\n');
  const custom = 'BACK_PORT=5800\nJWT_SECRET=synthetic-test-only\n';
  if (existing)
    fs.writeFileSync(path.join(root, '.env'), custom, { mode: 0o600 });
  const trace = path.join(root, 'runtime-install.json');
  fs.writeFileSync(
    path.join(root, 'scripts/install-runtime-tools.cjs'),
    `const fs = require('node:fs');
fs.writeFileSync(process.env.QL_INSTALL_TRACE, JSON.stringify(process.argv.slice(2)));
if (process.env.QL_INSTALL_FAILURE === '1') process.exit(19);
`,
  );
  return { root, custom, trace };
}

function startup(root, trace, command, fail = false) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `npm(){ [[ "$*" == 'prefix --global' ]] || return 2; printf '%s\\n' "$QL_DIR/global-prefix"; };
node(){ command '${process.execPath}' "$@"; };
pip3(){ :; }; apk(){ :; }; sudo(){ "$@"; }; python3(){ printf 3.11; };
${source}`,
      'startup-test',
      command,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QL_DIR: root,
        QL_DATA_DIR: path.join(root, 'data'),
        QL_OS_TYPE: 'alpine',
        QL_INSTALL_TRACE: trace,
        QL_INSTALL_FAILURE: fail ? '1' : '0',
      },
    },
  );
}

for (const command of ['start', 'reload']) {
  for (const existing of [false, true]) {
    test(`${command} ${
      existing ? 'preserves existing' : 'initializes missing'
    } .env`, (t) => {
      const { root, custom, trace } = fixture(t, existing);
      const result = startup(root, trace, command);
      assert.equal(result.status, 0, result.stderr);
      if (command === 'start')
        assert.deepEqual(JSON.parse(fs.readFileSync(trace, 'utf8')), [
          '--archive',
          path.join(root, 'static/runtime-tools.tgz'),
          '--proof',
          path.join(root, 'static/runtime-tools-proof.json'),
          '--prefix',
          path.join(root, 'global-prefix'),
        ]);
      else assert.equal(fs.existsSync(trace), false);
      assert.equal(
        fs.readFileSync(path.join(root, '.env'), 'utf8'),
        existing ? custom : 'BACK_PORT=5700\n',
      );
      if (existing)
        assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
    });
  }
}

for (const existing of [false, true]) {
  test(`failed runtime installation stops before ${
    existing ? 'changing existing' : 'creating missing'
  } .env`, (t) => {
    const { root, custom, trace } = fixture(t, existing);
    const result = startup(root, trace, 'start', true);
    assert.equal(result.status, 19, result.stderr);
    assert.equal(fs.existsSync(trace), true);
    if (existing) {
      assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), custom);
      assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
    } else assert.equal(fs.existsSync(path.join(root, '.env')), false);
  });
}
