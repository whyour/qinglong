'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');

const HOST_BOUND_TESTS = Object.freeze({
  'packages/ql3-local-owner-cli/test/adoptedDeploymentBundle.test.cjs':
    'requires repository-owned deployment entrypoint material',
  'packages/ql3-local-owner-cli/test/localDeployment.test.cjs':
    'exercises mutable deployment staging and host ownership',
  'packages/ql3-local-owner-cli/test/reconciliationCapturePrepare.test.cjs':
    'exercises sealed SQLite WAL and SHM capture assets',
  'packages/ql3-local-owner-cli/test/serviceBridgeRoot.test.cjs':
    'installs systemd and OpenRC descriptors into host service directories',
});

function collectReadonlyOwnerTests(root = repositoryRoot) {
  const packagesRoot = path.join(root, 'packages');
  const packageNames = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name === 'ql3-local-command-file' ||
          entry.name.startsWith('ql3-local-owner-')),
    )
    .map(({ name }) => name)
    .sort();
  const discovered = [];
  for (const packageName of packageNames) {
    const testRoot = path.join(packagesRoot, packageName, 'test');
    if (!fs.existsSync(testRoot)) continue;
    for (const entry of fs.readdirSync(testRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
        discovered.push(
          path.posix.join('packages', packageName, 'test', entry.name),
        );
      }
    }
  }
  discovered.sort();
  const missingClassifications = Object.keys(HOST_BOUND_TESTS).filter(
    (file) => !discovered.includes(file),
  );
  if (missingClassifications.length !== 0) {
    throw new Error(
      `reviewed host-bound Owner tests are missing: ${missingClassifications.join(
        ', ',
      )}`,
    );
  }
  const tests = discovered.filter((file) => !(file in HOST_BOUND_TESTS));
  if (tests.length === 0) {
    throw new Error('read-only Owner test plan is empty');
  }
  return Object.freeze({
    tests: Object.freeze(tests),
    hostBound: HOST_BOUND_TESTS,
  });
}

function assertWriteRejected(target) {
  try {
    fs.writeFileSync(target, 'unexpected-write', { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EROFS' || error?.code === 'EACCES') return;
    throw error;
  }
  try {
    fs.unlinkSync(target);
  } finally {
    throw new Error(`read-only boundary accepted a write: ${target}`);
  }
}

function assertContainerBoundary(mode) {
  if (!['root', 'nonroot'].includes(mode)) {
    throw new Error(
      'usage: ql3-local-owner-readonly-contract.cjs --mode=root|nonroot',
    );
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (mode === 'root' ? uid !== 0 : uid === null || uid === 0) {
    throw new Error(`Owner read-only actor identity is invalid for ${mode}`);
  }
  const temporaryProbe = fs.mkdtempSync('/tmp/ql3-owner-readonly-');
  fs.rmSync(temporaryProbe, { recursive: true });
  assertWriteRejected(`/ql3-owner-readonly-root-${process.pid}`);
  assertWriteRejected(
    path.join(repositoryRoot, `.ql3-owner-readonly-workspace-${process.pid}`),
  );
}

function main(argv = process.argv.slice(2)) {
  const modeArgument = argv.find((value) => value.startsWith('--mode='));
  const mode = modeArgument?.slice('--mode='.length);
  assertContainerBoundary(mode);
  const plan = collectReadonlyOwnerTests();
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...plan.tests],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`read-only Owner tests terminated by ${result.signal}`);
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (require.main === module) main();

module.exports = {
  HOST_BOUND_TESTS,
  collectReadonlyOwnerTests,
};
