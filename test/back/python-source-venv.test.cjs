const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

test('requirements install, probe and removal stay in the selected venv', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-source-venv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venv = path.join(root, 'virtual env');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  execFileSync('python3', ['-m', 'venv', venv]);
  const wheel = path.join(scripts, 'ql_venv_fixture-1.0-py3-none-any.whl');
  execFileSync('python3', [
    '-c',
    `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('ql_venv_fixture.py','value = 42')
 z.writestr('ql_venv_fixture-1.0.dist-info/METADATA','Metadata-Version: 2.1\\nName: ql-venv-fixture\\nVersion: 1.0\\n')
 z.writestr('ql_venv_fixture-1.0.dist-info/WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
 z.writestr('ql_venv_fixture-1.0.dist-info/RECORD','')`,
    wheel,
  ]);
  fs.writeFileSync(path.join(scripts, 'requirements.txt'), wheel + '\n');
  const api = load('back/config/util.ts', {
    './index': {
      rootPath: root,
      scriptPath: scripts,
      repoPath: path.join(root, 'repo'),
    },
    './const': {
      PYTHON_VENV_DIR: 'virtual env',
      PYTHON_INSTALL_DIR: '/unused-global-prefix',
    },
    '../loaders/logger': {},
    '../shared/utils': {},
    '../data/dependence': {
      DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
    },
  });
  const run = (command) =>
    execFileSync('/bin/bash', ['-c', command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PIP_NO_INDEX: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    });
  const install = api.getInstallCommand(1, 'requirements.txt');
  assert.doesNotMatch(install, /--prefix=/);
  run(install);
  assert.match(run(api.getGetCommand(1, 'ql-venv-fixture')), /1\.0/);
  assert.equal(
    run(
      `'${path.join(
        venv,
        'bin/python3',
      )}' -c 'import ql_venv_fixture; print(ql_venv_fixture.value)'`,
    ).trim(),
    '42',
  );
  run(api.getUninstallCommand(1, 'requirements.txt'));
  assert.throws(() =>
    run(`'${path.join(venv, 'bin/python3')}' -c 'import ql_venv_fixture'`),
  );
});
