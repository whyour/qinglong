'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ROLES,
  auditClusterAlphaBundle,
  createClusterAlphaBundle,
  createClusterAlphaVerificationEvidence,
} = require('../../scripts/ql3-cluster-alpha-bundle.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'a'.repeat(40);

function inspection(role, architecture = 'arm64', idCharacter = '7') {
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

function fixture(t, role = 'admin') {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-alpha-bundle-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const paths = {
    fixtureRoot,
    sbom: path.join(fixtureRoot, 'source.cdx.json'),
    evidence: path.join(fixtureRoot, 'source-verification.json'),
    readme: path.join(fixtureRoot, 'source-README.md'),
    outputRoot: path.join(fixtureRoot, 'bundle'),
  };
  fs.writeFileSync(
    paths.sbom,
    `${JSON.stringify(createClusterImageSbom({ root, image: role }))}\n`,
  );
  fs.writeFileSync(paths.readme, '# Cluster integration candidate\n');
  createClusterAlphaVerificationEvidence(
    verificationOptions(paths, role),
    adapters(role),
  );
  return paths;
}

function verificationOptions(paths, role = 'admin', overrides = {}) {
  return {
    root,
    output: paths.evidence,
    role,
    architecture: 'arm64',
    image: `${ROLES[role].repository}:ci-arm64`,
    sourceRevision: revision,
    repository: 'whyour/qinglong',
    workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    job: 'cluster-image',
    runId: '33073349397',
    runAttempt: '2',
    ...overrides,
  };
}

function createOptions(paths, role = 'admin') {
  return {
    root,
    outputRoot: paths.outputRoot,
    role,
    architecture: 'arm64',
    image: `${ROLES[role].repository}:ci-arm64`,
    sourceRevision: revision,
    sbom: paths.sbom,
    verificationEvidence: paths.evidence,
    readme: paths.readme,
  };
}

function adapters(role = 'admin', overrides = {}) {
  return {
    inspectImage() {
      return inspection(role);
    },
    saveImage(image, archivePath) {
      assert.equal(image, `${ROLES[role].repository}:ci-arm64`);
      fs.writeFileSync(archivePath, Buffer.alloc(2048, 9), { flag: 'wx' });
    },
    ...overrides,
  };
}

test('materializes and offline-audits one closed Cluster image bundle', (t) => {
  const paths = fixture(t);
  const manifest = createClusterAlphaBundle(createOptions(paths), adapters());
  assert.equal(manifest.schema, 'qinglong/alpha-cluster-image@v1');
  assert.equal(
    manifest.maturity,
    'cluster_integration_candidate_not_public_release',
  );
  assert.equal(manifest.role, 'admin');
  assert.equal(manifest.image.user, '10001:10001');
  assert.equal(manifest.verification.file, 'verification-evidence.json');
  const report = auditClusterAlphaBundle({ bundleRoot: paths.outputRoot });
  assert.equal(report.compatible, true);
  assert.equal(report.workflowRunId, '33073349397');
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
    'qinglong3-cluster-admin-arm64.docker.tar',
    'qinglong3-cluster-admin.cdx.json',
    'verification-evidence.json',
  ]);
});

test('binds verification evidence to role, architecture, image and exact CI run', (t) => {
  const paths = fixture(t, 'worker');
  const evidence = JSON.parse(fs.readFileSync(paths.evidence, 'utf8'));
  assert.deepEqual(evidence.subject, {
    version,
    sourceRevision: revision,
    role: 'worker',
    architecture: 'arm64',
    imageId: `sha256:${'7'.repeat(64)}`,
  });
  assert.equal(evidence.workflow.job, 'cluster-image');
  assert.equal(evidence.gates.clusterAdminProductFacade, 'not_applicable');
});

test('fails closed before output on incompatible image identity', (t) => {
  const paths = fixture(t);
  assert.throws(
    () =>
      createClusterAlphaBundle(
        createOptions(paths),
        adapters('admin', {
          inspectImage() {
            const value = inspection('admin');
            value.Config.User = '0:0';
            return value;
          },
        }),
      ),
    /image identity is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('offline audit rejects archive, file-set, SBOM and evidence mutations', (t) => {
  for (const mutation of ['archive', 'extra', 'sbom', 'evidence']) {
    const paths = fixture(t);
    paths.outputRoot = path.join(paths.fixtureRoot, `bundle-${mutation}`);
    createClusterAlphaBundle(createOptions(paths), adapters());
    if (mutation === 'archive') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'qinglong3-cluster-admin-arm64.docker.tar'),
        'tamper',
      );
    } else if (mutation === 'extra') {
      fs.writeFileSync(path.join(paths.outputRoot, 'credential.txt'), 'secret');
    } else if (mutation === 'sbom') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'qinglong3-cluster-admin.cdx.json'),
        'tamper',
      );
    } else {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'verification-evidence.json'),
        'tamper',
      );
    }
    assert.throws(() =>
      auditClusterAlphaBundle({ bundleRoot: paths.outputRoot }),
    );
  }
});

test('rejects verification detached from the inspected image subject', (t) => {
  const paths = fixture(t);
  const evidence = JSON.parse(fs.readFileSync(paths.evidence, 'utf8'));
  evidence.subject.imageId = `sha256:${'8'.repeat(64)}`;
  fs.writeFileSync(paths.evidence, `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => createClusterAlphaBundle(createOptions(paths), adapters()),
    /verification evidence is incompatible/,
  );
});
