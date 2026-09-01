'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditAlphaStageIndex,
  auditAlphaStageIndexWorkflow,
  finalizeAlphaStageIndex,
  parseArguments,
} = require('../../scripts/ql3-alpha-stage-index.cjs');
const { SUBJECTS } = require('../../scripts/ql3-cluster-alpha-milestone.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'd'.repeat(40);
const runId = '33094481420';
const runAttempt = '3';
const workflowRef =
  'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next';

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function fileRecord(filePath, name) {
  return {
    file: name,
    sha256: `sha256:${crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex')}`,
    bytes: fs.statSync(filePath).size,
  };
}

function checksums(directory) {
  return ['README.md', 'manifest.json']
    .map(
      (name) =>
        `${fileRecord(path.join(directory, name), name).sha256.slice(
          7,
        )}  ${name}`,
    )
    .join('\n')
    .concat('\n');
}

function workflow(job, attempt = runAttempt) {
  return {
    repository: 'whyour/qinglong',
    workflowRef,
    workflowSha: revision,
    event: 'workflow_dispatch',
    job,
    runId,
    runAttempt: attempt,
  };
}

function writeMilestone(directory, manifest) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'README.md'),
    `# ${manifest.product} Alpha milestone\n`,
  );
  manifest.readme = fileRecord(path.join(directory, 'README.md'), 'README.md');
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), checksums(directory));
}

function localManifest(attempt = runAttempt, variant = 'headless') {
  return {
    schemaVersion: 6,
    schema: 'qinglong/alpha-local-milestone@v6',
    maturity: 'alpha_candidate_not_public_release',
    product: 'local',
    variant,
    version,
    sourceRevision: revision,
    workflow: workflow('local-alpha-milestone', attempt),
    artifacts: {
      amd64: {
        artifactName: `ql3-alpha-${revision}-local-${variant}-amd64`,
        architecture: 'amd64',
        bundleManifest: {
          file: 'manifest.json',
          sha256: digest('1'),
          bytes: 2048,
        },
        archiveSha256: digest('2'),
        applicationImageId: digest('3'),
        operatorImageId: digest('4'),
        verificationSha256: digest('5'),
        upgradeReadinessSha256: digest('b'),
        upgradeRehearsalSha256: digest('d'),
        upgradeCutoverRehearsalSha256: digest('f'),
        upgradeReconciliationRehearsalSha256: digest('7'),
      },
      arm64: {
        artifactName: `ql3-alpha-${revision}-local-${variant}-arm64`,
        architecture: 'arm64',
        bundleManifest: {
          file: 'manifest.json',
          sha256: digest('6'),
          bytes: 2048,
        },
        archiveSha256: digest('7'),
        applicationImageId: digest('8'),
        operatorImageId: digest('9'),
        verificationSha256: digest('a'),
        upgradeReadinessSha256: digest('c'),
        upgradeRehearsalSha256: digest('e'),
        upgradeCutoverRehearsalSha256: digest('0'),
        upgradeReconciliationRehearsalSha256: digest('8'),
      },
    },
    readme: null,
  };
}

function clusterManifest(attempt = runAttempt) {
  const characters = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const artifacts = Object.fromEntries(
    SUBJECTS.map((subject, index) => {
      const architecture = subject.endsWith('-amd64') ? 'amd64' : 'arm64';
      const role = subject.slice(0, -(architecture.length + 1));
      return [
        subject,
        {
          artifactName: `ql3-alpha-${revision}-${subject}`,
          role,
          architecture,
          bundleManifest: {
            file: 'manifest.json',
            sha256: digest(characters[index]),
            bytes: 4096 + index,
          },
          archiveSha256: digest(characters[index]),
          imageId: digest(characters[index]),
          verificationSha256: digest(characters[index]),
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    schema: 'qinglong/alpha-cluster-milestone@v1',
    maturity: 'cluster_integration_candidate_not_public_release',
    product: 'cluster',
    version,
    sourceRevision: revision,
    workflow: workflow('cluster-alpha-milestone', attempt),
    artifacts,
    readme: null,
  };
}

function fixture(t, options = {}) {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-stage-index-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const localMilestoneRoot = path.join(fixtureRoot, 'local');
  const clusterMilestoneRoot = path.join(fixtureRoot, 'cluster');
  writeMilestone(
    localMilestoneRoot,
    localManifest(options.localAttempt, options.variant || 'headless'),
  );
  writeMilestone(clusterMilestoneRoot, clusterManifest(options.clusterAttempt));
  const readme = path.join(fixtureRoot, 'README-source.md');
  fs.writeFileSync(readme, '# QingLong 3.0 Alpha stage index\n');
  return {
    fixtureRoot,
    localMilestoneRoot,
    clusterMilestoneRoot,
    readme,
    outputRoot: path.join(fixtureRoot, 'stage'),
  };
}

function finalizeOptions(paths) {
  return {
    root,
    outputRoot: paths.outputRoot,
    localMilestoneRoot: paths.localMilestoneRoot,
    clusterMilestoneRoot: paths.clusterMilestoneRoot,
    readme: paths.readme,
    sourceRevision: revision,
    repository: 'whyour/qinglong',
    workflowRef,
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    runId,
    runAttempt,
  };
}

test('closes Local and Cluster milestones into one deployment-facing stage index', (t) => {
  const paths = fixture(t);
  const manifest = finalizeAlphaStageIndex(finalizeOptions(paths));
  assert.equal(manifest.schema, 'qinglong/alpha-stage-index@v2');
  assert.deepEqual(Object.keys(manifest.milestones), ['local', 'cluster']);
  assert.deepEqual(
    manifest.deploymentSelections.local.architectures.amd64.requiredArtifacts,
    [`ql3-alpha-${revision}-local-headless-amd64`],
  );
  assert.deepEqual(
    manifest.deploymentSelections.cluster.architectures.arm64.requiredArtifacts,
    [
      `ql3-alpha-${revision}-control-arm64`,
      `ql3-alpha-${revision}-admin-arm64`,
      `ql3-alpha-${revision}-worker-arm64`,
    ],
  );
  assert.deepEqual(
    manifest.deploymentSelections.cluster.architectures.arm64.optionalArtifacts,
    [`ql3-alpha-${revision}-control-ai-arm64`],
  );
  const report = auditAlphaStageIndex({
    stageRoot: paths.outputRoot,
    localMilestoneRoot: paths.localMilestoneRoot,
    clusterMilestoneRoot: paths.clusterMilestoneRoot,
  });
  assert.equal(report.compatible, true);
  assert.equal(report.artifactCount, 10);
  assert.deepEqual(report.profiles, ['edge', 'standalone', 'cluster']);
});

test('indexes the Console milestone as a distinct loopback deployment selection', (t) => {
  const paths = fixture(t, { variant: 'console' });
  const manifest = finalizeAlphaStageIndex(finalizeOptions(paths));
  assert.equal(
    manifest.milestones.local.artifactName,
    `ql3-alpha-${revision}-local-console-milestone`,
  );
  assert.equal(manifest.deploymentSelections.local.variant, 'console');
  assert.deepEqual(manifest.deploymentSelections.local.profiles, [
    'edge-application-api',
    'standalone-application-api',
  ]);
  assert.equal(
    manifest.deploymentSelections.local.intent,
    'fresh_loopback_console_non_production_trial',
  );
  const report = auditAlphaStageIndex({
    stageRoot: paths.outputRoot,
    localMilestoneRoot: paths.localMilestoneRoot,
    clusterMilestoneRoot: paths.clusterMilestoneRoot,
  });
  assert.deepEqual(report.profiles, [
    'edge-application-api',
    'standalone-application-api',
    'cluster',
  ]);
});

test('rejects Local and Cluster milestones from different workflow attempts', (t) => {
  const paths = fixture(t, { clusterAttempt: '2' });
  assert.throws(
    () => finalizeAlphaStageIndex(finalizeOptions(paths)),
    /do not belong to one workflow run/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('cross-index audit rejects stage and source milestone mutation', (t) => {
  const paths = fixture(t);
  finalizeAlphaStageIndex(finalizeOptions(paths));
  fs.appendFileSync(path.join(paths.outputRoot, 'README.md'), 'tamper\n');
  assert.throws(
    () =>
      auditAlphaStageIndex({
        stageRoot: paths.outputRoot,
        localMilestoneRoot: paths.localMilestoneRoot,
        clusterMilestoneRoot: paths.clusterMilestoneRoot,
      }),
    /README differs/,
  );
  fs.writeFileSync(path.join(paths.outputRoot, 'credential.txt'), 'secret');
  assert.throws(
    () =>
      auditAlphaStageIndex({
        stageRoot: paths.outputRoot,
        localMilestoneRoot: paths.localMilestoneRoot,
        clusterMilestoneRoot: paths.clusterMilestoneRoot,
      }),
    /file set is not closed/,
  );
});

test('workflow audit requires all scope and both milestone dependencies', () => {
  const report = auditAlphaStageIndexWorkflow(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.requiredNeeds, [
    'local-alpha-milestone',
    'cluster-alpha-milestone',
  ]);
  assert.equal(report.requiredScope, 'all');
});

test('workflow audit rejects a partial or prematurely uploaded stage index', (t) => {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-stage-workflow-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixtureRoot, '.github/workflows'), {
    recursive: true,
  });
  const source = fs
    .readFileSync(path.join(root, '.github/workflows/ql3-ci.yml'), 'utf8')
    .replace('      - cluster-alpha-milestone\n', '')
    .replace(
      "inputs.alpha_artifact_scope == 'all'",
      "inputs.alpha_artifact_scope == 'local'",
    );
  fs.writeFileSync(
    path.join(fixtureRoot, '.github/workflows/ql3-ci.yml'),
    source,
  );
  const report = auditAlphaStageIndexWorkflow(fixtureRoot);
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.includes('ALPHA_STAGE_INDEX_FINALIZER_CONTRACT_DRIFT'),
  );
});

test('workflow audit rejects a stage finalizer without installed dependencies', (t) => {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-stage-dependencies-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixtureRoot, '.github/workflows'), {
    recursive: true,
  });
  const source = fs.readFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const marker = '\n  alpha-stage-index:\n';
  const markerIndex = source.indexOf(marker);
  const workflow = `${source.slice(0, markerIndex)}${source
    .slice(markerIndex)
    .replace('pnpm install --frozen-lockfile --ignore-scripts', 'true')}`;
  fs.writeFileSync(
    path.join(fixtureRoot, '.github/workflows/ql3-ci.yml'),
    workflow,
  );
  const report = auditAlphaStageIndexWorkflow(fixtureRoot);
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.includes('ALPHA_STAGE_INDEX_FINALIZER_CONTRACT_DRIFT'),
  );
});

test('CLI grammar keeps cross-index audit explicit', () => {
  assert.deepEqual(
    parseArguments([
      '--mode=audit',
      '--stage=/tmp/stage',
      '--local-milestone=/tmp/local',
      '--cluster-milestone=/tmp/cluster',
    ]),
    {
      mode: 'audit',
      stageRoot: '/tmp/stage',
      localMilestoneRoot: '/tmp/local',
      clusterMilestoneRoot: '/tmp/cluster',
    },
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=audit',
        '--stage=/tmp/stage',
        '--local-milestone=/tmp/local',
      ]),
    /stage audit arguments are invalid/,
  );
});
