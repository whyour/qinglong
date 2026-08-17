'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CLOSURE_RECEIPT_SCHEMA,
  PUBLICATION_PLAN_SCHEMA,
  TAG_OBSERVATION_SCHEMA,
  auditClosureReceipt,
  createClosureReceipt,
  createPublicationPlan,
  createPublicationTagObservation,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-release-publication-closure-contract.cjs');
const {
  ARTIFACT_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  createCatalogPlan,
  createCatalogReceipt,
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
  sourceRevision: 'e'.repeat(40),
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

function manifestFor(plan) {
  return JSON.stringify({
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
  });
}

function fixture(scope = 'all') {
  const set = releaseSet(scope);
  const options = { ...identity, releaseScope: scope };
  const catalogPlan = createCatalogPlan(set, options);
  const manifest = manifestFor(catalogPlan);
  const manifestDigest = sha256(manifest);
  const catalogReceipt = createCatalogReceipt(
    catalogPlan,
    manifest,
    manifestDigest,
  );
  const publicationPlan = createPublicationPlan(
    set,
    catalogPlan,
    catalogReceipt,
    manifest,
    manifestDigest,
    options,
  );
  const tags = publicationPlan.images.flatMap((image) =>
    image.tags.map((tag) => ({
      image: image.name,
      kind: tag.kind,
      reference: tag.reference,
      digest: image.digest,
    })),
  );
  const observation = createPublicationTagObservation(publicationPlan, tags);
  return {
    set,
    options,
    catalogPlan,
    manifest,
    manifestDigest,
    catalogReceipt,
    publicationPlan,
    observation,
  };
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-closure-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test('plans tag publication only from a verified immutable catalog', () => {
  for (const scope of ['local', 'cluster', 'all']) {
    const { publicationPlan, set } = fixture(scope);
    assert.equal(publicationPlan.schema, PUBLICATION_PLAN_SCHEMA);
    assert.equal(
      publicationPlan.promotionPolicy.authority,
      'verified_immutable_catalog',
    );
    assert.equal(
      publicationPlan.requiredPrerequisites.catalogReceipt,
      'attested_before_tag_promotion',
    );
    assert.equal(publicationPlan.promotionPolicy.registryTagCas, false);
    assert.equal(publicationPlan.images.length, set.images.length);
    assert.equal(
      publicationPlan.images.every((image) => image.tags.length === 2),
      true,
    );
  }
});

test('creates a deterministic final closure receipt for every exact tag', () => {
  const { publicationPlan, observation } = fixture();
  const first = createClosureReceipt(publicationPlan, observation);
  const replay = createClosureReceipt(publicationPlan, observation);
  assert.equal(first.schema, CLOSURE_RECEIPT_SCHEMA);
  assert.equal(observation.schema, TAG_OBSERVATION_SCHEMA);
  assert.deepEqual(first, replay);
  assert.equal(first.publishedTags.length, publicationPlan.images.length * 2);
  assert.equal(first.verification.catalogReadyBeforeTagMutation, true);
  assert.equal(first.verification.allTagsExactDigest, true);
  assert.equal(first.verification.registryTagCas, false);
  assert.equal(
    auditClosureReceipt(first, publicationPlan, observation).compatible,
    true,
  );
});

test('rejects missing, reordered, extra or digest-drifted tag observations', () => {
  const { publicationPlan, observation } = fixture('cluster');
  const variants = [
    observation.tags.slice(1),
    [...observation.tags].reverse(),
    [...observation.tags, observation.tags[0]],
    observation.tags.map((entry, index) =>
      index === 0 ? { ...entry, digest: `sha256:${'f'.repeat(64)}` } : entry,
    ),
  ];
  for (const tags of variants) {
    assert.throws(
      () => createPublicationTagObservation(publicationPlan, tags),
      /observations differ from the exact plan/,
    );
  }
});

test('rejects a publication plan detached from release-set or catalog evidence', () => {
  const current = fixture('local');
  const other = fixture('cluster');
  assert.throws(
    () =>
      createPublicationPlan(
        current.set,
        other.catalogPlan,
        other.catalogReceipt,
        other.manifest,
        other.manifestDigest,
        current.options,
      ),
    /catalog plan differs from the standalone release set/,
  );
  const weakenedReceipt = structuredClone(current.catalogReceipt);
  weakenedReceipt.verification.keylessSignature = 'not_verified';
  assert.throws(
    () =>
      createPublicationPlan(
        current.set,
        current.catalogPlan,
        weakenedReceipt,
        current.manifest,
        current.manifestDigest,
        current.options,
      ),
    /catalog receipt differs from the verified OCI manifest/,
  );
});

test('rejects tampered plan, observation and closure self-digests', () => {
  const { publicationPlan, observation } = fixture('local');
  const badPlan = structuredClone(publicationPlan);
  badPlan.promotionPolicy.registryTagCas = true;
  assert.throws(
    () => createPublicationTagObservation(badPlan, observation.tags),
    /publication plan (?:shape|digest) is invalid/,
  );
  const recomputedWeakenedPlan = structuredClone(publicationPlan);
  recomputedWeakenedPlan.promotionPolicy.registryTagCas = true;
  delete recomputedWeakenedPlan.planDigest;
  recomputedWeakenedPlan.planDigest = sha256(
    JSON.stringify(recomputedWeakenedPlan),
  );
  assert.throws(
    () =>
      createPublicationTagObservation(recomputedWeakenedPlan, observation.tags),
    /publication plan shape is invalid/,
  );
  const badObservation = structuredClone(observation);
  badObservation.observationDigest = `sha256:${'a'.repeat(64)}`;
  assert.throws(
    () => createClosureReceipt(publicationPlan, badObservation),
    /observation digest is invalid/,
  );
  const receipt = createClosureReceipt(publicationPlan, observation);
  const badReceipt = structuredClone(receipt);
  badReceipt.verification.registryTagCas = true;
  assert.throws(
    () => auditClosureReceipt(badReceipt, publicationPlan, observation),
    /closure receipt differs/,
  );
});

test('runs plan, close and audit as canonical no-replace CLI stages', (t) => {
  const value = fixture('cluster');
  const directory = temporaryDirectory(t);
  const files = {
    releaseSet: path.join(directory, 'release-set.json'),
    catalogPlan: path.join(directory, 'catalog-plan.json'),
    catalogReceipt: path.join(directory, 'catalog-receipt.json'),
    manifest: path.join(directory, 'manifest.json'),
    publicationPlan: path.join(directory, 'publication-plan.json'),
    observation: path.join(directory, 'observation.json'),
    receipt: path.join(directory, 'receipt.json'),
  };
  writeCanonical(files.releaseSet, value.set);
  writeCanonical(files.catalogPlan, value.catalogPlan);
  writeCanonical(files.catalogReceipt, value.catalogReceipt);
  fs.writeFileSync(files.manifest, value.manifest, { mode: 0o600 });
  writeCanonical(files.observation, value.observation);
  const planArgs = [
    '--mode=plan',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=cluster',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--release-set=${files.releaseSet}`,
    `--catalog-plan=${files.catalogPlan}`,
    `--catalog-receipt=${files.catalogReceipt}`,
    `--catalog-manifest=${files.manifest}`,
    `--catalog-manifest-digest=${value.manifestDigest}`,
    `--output=${files.publicationPlan}`,
  ];
  const output = { write() {} };
  assert.equal(runCli(planArgs, output).schema, PUBLICATION_PLAN_SCHEMA);
  assert.throws(() => runCli(planArgs, output), /EEXIST/);
  assert.equal(
    runCli(
      [
        '--mode=close',
        `--plan=${files.publicationPlan}`,
        `--observations=${files.observation}`,
        `--output=${files.receipt}`,
      ],
      output,
    ).schema,
    CLOSURE_RECEIPT_SCHEMA,
  );
  assert.equal(
    runCli(
      [
        '--mode=audit',
        `--plan=${files.publicationPlan}`,
        `--observations=${files.observation}`,
        `--receipt=${files.receipt}`,
      ],
      output,
    ).compatible,
    true,
  );
});

test('rejects ambiguous CLI modes and extra arguments', () => {
  assert.throws(
    () => parseArguments(['--mode=close']),
    /arguments are invalid/,
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=audit',
        '--plan=/tmp/plan',
        '--observations=/tmp/observations',
        '--receipt=/tmp/receipt',
        '--extra=true',
      ]),
    /arguments are invalid/,
  );
});
