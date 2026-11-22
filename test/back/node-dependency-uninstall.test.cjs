const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

const api = load('back/config/util.ts', {
  './index': {},
  './const': {},
  '../loaders/logger': {},
  '../shared/utils': {},
  '../data/dependence': {
    DependenceTypes: { nodejs: 0, python3: 1, linux: 2 },
  },
});

for (const [specifier, installedName] of [
  ['is-number@7.0.0', 'is-number'],
  [' is-number@^7.0.0 ', 'is-number'],
  ['is-number@latest', 'is-number'],
  ['is-number', 'is-number'],
  ['@scope/name@1.2.3-beta.1', '@scope/name'],
  ['@scope/name@next', '@scope/name'],
  ['@scope/name', '@scope/name'],
  ['alias@npm:is-number@7.0.0', 'alias'],
  ["literal'$(printf INJECTED)", "literal'$(printf INJECTED)"],
]) {
  test(`Node uninstall passes the installed name literally: ${specifier}`, () => {
    const command = api.getUninstallCommand(0, specifier);
    const args = execFileSync('/bin/sh', [
      '-c',
      'pnpm() { printf "%s\\0" "$@"; }; ' + command,
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
    assert.deepEqual(args, ['remove', '-g', '--', installedName]);
  });
}

test('cancel can locate an uninstall process after shell argument parsing', async (t) => {
  const name = `@ql-uninstall-fixture/worker-${process.pid}`;
  const command = api.getUninstallCommand(0, `${name}@1.0.0`);
  const worker = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', 'pnpm', 'remove', '-g', '--', name],
    { stdio: 'ignore' },
  );
  t.after(() => worker.kill());
  await new Promise((resolve, reject) => {
    worker.once('spawn', resolve);
    worker.once('error', reject);
  });
  assert.equal(await api.getPid(command), worker.pid);
});
