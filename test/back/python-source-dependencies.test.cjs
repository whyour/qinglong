const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
test('Python source arguments round-trip literally and local files stay inside maintained roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-pip-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts'),
    repo = path.join(root, 'repo');
  fs.mkdirSync(scripts);
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(scripts, 'project space'));
  const requirement = path.join(scripts, 'project space', 'requirements.txt');
  fs.writeFileSync(requirement, 'requests');
  fs.writeFileSync(
    path.join(scripts, 'project space', 'pyproject.toml'),
    '[project]\nname="sample"',
  );
  const outside = path.join(root, 'requirements.txt');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(scripts, 'requirements-link.txt'));
  const api = load('back/config/util.ts', {
    './index': { scriptPath: scripts, repoPath: repo },
    './const': { PYTHON_INSTALL_DIR: '/prefix with spaces' },
    '../loaders/logger': {},
    '../shared/utils': {},
    '../data/dependence': {
      DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
    },
  });
  function args(cmd) {
    return execFileSync('/bin/bash', [
      '-c',
      'pip3(){ printf "%s\\0" "$@"; }; ' + cmd,
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
  }
  const req = args(api.getInstallCommand(1, 'project space/requirements.txt'));
  assert.equal(req.at(-1), requirement);
  assert.equal(req.at(-2), '-r');
  assert.ok(req.includes('--prefix=/prefix with spaces'));
  assert.equal(
    args(api.getInstallCommand(1, 'project space/pyproject.toml')).at(-1),
    path.dirname(requirement),
  );
  const url = 'git+https://example.invalid/repo.git#egg=pkg;$(echo INJECTED)';
  assert.equal(args(api.getInstallCommand(1, url)).at(-1), url);
  assert.throws(() => api.getInstallCommand(1, '../requirements.txt'));
  assert.throws(() => api.getInstallCommand(1, 'requirements-link.txt'));
  assert.equal(
    args(api.getUninstallCommand(1, 'project space/requirements.txt')).at(-1),
    requirement,
  );
  assert.match(
    api.getUninstallCommand(1, url),
    /Remove installed Python distributions separately/,
  );
});
