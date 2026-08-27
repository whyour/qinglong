'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ROLES,
  createClusterAlphaBundle,
  createClusterAlphaVerificationEvidence,
} = require('../../scripts/ql3-cluster-alpha-bundle.cjs');
const {
  SUBJECTS,
  auditClusterAlphaMilestone,
  auditClusterAlphaMilestoneWorkflow,
  finalizeClusterAlphaMilestone,
} = require('../../scripts/ql3-cluster-alpha-milestone.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'b'.repeat(40);
const workflowRef =
  'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next';

function splitSubject(subject) {
  const architecture = subject.endsWith('-amd64') ? 'amd64' : 'arm64';
  return { role: subject.slice(0, -(architecture.length + 1)), architecture };
}

function inspection(role, architecture, idCharacter) {
  const config = ROLES[role];
  return {
    Id: `sha256:${idCharacter.repeat(64)}`,
    Os: 'linux',
    Architecture: architecture,
    Config: {
      User: config.user,
      Labels: {
        'org.opencontainers.image.title': config.title,
        'org.opencontainers.image.source': 'https://github.com/whyour/qinglong',
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
      },
    },
  };
}

function fixture(t, runId = '33073349397') {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-alpha-milestone-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const readme = path.join(fixtureRoot, 'README-source.md');
  fs.writeFileSync(readme, '# Cluster Alpha milestone\n');
  const sboms = {};
  for (const role of Object.keys(ROLES)) {
    sboms[role] = path.join(fixtureRoot, `${role}.cdx.json`);
    fs.writeFileSync(
      sboms[role],
      `${JSON.stringify(createClusterImageSbom({ root, image: role }))}\n`,
    );
  }
  const bundles = {};
  SUBJECTS.forEach((subject, index) => {
    const { role, architecture } = splitSubject(subject);
    const idCharacter = String(index + 1);
    const evidence = path.join(fixtureRoot, `${subject}-verification.json`);
    const image = `${ROLES[role].repository}:ci-${architecture}`;
    const inspectImage = () => inspection(role, architecture, idCharacter);
    createClusterAlphaVerificationEvidence(
      {
        root,
        output: evidence,
        role,
        architecture,
        image,
        sourceRevision: revision,
        repository: 'whyour/qinglong',
        workflowRef,
        workflowSha: revision,
        eventName: 'workflow_dispatch',
        job: 'cluster-image',
        runId,
        runAttempt: '2',
      },
      { inspectImage },
    );
    bundles[subject] = path.join(fixtureRoot, subject);
    createClusterAlphaBundle(
      {
        root,
        outputRoot: bundles[subject],
        role,
        architecture,
        image,
        sourceRevision: revision,
        sbom: sboms[role],
        verificationEvidence: evidence,
        readme,
      },
      {
        inspectImage,
        saveImage(_reference, archivePath) {
          fs.writeFileSync(archivePath, Buffer.alloc(2048, index + 1), {
            flag: 'wx',
          });
        },
      },
    );
  });
  return {
    fixtureRoot,
    bundles,
    readme,
    outputRoot: path.join(fixtureRoot, 'milestone'),
  };
}

function finalizeOptions(paths, overrides = {}) {
  return {
    root,
    outputRoot: paths.outputRoot,
    bundles: paths.bundles,
    readme: paths.readme,
    sourceRevision: revision,
    repository: 'whyour/qinglong',
    workflowRef,
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    runId: '33073349397',
    runAttempt: '2',
    ...overrides,
  };
}

test('closes eight role/architecture bundles into one offline-verifiable index', (t) => {
  const paths = fixture(t);
  const manifest = finalizeClusterAlphaMilestone(finalizeOptions(paths));
  assert.equal(manifest.schema, 'qinglong/alpha-cluster-milestone@v1');
  assert.equal(Object.keys(manifest.artifacts).length, 8);
  assert.deepEqual(Object.keys(manifest.artifacts), SUBJECTS);
  assert.equal(
    new Set(Object.values(manifest.artifacts).map((entry) => entry.imageId))
      .size,
    8,
  );
  const report = auditClusterAlphaMilestone({
    milestoneRoot: paths.outputRoot,
  });
  assert.equal(report.compatible, true);
  assert.deepEqual(report.subjects, SUBJECTS);
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
  ]);
});

test('rejects one bundle detached from the authorized workflow run', (t) => {
  const paths = fixture(t, '33073349398');
  assert.throws(
    () => finalizeClusterAlphaMilestone(finalizeOptions(paths)),
    /detached from the Cluster milestone run/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('offline milestone audit rejects index and file-set mutation', (t) => {
  for (const mutation of ['manifest', 'extra']) {
    const paths = fixture(t);
    paths.outputRoot = path.join(paths.fixtureRoot, `milestone-${mutation}`);
    finalizeClusterAlphaMilestone(finalizeOptions(paths));
    if (mutation === 'manifest') {
      fs.appendFileSync(path.join(paths.outputRoot, 'manifest.json'), 'tamper');
    } else {
      fs.writeFileSync(path.join(paths.outputRoot, 'secret.txt'), 'secret');
    }
    assert.throws(() =>
      auditClusterAlphaMilestone({ milestoneRoot: paths.outputRoot }),
    );
  }
});

test('workflow audit proves full CI closure before milestone upload', () => {
  const report = auditClusterAlphaMilestoneWorkflow(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.requiredNeeds.length, 19);
  assert.deepEqual(report.subjects, SUBJECTS);
});

test('workflow audit rejects missing final offline audit', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-cluster-alpha-workflow-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const workflowDirectory = path.join(fixtureRoot, '.github/workflows');
  fs.mkdirSync(workflowDirectory, { recursive: true });
  const source = fs
    .readFileSync(path.join(root, '.github/workflows/ql3-ci.yml'), 'utf8')
    .replace(
      'node scripts/ql3-cluster-alpha-milestone.cjs \\\n            --mode=audit',
      'node scripts/ql3-cluster-alpha-milestone.cjs \\\n            --mode=inspect',
    );
  fs.writeFileSync(path.join(workflowDirectory, 'ql3-ci.yml'), source);
  const report = auditClusterAlphaMilestoneWorkflow(fixtureRoot);
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.includes('CLUSTER_MILESTONE_FINALIZER_CONTRACT_DRIFT'),
  );
});
