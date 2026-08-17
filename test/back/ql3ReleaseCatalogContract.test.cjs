'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ARTIFACT_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  auditCatalogPlan,
  auditCatalogReceipt,
  createCatalogPlan,
  createCatalogReceipt,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-release-catalog-contract.cjs');
const {
  createReleaseSet,
  createVerifiedImageRecord,
} = require('../../scripts/ql3-release-set-contract.cjs');
const {
  createReleaseCandidateContract,
} = require('../../scripts/ql3-release-candidate-contract.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');
const {
  privateReleaseEvidenceReceipts,
} = require('./ql3ReleaseEvidenceFixture.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const identity = Object.freeze({
  version,
  sourceRevision: 'd'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
  repositoryOwner: 'qinglong-release',
  sourceRepository: 'qinglong-release/qinglong',
});

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function releaseSet(scope) {
  const candidate = createReleaseCandidateContract({
    root,
    version,
    sourceRevision: identity.sourceRevision,
    sourceRef: identity.sourceRef,
    releaseScope: scope,
  });
  const records = candidate.images.map((entry, index) =>
    createVerifiedImageRecord({
      root,
      candidate,
      ...identity,
      releaseScope: scope,
      image: entry.image,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    }),
  );
  return createReleaseSet({
    root,
    candidate,
    records,
    evidenceReceipts: privateReleaseEvidenceReceipts(candidate.release),
    ...identity,
    validationClockMs: Date.parse('2026-08-18T00:05:00.000Z'),
    releaseScope: scope,
  });
}

function manifestFor(plan, mutate = () => {}) {
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: {
      mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
      digest: OCI_EMPTY_CONFIG_DIGEST,
      size: 2,
    },
    layers: [
      {
        mediaType: ARTIFACT_TYPE,
        digest: plan.releaseSet.contentDigest,
        size: plan.releaseSet.bytes,
        annotations: {
          'org.opencontainers.image.title': plan.releaseSet.fileName,
        },
      },
    ],
    annotations: { ...plan.catalog.annotations },
  };
  mutate(manifest);
  return JSON.stringify(manifest);
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-catalog-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test('plans deterministic Local, Cluster and All OCI catalog entries', () => {
  for (const scope of ['local', 'cluster', 'all']) {
    const set = releaseSet(scope);
    const plan = createCatalogPlan(set, { ...identity, releaseScope: scope });
    assert.equal(
      plan.catalog.discoveryTag,
      `ghcr.io/qinglong-release/qinglong3-release-catalog:v${version}-${scope}`,
    );
    assert.equal(plan.catalog.artifactType, ARTIFACT_TYPE);
    assert.equal(
      plan.publicationPolicy.recovery,
      'republish_deterministic_content_then_verify_digest',
    );
    assert.equal(
      plan.releaseSet.bytes,
      Buffer.byteLength(`${JSON.stringify(set)}\n`),
    );
    assert.equal(
      auditCatalogPlan(plan, set, { ...identity, releaseScope: scope })
        .planDigest,
      plan.planDigest,
    );
  }
});

test('creates one digest-addressed receipt from the exact OCI manifest', () => {
  const set = releaseSet('cluster');
  const plan = createCatalogPlan(set, {
    ...identity,
    releaseScope: 'cluster',
  });
  const manifest = manifestFor(plan);
  const manifestDigest = sha256(manifest);
  const receipt = createCatalogReceipt(plan, manifest, manifestDigest);
  assert.equal(
    receipt.catalog.immutableReference,
    `ghcr.io/qinglong-release/qinglong3-release-catalog@${manifestDigest}`,
  );
  assert.equal(receipt.verification.discoveryTagAuthority, 'none');
  assert.equal(
    auditCatalogReceipt(receipt, plan, manifest, manifestDigest).compatible,
    true,
  );
});

test('rejects source ownership, mutable identity and release-set drift', () => {
  const set = releaseSet('local');
  assert.throws(
    () =>
      createCatalogPlan(set, {
        ...identity,
        sourceRepository: 'other/qinglong',
        releaseScope: 'local',
      }),
    /owned by the publisher/,
  );
  assert.throws(
    () =>
      createCatalogPlan(set, {
        ...identity,
        version: '3.0.0',
        sourceRef: 'refs/tags/v3.0.0',
        releaseScope: 'local',
      }),
    /standalone release set/,
  );
  const drifted = JSON.parse(JSON.stringify(set));
  drifted.images[0].reference = 'ghcr.io/other/image@sha256:' + '1'.repeat(64);
  assert.throws(
    () => createCatalogPlan(drifted, { ...identity, releaseScope: 'local' }),
    /standalone release set/,
  );
});

test('rejects OCI media, blob, title, annotation and raw digest drift', () => {
  const set = releaseSet('local');
  const plan = createCatalogPlan(set, { ...identity, releaseScope: 'local' });
  for (const mutate of [
    (value) => {
      value.mediaType = 'application/json';
    },
    (value) => {
      value.layers[0].digest = `sha256:${'0'.repeat(64)}`;
    },
    (value) => {
      value.layers[0].annotations['org.opencontainers.image.title'] =
        '/tmp/release-set.json';
    },
    (value) => {
      value.annotations['dev.qinglong.release.scope'] = 'all';
    },
  ]) {
    const manifest = manifestFor(plan, mutate);
    assert.throws(
      () => createCatalogReceipt(plan, manifest, sha256(manifest)),
      /manifest differs/,
    );
  }
  const manifest = manifestFor(plan);
  assert.throws(
    () => createCatalogReceipt(plan, manifest, `sha256:${'0'.repeat(64)}`),
    /manifest digest is invalid/,
  );
});

test('CLI plans, receipts and audits canonical no-replace evidence', (t) => {
  const directory = temporaryDirectory(t);
  const set = releaseSet('local');
  const setPath = path.join(
    directory,
    `qinglong3-release-set-${version}-local.json`,
  );
  writeCanonical(setPath, set);
  const planPath = path.join(directory, 'plan.json');
  const planArgs = [
    '--mode=plan',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--release-set=${setPath}`,
    `--output=${planPath}`,
  ];
  const output = { write() {} };
  const plan = runCli(planArgs, output);
  assert.equal(fs.statSync(planPath).mode & 0o777, 0o600);
  const manifest = manifestFor(plan);
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, manifest, { mode: 0o600 });
  const manifestDigest = sha256(manifest);
  const receiptPath = path.join(directory, 'receipt.json');
  runCli(
    [
      '--mode=receipt',
      `--plan=${planPath}`,
      `--manifest=${manifestPath}`,
      `--manifest-digest=${manifestDigest}`,
      `--output=${receiptPath}`,
    ],
    output,
  );
  assert.equal(
    runCli(
      [
        '--mode=audit',
        `--plan=${planPath}`,
        `--manifest=${manifestPath}`,
        `--manifest-digest=${manifestDigest}`,
        `--receipt=${receiptPath}`,
      ],
      output,
    ).compatible,
    true,
  );
  assert.throws(() => runCli(planArgs, output), /output must be unused/);
});

test('CLI rejects renamed inputs, symlinks and open modes', (t) => {
  const directory = temporaryDirectory(t);
  const renamed = path.join(directory, 'set.json');
  writeCanonical(renamed, releaseSet('local'));
  const args = [
    '--mode=plan',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--release-set=${renamed}`,
    `--output=${path.join(directory, 'plan.json')}`,
  ];
  assert.throws(
    () => runCli(args, { write() {} }),
    /filename must be deterministic/,
  );
  const target = path.join(directory, 'target.json');
  fs.renameSync(renamed, target);
  fs.symlinkSync('target.json', renamed);
  assert.throws(() => runCli(args, { write() {} }), /canonical regular file/);
  assert.throws(
    () => parseArguments(['--mode=publish', '--extra=true']),
    /arguments are invalid/,
  );
});
