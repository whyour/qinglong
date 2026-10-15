const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

test('#3097 Python requirement probes preserve version constraints, extras and installed distributions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-specifiers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venv = path.join(root, 'virtual env');
  execFileSync('python3', ['-m', 'venv', venv]);
  execFileSync('python3', [
    '-c',
    `import zipfile,sys,os
for version in ['1.2.3','2.1.0']:
 name='ql_specifier_fixture'
 with zipfile.ZipFile(os.path.join(sys.argv[1],name+'-'+version+'-py3-none-any.whl'),'w') as z:
  z.writestr(name+'.py','value=42\\n')
  info=name+'-'+version+'.dist-info/'
  z.writestr(info+'METADATA','Metadata-Version: 2.1\\nName: ql-specifier-fixture\\nVersion: '+version+'\\nProvides-Extra: optional\\n')
  z.writestr(info+'WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
  z.writestr(info+'RECORD','')`,
    root,
  ]);
  const api = load('back/config/util.ts', {
    './index': { rootPath: root },
    './const': { PYTHON_VENV_DIR: venv, PYTHON_INSTALL_DIR: '/unused-prefix' },
    '../loaders/logger': {},
    '../shared/utils': {},
    '../data/dependence': {
      DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
    },
  });
  const env = { ...process.env, PIP_NO_INDEX: '1', PIP_FIND_LINKS: root };
  for (const key of ['PYTHONPATH', 'PYTHONUSERBASE', 'PYTHON_HOME'])
    delete env[key];
  const run = (command) =>
    execFileSync('/bin/bash', ['-c', command], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  run(api.getInstallCommand(1, 'ql-specifier-fixture==1.2.3'));
  const Service = load('back/services/dependence.ts', {
    '../config': {},
    '../config/util': {
      ...api,
      promiseExecSuccess: async (command) => run(command),
    },
    '../data/dependence': {
      Dependence: class {},
      DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
      versionDependenceCommandTypes: { 0: '@', 1: '==', 2: '=' },
    },
    '../shared/pLimit': {},
    './sock': class {},
    '../shared/i18n': {},
  }).default;
  const service = new Service({}, {});
  assert.equal(
    await service.isDependenceInstalled({
      type: 1,
      name: 'ql-specifier-fixture==1.2.3.0',
    }),
    true,
  );
  assert.equal(
    await service.isDependenceInstalled({
      type: 1,
      name: 'ql-specifier-fixture>=2',
    }),
    false,
  );
  for (const suffix of [
    '',
    '>=1.0',
    '<2',
    '>=1,<2',
    '~=1.2',
    '==1.*',
    '!=2.0',
    '[optional]>=1',
    '==1.2.3.0',
  ]) {
    assert.equal(
      run(api.getGetCommand(1, 'ql-specifier-fixture' + suffix)),
      '1.2.3',
      suffix,
    );
  }
  for (const suffix of ['>=2', '<1', '!=1.2.3', '==1.2.30']) {
    assert.equal(
      run(api.getGetCommand(1, 'ql-specifier-fixture' + suffix)),
      '',
      suffix,
    );
  }
  assert.equal(run(api.getGetCommand(1, 'ql_specifier_fixture')), '1.2.3');
  assert.equal(run(api.getGetCommand(1, 'json')), 'json');
  assert.equal(
    run(api.getGetCommand(1, 'ql-missing-specifier-package>=1')),
    '',
  );
  assert.equal(
    run(api.getGetCommand(1, 'ql-specifier-fixture; python_version < "0"')),
    'not applicable',
  );
  run(api.getInstallCommand(1, 'ql-specifier-fixture>=2'));
  assert.equal(
    run(api.getGetCommand(1, 'ql-specifier-fixture>=2,<3')),
    '2.1.0',
  );
  run(api.getUninstallCommand(1, 'ql-specifier-fixture[optional]>=2,<3'));
  assert.equal(run(api.getGetCommand(1, 'ql-specifier-fixture')), '');
  assert.equal(fs.existsSync(path.join(root, 'INJECTED')), false);
  assert.equal(
    run(
      api.getGetCommand(
        1,
        `ql-specifier-fixture; __import__('os').system('touch ${root}/INJECTED')`,
      ),
    ),
    '',
  );
});
