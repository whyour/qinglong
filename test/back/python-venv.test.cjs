const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
test('venv installs, uninstalls and probes use the selected Python, including spaces', () => {
  const methods = load('back/config/util.ts', {
    './index': { rootPath: '/application' },
    './const': {
      PYTHON_VENV_DIR: 'virtual env',
      PYTHON_INSTALL_DIR: '/legacy',
    },
    '../loaders/logger': {},
    '../shared/utils': {},
    '../data/dependence': {
      DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
    },
  });
  for (const name of [
    'getInstallCommand',
    'getUninstallCommand',
    'getGetCommand',
  ]) {
    const cmd = methods[name](1, 'requests');
    assert.match(cmd, /'\/application\/virtual env\/bin\/python3'/);
    assert.doesNotMatch(cmd, /--prefix=/);
  }
});
test('venv setup keeps Python packages isolated and retains existing startup configuration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-venv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ql = path.join(dir, 'application with spaces');
  fs.mkdirSync(ql);
  const venv = path.join(dir, 'venv with spaces');
  execFileSync('python3', ['-m', 'venv', venv]);
  const source = fs.readFileSync('shell/start-simplify.sh', 'utf8');
  const snippet = source.slice(
    source.indexOf('export PNPM_HOME='),
    source.indexOf('\ncd "${QL_DIR}"'),
  );
  const result = execFileSync(
    '/bin/bash',
    [
      '-c',
      snippet +
        '\npython3 -c "import sys; print(sys.prefix); print(sys.base_prefix)"',
    ],
    {
      env: {
        ...process.env,
        QL_DIR: ql,
        QL_DATA_DIR: path.join(dir, 'data'),
        PYTHON_VENV_DIR: venv,
        PYTHONPATH: '/legacy/modules',
        PYTHONUSERBASE: '/legacy',
        PATH: process.env.PATH,
      },
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n');
  assert.equal(fs.realpathSync(result[0]), fs.realpathSync(venv));
  assert.notEqual(result[1], venv);
  assert.match(source, /set -C; cat .env.example > .env/);
  assert.doesNotMatch(source, /npm install|pip3 install|chmod 777/);
});
