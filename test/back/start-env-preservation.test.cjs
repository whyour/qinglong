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
for (const command of ['start', 'reload']) {
  for (const existing of [false, true]) {
    test(`${command} ${
      existing ? 'preserves existing' : 'initializes missing'
    } .env`, (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-env-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.mkdirSync(path.join(root, 'shell'));
      fs.writeFileSync(path.join(root, 'shell/test.sh'), '# fixture');
      fs.writeFileSync(path.join(root, '.env.example'), 'BACK_PORT=5700\n');
      const custom = 'BACK_PORT=5800\nJWT_SECRET=synthetic-test-only\n';
      if (existing)
        fs.writeFileSync(path.join(root, '.env'), custom, { mode: 0o600 });
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          'npm(){ :; }; pip3(){ :; }; apk(){ :; }; sudo(){ "$@"; }; python3(){ printf 3.11; };\n' +
            source,
          'startup-test',
          command,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            QL_DIR: root,
            QL_DATA_DIR: root + '/data',
            QL_OS_TYPE: 'alpine',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        fs.readFileSync(path.join(root, '.env'), 'utf8'),
        existing ? custom : 'BACK_PORT=5700\n',
      );
      if (existing)
        assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
    });
  }
}
