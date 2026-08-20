'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const semver = require('semver');
const {
  CONTAINER_ROOTS,
  DEPLOYMENT_FILES,
  DEPLOYMENT_ROOTS,
  applyVersionTransitionPlan,
  auditReleaseVersionContract,
  createVersionTransitionPlan,
  parseArguments,
  runCli,
  validatePlan,
} = require('../../scripts/ql3-version-transition.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const SOURCE_VERSION = readReleaseIdentity(root).version;
const TARGET_VERSION = semver.inc(SOURCE_VERSION, 'prerelease');
const LEGACY_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json')),
).version;

function copyFile(sourceRoot, targetRoot, relativePath) {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

function createFixture(t) {
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-version-')),
  );
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyFile(root, fixture, 'package.json');
  copyFile(root, fixture, 'ql3-release.json');
  for (const entry of fs.readdirSync(path.join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && entry.name.startsWith('ql3-')) {
      copyFile(root, fixture, `packages/${entry.name}/package.json`);
    }
  }
  for (const containerRoot of CONTAINER_ROOTS) {
    for (const relativePath of [
      'Dockerfile',
      'package.json',
      'package-lock.json',
      'runtime-dependencies/package.json',
      'runtime-dependencies/package-lock.json',
    ]) {
      copyFile(root, fixture, `${containerRoot}/${relativePath}`);
    }
  }
  for (const deploymentRoot of DEPLOYMENT_ROOTS) {
    fs.cpSync(
      path.join(root, deploymentRoot),
      path.join(fixture, deploymentRoot),
      { recursive: true, dereference: false },
    );
  }
  for (const relativePath of DEPLOYMENT_FILES) {
    copyFile(root, fixture, relativePath);
  }
  return fixture;
}

function replaceVersion(
  filePath,
  source = SOURCE_VERSION,
  target = TARGET_VERSION,
) {
  const contents = fs.readFileSync(filePath, 'utf8');
  assert.equal(contents.includes(source), true);
  fs.writeFileSync(filePath, contents.split(source).join(target));
}

test('audits one source-derived QingLong 3 release identity', () => {
  assert.deepEqual(auditReleaseVersionContract(root), {
    schemaVersion: 2,
    schema: 'qinglong/release-identity@v2',
    version: SOURCE_VERSION,
    nodeVersion: '24.18.0',
    nodeEngine: '>=24.18.0 <25',
    architectureSupport: {
      tier1: ['amd64', 'arm64'],
      candidates: ['ppc64le', 's390x'],
      experimentalBlocked: ['arm/v7'],
      legacyOnly: ['arm/v6', '386'],
      legacyLine: '2.x',
    },
    legacyRootPackageVersion: LEGACY_VERSION,
    legacyRootExcluded: true,
    workspacePackageCount: 18,
    containerRootCount: 4,
    deploymentFileCount: 242,
    deploymentImageReferences: 32,
    deploymentVersionOccurrences: 36,
    compatible: true,
  });
});

test('plans the exact governed version surface without touching legacy 2.x', () => {
  const plan = createVersionTransitionPlan({
    root,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
  });
  assert.equal(plan.fileCount, 65);
  assert.equal(plan.replacementCount, 83);
  assert.equal(plan.legacyRootPackageVersion, LEGACY_VERSION);
  assert.equal(plan.legacyRootExcluded, true);
  assert.equal(
    plan.entries.some((entry) => entry.path === 'package.json'),
    false,
  );
  assert.equal(
    plan.entries.filter((entry) => entry.path.startsWith('packages/')).length,
    18,
  );
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(validatePlan(plan), plan);
});

test('applies and exactly replays a complete version transition', (t) => {
  const fixture = createFixture(t);
  const plan = createVersionTransitionPlan({
    root: fixture,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
  });
  const report = applyVersionTransitionPlan(plan, {
    root: fixture,
    report: path.join(fixture, 'first-report.json'),
  });
  assert.equal(report.changedFiles, plan.fileCount);
  assert.equal(report.alreadyCurrentFiles, 0);
  assert.equal(report.exactReplay, false);
  assert.equal(auditReleaseVersionContract(fixture).version, TARGET_VERSION);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'))).version,
    LEGACY_VERSION,
  );

  const replay = applyVersionTransitionPlan(plan, {
    root: fixture,
    report: path.join(fixture, 'replay-report.json'),
  });
  assert.equal(replay.changedFiles, 0);
  assert.equal(replay.alreadyCurrentFiles, plan.fileCount);
  assert.equal(replay.exactReplay, true);
});

test('resumes a partial transition using before and after digests', (t) => {
  const fixture = createFixture(t);
  const plan = createVersionTransitionPlan({
    root: fixture,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
  });
  replaceVersion(path.join(fixture, 'ql3-release.json'));
  const report = applyVersionTransitionPlan(plan, {
    root: fixture,
    report: path.join(fixture, 'recovered-report.json'),
  });
  assert.equal(report.changedFiles, plan.fileCount - 1);
  assert.equal(report.alreadyCurrentFiles, 1);
  assert.equal(auditReleaseVersionContract(fixture).version, TARGET_VERSION);
});

test('preflights every governed file before making a partial mutation', (t) => {
  const fixture = createFixture(t);
  const plan = createVersionTransitionPlan({
    root: fixture,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
  });
  const drifted = path.join(fixture, plan.entries.at(-1).path);
  fs.appendFileSync(drifted, '\n');
  assert.throws(
    () =>
      applyVersionTransitionPlan(plan, {
        root: fixture,
        report: path.join(fixture, 'must-not-exist.json'),
      }),
    /drifted after plan creation/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture, 'ql3-release.json'))).version,
    SOURCE_VERSION,
  );
  assert.equal(fs.existsSync(path.join(fixture, 'must-not-exist.json')), false);
});

test('rejects invalid SemVer, downgrade, plan mutation and a symbolic-link identity', (t) => {
  assert.throws(
    () =>
      createVersionTransitionPlan({
        root,
        sourceVersion: SOURCE_VERSION,
        targetVersion: '3.0.0-alpha',
      }),
    /monotonically newer/,
  );
  const plan = createVersionTransitionPlan({
    root,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
  });
  const mutatedPlan = JSON.parse(JSON.stringify(plan));
  mutatedPlan.entries[0].path = 'package.json';
  assert.throws(() => validatePlan(mutatedPlan), /plan entry is invalid/);

  const fixture = createFixture(t);
  const invalidIdentityPath = path.join(fixture, 'ql3-release.json');
  const invalidIdentity = JSON.parse(fs.readFileSync(invalidIdentityPath));
  invalidIdentity.version = '3.0.0-alpha.01';
  fs.writeFileSync(
    invalidIdentityPath,
    `${JSON.stringify(invalidIdentity, null, 2)}\n`,
  );
  assert.throws(
    () => auditReleaseVersionContract(fixture),
    /identity shape or value is incompatible/,
  );
  copyFile(root, fixture, 'ql3-release.json');
  const architectureDrift = JSON.parse(
    fs.readFileSync(invalidIdentityPath, 'utf8'),
  );
  architectureDrift.architectureSupport.tier1.push('ppc64le');
  fs.writeFileSync(
    invalidIdentityPath,
    `${JSON.stringify(architectureDrift, null, 2)}\n`,
  );
  assert.throws(
    () => auditReleaseVersionContract(fixture),
    /identity shape or value is incompatible/,
  );
  copyFile(root, fixture, 'ql3-release.json');
  fs.renameSync(
    path.join(fixture, 'ql3-release.json'),
    path.join(fixture, 'identity-target.json'),
  );
  fs.symlinkSync(
    'identity-target.json',
    path.join(fixture, 'ql3-release.json'),
  );
  assert.throws(
    () => auditReleaseVersionContract(fixture),
    /canonical regular file/,
  );
});

test('CLI writes no-replace plans and accepts only closed modes', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-version-cli-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, 'plan.json');
  const output = { write() {} };
  runCli(
    [
      '--mode=plan',
      `--from=${SOURCE_VERSION}`,
      `--to=${TARGET_VERSION}`,
      `--output=${planPath}`,
    ],
    root,
    output,
  );
  assert.equal(fs.statSync(planPath).mode & 0o777, 0o600);
  assert.throws(
    () =>
      runCli(
        [
          '--mode=plan',
          `--from=${SOURCE_VERSION}`,
          `--to=${TARGET_VERSION}`,
          `--output=${planPath}`,
        ],
        root,
        output,
      ),
    /output must be unused/,
  );
  assert.deepEqual(parseArguments(['--mode=audit']), { mode: 'audit' });
  assert.throws(
    () => parseArguments(['--mode=audit', '--extra=true']),
    /arguments are invalid/,
  );
});
