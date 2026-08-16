'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditReleaseCandidateContract,
  createReleaseCandidateContract,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-release-candidate-contract.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const identity = Object.freeze({
  version,
  sourceRevision: 'a'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
});

test('freezes an independent low-resource local release family', () => {
  const contract = createReleaseCandidateContract({
    root,
    ...identity,
    releaseScope: 'local',
  });
  assert.deepEqual(
    contract.images.map((entry) => entry.image),
    ['local'],
  );
  assert.equal(contract.releasePlan.clusterEvidenceRequired, false);
  assert.deepEqual(contract.deploymentFamilies.local.profiles, [
    'edge',
    'standalone',
  ]);
  assert.equal(contract.workspace.packageCount, 18);
  assert.equal(
    contract.compatibility.releaseIdentitySchema,
    'qinglong/release-identity@v1',
  );
  assert.match(
    contract.compatibility.releaseIdentityDigest,
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.match(contract.contractDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(
    auditReleaseCandidateContract(contract, {
      root,
      ...identity,
      releaseScope: 'local',
    }),
    {
      compatible: true,
      contractDigest: contract.contractDigest,
      releaseScope: 'local',
      workspacePackageCount: 18,
      images: ['local'],
      clusterEvidenceRequired: false,
    },
  );
});

test('closes the cluster release family with the Worker image', () => {
  const contract = createReleaseCandidateContract({
    root,
    ...identity,
    releaseScope: 'cluster',
  });
  assert.deepEqual(
    contract.images.map((entry) => entry.image),
    ['control', 'control-ai', 'admin', 'worker'],
  );
  assert.equal(contract.releasePlan.clusterEvidenceRequired, true);
  assert.equal(contract.releasePlan.osMatrix.length, 8);
  assert.equal(
    contract.requiredGates.includes('edge-and-standalone-rollout'),
    false,
  );
  assert.equal(
    contract.requiredGates.includes('cloudnativepg-disaster-recovery-evidence'),
    true,
  );
});

test('combines local and cluster families without weakening either gate', () => {
  const contract = createReleaseCandidateContract({
    root,
    ...identity,
    releaseScope: 'all',
  });
  assert.deepEqual(
    contract.images.map((entry) => entry.image),
    ['control', 'control-ai', 'admin', 'worker', 'local'],
  );
  assert.equal(
    contract.requiredGates.includes('edge-and-standalone-rollout'),
    true,
  );
  assert.equal(
    contract.requiredGates.includes('worker-management-production-evidence'),
    true,
  );
});

test('rejects tag, version and source identity drift', () => {
  assert.throws(
    () =>
      createReleaseCandidateContract({
        root,
        ...identity,
        sourceRef: 'refs/heads/next',
        releaseScope: 'local',
      }),
    /exact version tag/,
  );
  assert.throws(
    () =>
      createReleaseCandidateContract({
        root,
        ...identity,
        version: '2.21.0',
        releaseScope: 'local',
      }),
    /QingLong 3 SemVer/,
  );
  assert.throws(
    () =>
      createReleaseCandidateContract({
        root,
        ...identity,
        sourceRevision: 'movable',
        releaseScope: 'local',
      }),
    /Git SHA-1/,
  );
  const nextVersion = `${version.slice(0, version.lastIndexOf('.') + 1)}1`;
  assert.throws(
    () =>
      createReleaseCandidateContract({
        root,
        ...identity,
        version: nextVersion,
        sourceRef: `refs/tags/v${nextVersion}`,
        releaseScope: 'local',
      }),
    /repository release identity/,
  );
});

test('rejects a source-derived report mutated after creation', () => {
  const contract = createReleaseCandidateContract({
    root,
    ...identity,
    releaseScope: 'local',
  });
  contract.releasePlan.publishMatrix[0].repository = 'unreviewed';
  assert.throws(
    () =>
      auditReleaseCandidateContract(contract, {
        root,
        ...identity,
        releaseScope: 'local',
      }),
    /differs from the source-derived contract/,
  );
});

test('writes once and independently audits the exact report through the CLI', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-candidate-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'contract.json');
  const common = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=refs/tags/v${version}`,
    '--release-scope=local',
  ];
  const output = { write() {} };
  runCli(['--mode=create', ...common, `--output=${report}`], root, output);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  assert.equal(
    runCli(['--mode=audit', ...common, `--report=${report}`], root, output)
      .compatible,
    true,
  );
  assert.throws(
    () =>
      runCli(['--mode=create', ...common, `--output=${report}`], root, output),
    /output must be unused/,
  );
});

test('parses only exact closed create and audit modes', () => {
  const common = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=refs/tags/v${version}`,
    '--release-scope=local',
  ];
  assert.equal(
    parseArguments(['--mode=create', ...common, '--output=/tmp/report.json'])
      .mode,
    'create',
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=create',
        ...common,
        '--output=/tmp/report.json',
        '--extra=true',
      ]),
    /arguments are invalid/,
  );
});
