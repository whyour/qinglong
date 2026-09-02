'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditLocalAlphaTrialKit,
  createLocalAlphaTrialKit,
  createLocalAlphaTrialKitVerificationEvidence,
} = require('../../scripts/ql3-local-alpha-trial-kit-bundle.cjs');
const {
  auditLocalAlphaMilestone,
  auditLocalAlphaMilestoneWorkflow,
  finalizeLocalAlphaMilestone,
  parseArguments,
} = require('../../scripts/ql3-local-alpha-milestone.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'a'.repeat(40);
const runId = '33047425710';
const runAttempt = '2';

function imageInspection(
  role,
  architecture,
  idCharacter,
  variant = 'headless',
) {
  return {
    Id: `sha256:${idCharacter.repeat(64)}`,
    Os: 'linux',
    Architecture: architecture,
    Config: {
      User: '65532:65532',
      Labels: {
        'org.opencontainers.image.title':
          role === 'application'
            ? variant === 'console'
              ? 'QingLong 3.0 Local Console Application'
              : 'QingLong 3.0 Local Application'
            : 'QingLong 3.0 Local Operator',
        'org.opencontainers.image.source': 'https://github.com/whyour/qinglong',
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
        ...(role === 'application'
          ? {
              'io.qinglong.profile':
                variant === 'console'
                  ? 'edge-application-api,standalone-application-api'
                  : 'edge,standalone',
              'io.qinglong.ai': 'excluded',
              ...(variant === 'console'
                ? { 'io.qinglong.local.console': 'offline-loopback' }
                : {}),
            }
          : {
              'io.qinglong.lifecycle': 'short-lived',
              'io.qinglong.authority': 'local-owner-management',
              'io.qinglong.network': 'none-by-default',
            }),
      },
    },
  };
}

function createBundle(fixtureRoot, architecture, options = {}) {
  const variant = options.variant || 'headless';
  const bundleFixture = path.join(fixtureRoot, architecture);
  fs.mkdirSync(bundleFixture);
  const applicationSbom = path.join(bundleFixture, 'application.json');
  const operatorSbom = path.join(bundleFixture, 'operator.json');
  const verificationEvidence = path.join(bundleFixture, 'verification.json');
  const readme = path.join(bundleFixture, 'README-source.md');
  const outputRoot = path.join(bundleFixture, 'bundle');
  fs.writeFileSync(
    applicationSbom,
    `${JSON.stringify(
      createClusterImageSbom({
        root,
        image: variant === 'console' ? 'local-console' : 'local',
      }),
    )}\n`,
  );
  fs.writeFileSync(
    operatorSbom,
    `${JSON.stringify(
      createClusterImageSbom({ root, image: 'local-operator' }),
    )}\n`,
  );
  fs.writeFileSync(readme, '# Local Alpha Trial Kit\n');
  const defaultCharacters =
    architecture === 'amd64'
      ? { application: '1', operator: '2' }
      : { application: '3', operator: '4' };
  const characters = options.characters || defaultCharacters;
  const applicationImage = `qinglong3-local-application:test-${architecture}`;
  const operatorImage = `qinglong3-local-operator:test-${architecture}`;
  const adapters = {
    inspectImage(image) {
      const role = image.includes('operator') ? 'operator' : 'application';
      return imageInspection(role, architecture, characters[role], variant);
    },
    saveImages(images, archivePath) {
      assert.deepEqual(images, [applicationImage, operatorImage]);
      fs.writeFileSync(
        archivePath,
        Buffer.alloc(2048, architecture === 'amd64' ? 7 : 8),
        { flag: 'wx' },
      );
    },
  };
  createLocalAlphaTrialKitVerificationEvidence(
    {
      root,
      output: verificationEvidence,
      architecture,
      variant,
      sourceRevision: revision,
      applicationImage,
      operatorImage,
      repository: 'whyour/qinglong',
      workflowRef:
        'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
      workflowSha: revision,
      eventName: 'workflow_dispatch',
      job: 'local-image',
      runId,
      runAttempt: options.runAttempt || runAttempt,
    },
    adapters,
  );
  createLocalAlphaTrialKit(
    {
      root,
      outputRoot,
      architecture,
      variant,
      sourceRevision: revision,
      applicationImage,
      operatorImage,
      applicationSbom,
      operatorSbom,
      verificationEvidence,
      readme,
    },
    adapters,
  );
  assert.equal(
    auditLocalAlphaTrialKit({ bundleRoot: outputRoot }).compatible,
    true,
  );
  return outputRoot;
}

function fixture(t, options = {}) {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-alpha-milestone-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const readme = path.join(fixtureRoot, 'README-source.md');
  fs.writeFileSync(readme, '# QingLong 3.0 Local Alpha Milestone\n');
  return {
    fixtureRoot,
    readme,
    outputRoot: path.join(fixtureRoot, 'milestone'),
    bundles: {
      amd64: createBundle(fixtureRoot, 'amd64', {
        ...options.amd64,
        variant: options.variant || 'headless',
      }),
      arm64: createBundle(fixtureRoot, 'arm64', {
        ...options.arm64,
        variant: options.variant || 'headless',
      }),
    },
    variant: options.variant || 'headless',
  };
}

function finalizeOptions(paths) {
  return {
    root,
    outputRoot: paths.outputRoot,
    bundles: paths.bundles,
    readme: paths.readme,
    sourceRevision: revision,
    variant: paths.variant,
    repository: 'whyour/qinglong',
    workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    runId,
    runAttempt,
  };
}

test('finalizes two exact native trial kits into one closed milestone index', (t) => {
  const paths = fixture(t);
  const manifest = finalizeLocalAlphaMilestone(finalizeOptions(paths));
  assert.equal(manifest.schema, 'qinglong/alpha-local-milestone@v7');
  assert.match(
    manifest.artifacts.amd64.upgradeReadinessSha256,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    manifest.artifacts.amd64.upgradeRehearsalSha256,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    manifest.artifacts.amd64.upgradeCutoverRehearsalSha256,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    manifest.artifacts.amd64.upgradeReconciliationRehearsalSha256,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(manifest.variant, 'headless');
  assert.equal(manifest.sourceRevision, revision);
  assert.deepEqual(Object.keys(manifest.artifacts), ['amd64', 'arm64']);
  assert.equal(
    manifest.artifacts.amd64.artifactName,
    `ql3-alpha-${revision}-local-headless-amd64`,
  );
  assert.equal(
    manifest.artifacts.arm64.artifactName,
    `ql3-alpha-${revision}-local-headless-arm64`,
  );
  assert.notEqual(
    manifest.artifacts.amd64.archiveSha256,
    manifest.artifacts.arm64.archiveSha256,
  );
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
  ]);
  const report = auditLocalAlphaMilestone({
    milestoneRoot: paths.outputRoot,
  });
  assert.equal(report.compatible, true);
  assert.deepEqual(report.architectures, ['amd64', 'arm64']);
  assert.equal(report.workflowRunId, runId);
  assert.equal(report.workflowRunAttempt, runAttempt);
  assert.equal(report.variant, 'headless');
  assert.equal(report.schema, 'qinglong/alpha-local-milestone-audit@v7');
});

test('finalizes Console trial kits as a separately named milestone', (t) => {
  const paths = fixture(t, { variant: 'console' });
  const manifest = finalizeLocalAlphaMilestone(finalizeOptions(paths));
  assert.equal(manifest.variant, 'console');
  assert.equal(
    manifest.artifacts.amd64.artifactName,
    `ql3-alpha-${revision}-local-console-amd64`,
  );
  assert.equal(
    manifest.artifacts.arm64.artifactName,
    `ql3-alpha-${revision}-local-console-arm64`,
  );
  assert.equal(
    auditLocalAlphaMilestone({ milestoneRoot: paths.outputRoot }).variant,
    'console',
  );
});

test('keeps the shipped milestone README aligned with the current schema', () => {
  const readme = fs.readFileSync(
    path.join(root, 'docs/operations/ql3-local-alpha-milestone.md'),
    'utf8',
  );
  assert.match(readme, /qinglong\/alpha-local-milestone@v7/u);
  assert.doesNotMatch(readme, /qinglong\/alpha-local-milestone@v5/u);
  assert.match(readme, /upgradeReconciliationRehearsalSha256/u);
});

test('rejects a trial kit from another run attempt before publishing', (t) => {
  const paths = fixture(t, { arm64: { runAttempt: '1' } });
  assert.throws(
    () => finalizeLocalAlphaMilestone(finalizeOptions(paths)),
    /detached from the milestone run/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('rejects cross-architecture image or archive identity reuse', (t) => {
  const paths = fixture(t, {
    arm64: { characters: { application: '1', operator: '2' } },
  });
  assert.throws(
    () => finalizeLocalAlphaMilestone(finalizeOptions(paths)),
    /architecture subjects must be distinct/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('offline milestone audit rejects mutation and extra files', (t) => {
  const paths = fixture(t);
  finalizeLocalAlphaMilestone(finalizeOptions(paths));
  fs.appendFileSync(path.join(paths.outputRoot, 'README.md'), 'tamper\n');
  assert.throws(
    () => auditLocalAlphaMilestone({ milestoneRoot: paths.outputRoot }),
    /README differs/,
  );
  fs.writeFileSync(path.join(paths.outputRoot, 'credential.txt'), 'secret');
  assert.throws(
    () => auditLocalAlphaMilestone({ milestoneRoot: paths.outputRoot }),
    /file set is not closed/,
  );
});

test('workflow audit requires full-CI needs, scoped packaging and finalizer order', () => {
  const report = auditLocalAlphaMilestoneWorkflow(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.requiredNeeds.includes('cluster-postgres-ha'), true);
});

test('workflow audit rejects a partial milestone finalizer', (t) => {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-alpha-workflow-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixtureRoot, '.github/workflows'), {
    recursive: true,
  });
  const source = fs.readFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const marker = '\n  local-alpha-milestone:\n';
  const markerIndex = source.indexOf(marker);
  const workflow = `${source.slice(0, markerIndex)}${source
    .slice(markerIndex)
    .replace('      - cluster-postgres-ha\n', '')
    .replace(
      'scripts/ql3-local-alpha-milestone.cjs',
      'scripts/unreviewed-finalizer.cjs',
    )}`;
  fs.writeFileSync(
    path.join(fixtureRoot, '.github/workflows/ql3-ci.yml'),
    workflow,
  );
  const report = auditLocalAlphaMilestoneWorkflow(fixtureRoot);
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.includes('MILESTONE_FINALIZER_CONTRACT_DRIFT'),
    true,
  );
});

test('workflow audit rejects a finalizer without installed dependencies', (t) => {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-alpha-dependencies-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixtureRoot, '.github/workflows'), {
    recursive: true,
  });
  const source = fs.readFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const marker = '\n  local-alpha-milestone:\n';
  const markerIndex = source.indexOf(marker);
  const workflow = `${source.slice(0, markerIndex)}${source
    .slice(markerIndex)
    .replace('pnpm install --frozen-lockfile --ignore-scripts', 'true')}`;
  fs.writeFileSync(
    path.join(fixtureRoot, '.github/workflows/ql3-ci.yml'),
    workflow,
  );
  const report = auditLocalAlphaMilestoneWorkflow(fixtureRoot);
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.includes('MILESTONE_FINALIZER_CONTRACT_DRIFT'),
    true,
  );
});

test('CLI grammar separates finalization, index audit and workflow audit', () => {
  assert.deepEqual(
    parseArguments(['--mode=audit', '--milestone=/tmp/ql3-alpha-milestone']),
    {
      mode: 'audit',
      milestoneRoot: '/tmp/ql3-alpha-milestone',
    },
  );
  assert.deepEqual(
    parseArguments(['--mode=audit-workflow', `--root=${root}`]),
    { mode: 'audit-workflow', root },
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=audit',
        '--milestone=/tmp/ql3-alpha-milestone',
        '--allow-partial=true',
      ]),
    /audit arguments are invalid/,
  );
});
