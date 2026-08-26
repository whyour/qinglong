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
  parseArguments,
} = require('../../scripts/ql3-local-alpha-trial-kit-bundle.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'a'.repeat(40);

function imageInspection(
  role,
  idCharacter = role === 'application' ? '1' : '2',
) {
  return {
    Id: `sha256:${idCharacter.repeat(64)}`,
    Os: 'linux',
    Architecture: 'arm64',
    Config: {
      User: '65532:65532',
      Labels: {
        'org.opencontainers.image.title':
          role === 'application'
            ? 'QingLong 3.0 Local Application'
            : 'QingLong 3.0 Local Operator',
        'org.opencontainers.image.source': 'https://github.com/whyour/qinglong',
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
        ...(role === 'application'
          ? {
              'io.qinglong.profile': 'edge,standalone',
              'io.qinglong.ai': 'excluded',
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

function fixture(t) {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-alpha-bundle-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const applicationSbom = path.join(fixtureRoot, 'application.json');
  const operatorSbom = path.join(fixtureRoot, 'operator.json');
  const verificationEvidence = path.join(
    fixtureRoot,
    'verification-evidence-source.json',
  );
  const readme = path.join(fixtureRoot, 'README-source.md');
  fs.writeFileSync(
    applicationSbom,
    `${JSON.stringify(createClusterImageSbom({ root, image: 'local' }))}\n`,
  );
  fs.writeFileSync(
    operatorSbom,
    `${JSON.stringify(
      createClusterImageSbom({ root, image: 'local-operator' }),
    )}\n`,
  );
  fs.writeFileSync(readme, '# Local Alpha Trial Kit\n');
  const paths = {
    fixtureRoot,
    applicationSbom,
    operatorSbom,
    verificationEvidence,
    readme,
    outputRoot: path.join(fixtureRoot, 'bundle'),
  };
  createLocalAlphaTrialKitVerificationEvidence(
    verificationOptions(paths),
    adapters(),
  );
  return paths;
}

function verificationOptions(paths, overrides = {}) {
  return {
    root,
    output: paths.verificationEvidence,
    architecture: 'arm64',
    sourceRevision: revision,
    applicationImage: 'qinglong3-local-application:test-arm64',
    operatorImage: 'qinglong3-local-operator:test-arm64',
    repository: 'whyour/qinglong',
    workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    job: 'local-image',
    runId: '32990652047',
    runAttempt: '1',
    ...overrides,
  };
}

function createOptions(paths) {
  return {
    root,
    outputRoot: paths.outputRoot,
    architecture: 'arm64',
    sourceRevision: revision,
    applicationImage: 'qinglong3-local-application:test-arm64',
    operatorImage: 'qinglong3-local-operator:test-arm64',
    applicationSbom: paths.applicationSbom,
    operatorSbom: paths.operatorSbom,
    verificationEvidence: paths.verificationEvidence,
    readme: paths.readme,
  };
}

function adapters(overrides = {}) {
  return {
    inspectImage(image) {
      return image.includes('operator')
        ? imageInspection('operator')
        : imageInspection('application');
    },
    saveImages(images, archivePath) {
      assert.deepEqual(images, [
        'qinglong3-local-application:test-arm64',
        'qinglong3-local-operator:test-arm64',
      ]);
      fs.writeFileSync(archivePath, Buffer.alloc(2048, 7), { flag: 'wx' });
    },
    ...overrides,
  };
}

test('materializes and offline-audits one closed two-image trial kit', (t) => {
  const paths = fixture(t);
  const manifest = createLocalAlphaTrialKit(createOptions(paths), adapters());
  assert.equal(manifest.schema, 'qinglong/alpha-local-trial-kit@v2');
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.architecture, 'arm64');
  assert.equal(manifest.images.application.architecture, 'arm64');
  assert.equal(manifest.images.operator.architecture, 'arm64');
  assert.notEqual(manifest.images.application.id, manifest.images.operator.id);
  assert.equal(manifest.verification.file, 'verification-evidence.json');
  const report = auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot });
  assert.equal(report.compatible, true);
  assert.equal(report.sourceRevision, revision);
  assert.equal(report.workflowRunId, '32990652047');
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
    'qinglong3-local-application.cdx.json',
    'qinglong3-local-operator.cdx.json',
    'qinglong3-local-trial-kit-arm64.docker.tar',
    'verification-evidence.json',
  ]);
});

test('fails closed and removes a partial output on incompatible image identity', (t) => {
  const paths = fixture(t);
  const options = createOptions(paths);
  assert.throws(
    () =>
      createLocalAlphaTrialKit(
        options,
        adapters({
          inspectImage(image) {
            const inspection = image.includes('operator')
              ? imageInspection('operator')
              : imageInspection('application');
            inspection.Config.Labels['org.opencontainers.image.revision'] =
              'b'.repeat(40);
            return inspection;
          },
        }),
      ),
    /image identity is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('offline audit rejects archive, file-set, SBOM and verification mutation', (t) => {
  for (const mutation of ['archive', 'extra', 'sbom', 'verification']) {
    const paths = fixture(t);
    paths.outputRoot = path.join(paths.fixtureRoot, `bundle-${mutation}`);
    createLocalAlphaTrialKit(createOptions(paths), adapters());
    if (mutation === 'archive') {
      fs.appendFileSync(
        path.join(
          paths.outputRoot,
          'qinglong3-local-trial-kit-arm64.docker.tar',
        ),
        'tamper',
      );
    } else if (mutation === 'extra') {
      fs.writeFileSync(path.join(paths.outputRoot, 'credential.txt'), 'secret');
    } else if (mutation === 'sbom') {
      fs.copyFileSync(
        path.join(paths.outputRoot, 'qinglong3-local-application.cdx.json'),
        path.join(paths.outputRoot, 'qinglong3-local-operator.cdx.json'),
      );
    } else {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'verification-evidence.json'),
        'tamper',
      );
    }
    assert.throws(
      () => auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot }),
      /differs|not closed|incompatible/,
      mutation,
    );
  }
});

test('create rejects verification detached from the reviewed workflow', (t) => {
  const paths = fixture(t);
  const evidence = JSON.parse(
    fs.readFileSync(paths.verificationEvidence, 'utf8'),
  );
  evidence.workflow.job = 'unreviewed-job';
  fs.writeFileSync(paths.verificationEvidence, `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => createLocalAlphaTrialKit(createOptions(paths), adapters()),
    /verification evidence is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('verification recorder rejects non-milestone workflow provenance', (t) => {
  const paths = fixture(t);
  const output = path.join(paths.fixtureRoot, 'unreviewed-verification.json');
  assert.throws(
    () =>
      createLocalAlphaTrialKitVerificationEvidence(
        verificationOptions(paths, { output, eventName: 'push' }),
        adapters(),
      ),
    /verification evidence identity or output is invalid/,
  );
  assert.equal(fs.existsSync(output), false);
});

test('CLI grammar is exact and separates create from offline audit', () => {
  assert.deepEqual(
    parseArguments(['--mode=audit', '--bundle=/tmp/ql3-bundle']),
    { mode: 'audit', bundleRoot: '/tmp/ql3-bundle' },
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=audit',
        '--bundle=/tmp/ql3-bundle',
        '--allow-extra=true',
      ]),
    /audit arguments are invalid/,
  );
  assert.throws(
    () => parseArguments(['--mode=create', '--output=/tmp/output']),
    /create arguments are invalid/,
  );
  const recorded = parseArguments([
    '--mode=record-verification',
    '--application-image=qinglong3-local-application:test-arm64',
    '--operator-image=qinglong3-local-operator:test-arm64',
    '--architecture=arm64',
    `--source-revision=${revision}`,
    '--repository=whyour/qinglong',
    '--workflow-ref=whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    `--workflow-sha=${revision}`,
    '--event=workflow_dispatch',
    '--job=local-image',
    '--run-id=32990652047',
    '--run-attempt=1',
    '--output=/tmp/verification-evidence.json',
  ]);
  assert.equal(recorded.mode, 'record-verification');
  assert.equal(recorded.runId, '32990652047');
});
