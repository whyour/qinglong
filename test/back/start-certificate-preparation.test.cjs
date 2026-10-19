const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const startup = fs.readFileSync('shell/start-simplify.sh', 'utf8');
const runtimeLoader = fs.readFileSync('shell/share.sh', 'utf8')
  .match(/^load_node_runtime_args\(\) \{[\s\S]*?^\}/m)[0];
const preparation = `${runtimeLoader}\ndir_root="$QL_DIR"\n` + startup.slice(
  startup.indexOf('\nfix_config\n'),
  startup.indexOf('log_with_style "INFO" "$(t \'🔄'),
);
for (const fails of [false, true]) {
  test(`manual startup ${
    fails
      ? 'stops on certificate failure'
      : 'awaits certificates before starting supervision'
  }`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-start-certs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const module = path.join(root, 'static/build/config/grpcCerts.js');
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.writeFileSync(
      module,
      `exports.initGrpcCerts = () => new Promise((resolve, reject) => setTimeout(() => {
      if (process.env.QA_CERT_FAILURE === '1') return reject(new Error('certificate preparation failed'));
      require('node:fs').writeFileSync(require('node:path').join(process.env.QL_DIR, 'certs-ready'), 'ready');
      resolve();
    }, 50));`,
    );
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -e
fix_config(){ :; }
pm2(){ test -f "$QL_DIR/certs-ready"; touch "$QL_DIR/supervisor-started"; }
${preparation}`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          QL_DIR: root,
          QA_CERT_FAILURE: fails ? '1' : '0',
        },
      },
    );
    assert.equal(result.status, fails ? 1 : 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'supervisor-started')), !fails);
    if (fails) assert.match(result.stderr, /certificate preparation failed/);
  });
}
