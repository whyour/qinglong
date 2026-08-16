#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  CLUSTER_IMAGES,
  LOCAL_IMAGES,
  RELEASE_SCOPES,
  SCHEMA: RELEASE_CANDIDATE_SCHEMA,
  auditReleaseCandidateContract,
} = require('./ql3-release-candidate-contract.cjs');
const { VERSION_PATTERN } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const IMAGE_RECORD_SCHEMA = 'qinglong/release-set-image-record@v1';
const RELEASE_SET_SCHEMA = 'qinglong/release-set@v1';
const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u;
const REQUIRED_IMAGE_ATTESTATIONS = Object.freeze([
  'github-provenance',
  'cyclonedx-sbom',
  'os-vulnerability',
  'release-candidate-contract',
]);

class QingLong3ReleaseSetError extends Error {
  constructor(message) {
    super(`QingLong 3 release set failed: ${message}`);
    this.name = 'QingLong3ReleaseSetError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseSetError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function resolveCanonicalAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    fail(`${label} path must be absolute`);
  }
  const resolved = path.resolve(input);
  if (resolved !== input) fail(`${label} path must be normalized`);
  return resolved;
}

function readCanonicalJson(filePath, label) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_JSON_BYTES ||
    fs.realpathSync(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  const contents = fs.readFileSync(resolved, 'utf8');
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (canonicalJson(value) !== contents) {
    fail(`${label} must use exact canonical JSON encoding`);
  }
  return value;
}

function writeNoReplace(filePath, value) {
  const resolved = resolveCanonicalAbsolute(filePath, 'output');
  if (
    fs.existsSync(resolved) ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail('output must be unused in one canonical directory');
  }
  fs.writeFileSync(resolved, canonicalJson(value), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function normalizeRepositoryOwner(value) {
  if (typeof value !== 'string' || !OWNER_PATTERN.test(value)) {
    fail('repository owner must be one lowercase GitHub owner');
  }
  return value;
}

function verifyCandidate(candidate, options) {
  auditReleaseCandidateContract(candidate, {
    root: options.root || DEFAULT_ROOT,
    version: options.version,
    sourceRevision: options.sourceRevision,
    sourceRef: options.sourceRef,
    releaseScope: options.releaseScope,
  });
  return candidate;
}

function selectedImage(candidate, imageName) {
  const matches = candidate.images.filter((entry) => entry.image === imageName);
  if (matches.length !== 1) {
    fail('image must be selected exactly once by the release candidate');
  }
  return matches[0];
}

function deriveVerifiedImageRecord(
  candidate,
  repositoryOwner,
  imageName,
  digest,
) {
  if (!DIGEST_PATTERN.test(digest || '')) {
    fail('image digest must be an exact SHA-256 digest');
  }
  const selected = selectedImage(candidate, imageName);
  const repository = `ghcr.io/${repositoryOwner}/${selected.repository}`;
  const image = {
    name: selected.image,
    repository: selected.repository,
    digest,
    reference: `${repository}@${digest}`,
    versionTag: `${repository}:${candidate.release.version}`,
    sourceTag: `${repository}:sha-${candidate.release.sourceRevision}`,
    platforms: [...candidate.compatibility.platforms],
  };
  const unsigned = {
    schemaVersion: 1,
    schema: IMAGE_RECORD_SCHEMA,
    release: { ...candidate.release },
    candidateContractDigest: candidate.contractDigest,
    repositoryOwner,
    image,
    verification: {
      remoteDigestVerified: true,
      keylessSignatureVerified: true,
      githubAttestations: [...REQUIRED_IMAGE_ATTESTATIONS],
      localProfileRolloutVerified: selected.image === 'local',
      tagPromotion: 'deferred_to_complete_release_set',
    },
  };
  return Object.freeze({
    ...unsigned,
    recordDigest: sha256(JSON.stringify(unsigned)),
  });
}

function createVerifiedImageRecord(options) {
  const candidate = verifyCandidate(options.candidate, options);
  const owner = normalizeRepositoryOwner(options.repositoryOwner);
  return deriveVerifiedImageRecord(
    candidate,
    owner,
    options.image,
    options.digest,
  );
}

function validateImageRecord(record, candidate, repositoryOwner) {
  if (
    !exactKeys(record, [
      'schemaVersion',
      'schema',
      'release',
      'candidateContractDigest',
      'repositoryOwner',
      'image',
      'verification',
      'recordDigest',
    ]) ||
    record.schemaVersion !== 1 ||
    record.schema !== IMAGE_RECORD_SCHEMA ||
    !exactKeys(record.image, [
      'name',
      'repository',
      'digest',
      'reference',
      'versionTag',
      'sourceTag',
      'platforms',
    ]) ||
    !exactKeys(record.verification, [
      'remoteDigestVerified',
      'keylessSignatureVerified',
      'githubAttestations',
      'localProfileRolloutVerified',
      'tagPromotion',
    ])
  ) {
    fail('image record shape is invalid');
  }
  const expected = deriveVerifiedImageRecord(
    candidate,
    repositoryOwner,
    record.image.name,
    record.image.digest,
  );
  if (JSON.stringify(record) !== JSON.stringify(expected)) {
    fail(`image record drifted: ${record.image.name || 'unknown'}`);
  }
  return record;
}

function deploymentFamily(candidate, family, imageNames) {
  const source = candidate.deploymentFamilies[family];
  return Object.freeze({
    selected: source.selected,
    profiles: [...source.profiles],
    images: imageNames,
  });
}

function createReleaseSet(options) {
  const candidate = verifyCandidate(options.candidate, options);
  const repositoryOwner = normalizeRepositoryOwner(options.repositoryOwner);
  if (!Array.isArray(options.records)) fail('image records must be an array');
  if (options.records.length !== candidate.images.length) {
    fail('image record count differs from the release candidate');
  }
  const recordsByName = new Map();
  for (const record of options.records) {
    validateImageRecord(record, candidate, repositoryOwner);
    if (recordsByName.has(record.image.name)) {
      fail('image records must be unique');
    }
    recordsByName.set(record.image.name, record);
  }
  const orderedRecords = candidate.images.map((entry) => {
    const record = recordsByName.get(entry.image);
    if (!record) fail(`missing image record: ${entry.image}`);
    return record;
  });
  const localImages = orderedRecords
    .filter((record) => record.image.name === 'local')
    .map((record) => record.image.name);
  const clusterImages = orderedRecords
    .filter((record) => record.image.name !== 'local')
    .map((record) => record.image.name);
  const images = orderedRecords.map((record) => ({
    ...record.image,
    imageRecordDigest: record.recordDigest,
  }));
  const unsigned = {
    schemaVersion: 1,
    schema: RELEASE_SET_SCHEMA,
    release: { ...candidate.release },
    candidate: {
      schema: candidate.schema,
      contractDigest: candidate.contractDigest,
    },
    repositoryOwner,
    platforms: [...candidate.compatibility.platforms],
    deploymentFamilies: {
      local: deploymentFamily(candidate, 'local', localImages),
      cluster: deploymentFamily(candidate, 'cluster', clusterImages),
    },
    images,
    promotion: {
      authority: 'complete_verified_release_set',
      versionTags: 'promote_after_complete_set_audit',
      sourceTags: 'promote_after_complete_set_audit',
      crossRepositoryAtomicity: false,
      recovery: 'verify_exact_digest_then_continue',
    },
    requiredVerification: {
      imageKeylessSignature: true,
      imageAttestations: [...REQUIRED_IMAGE_ATTESTATIONS],
      releaseSetBuildProvenance: true,
    },
  };
  return Object.freeze({
    ...unsigned,
    releaseSetDigest: sha256(JSON.stringify(unsigned)),
  });
}

function auditReleaseSet(actual, options) {
  const expected = createReleaseSet(options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('release set differs from the verified image records');
  }
  return Object.freeze({
    compatible: true,
    releaseSetDigest: actual.releaseSetDigest,
    releaseScope: actual.release.scope,
    imageCount: actual.images.length,
    images: Object.freeze(actual.images.map((entry) => entry.name)),
    references: Object.freeze(actual.images.map((entry) => entry.reference)),
    tagPromotionAuthority: actual.promotion.authority,
  });
}

function inspectReleaseSet(actual, options) {
  const repositoryOwner = normalizeRepositoryOwner(options.repositoryOwner);
  if (
    !RELEASE_SCOPES.includes(options.releaseScope) ||
    typeof options.version !== 'string' ||
    !VERSION_PATTERN.test(options.version) ||
    !/^[a-f0-9]{40}$/u.test(options.sourceRevision || '') ||
    options.sourceRef !== `refs/tags/v${options.version}`
  ) {
    fail('expected release identity is invalid');
  }
  if (
    !exactKeys(actual, [
      'schemaVersion',
      'schema',
      'release',
      'candidate',
      'repositoryOwner',
      'platforms',
      'deploymentFamilies',
      'images',
      'promotion',
      'requiredVerification',
      'releaseSetDigest',
    ]) ||
    actual.schemaVersion !== 1 ||
    actual.schema !== RELEASE_SET_SCHEMA ||
    !exactKeys(actual.release, [
      'version',
      'sourceRevision',
      'sourceRef',
      'scope',
    ]) ||
    actual.release.version !== options.version ||
    actual.release.sourceRevision !== options.sourceRevision ||
    actual.release.sourceRef !== options.sourceRef ||
    actual.release.scope !== options.releaseScope ||
    !exactKeys(actual.candidate, ['schema', 'contractDigest']) ||
    actual.candidate.schema !== RELEASE_CANDIDATE_SCHEMA ||
    !DIGEST_PATTERN.test(actual.candidate.contractDigest || '') ||
    actual.repositoryOwner !== repositoryOwner ||
    JSON.stringify(actual.platforms) !==
      JSON.stringify(['linux/amd64', 'linux/arm64']) ||
    !exactKeys(actual.deploymentFamilies, ['local', 'cluster']) ||
    !Array.isArray(actual.images) ||
    !exactKeys(actual.promotion, [
      'authority',
      'versionTags',
      'sourceTags',
      'crossRepositoryAtomicity',
      'recovery',
    ]) ||
    JSON.stringify(actual.promotion) !==
      JSON.stringify({
        authority: 'complete_verified_release_set',
        versionTags: 'promote_after_complete_set_audit',
        sourceTags: 'promote_after_complete_set_audit',
        crossRepositoryAtomicity: false,
        recovery: 'verify_exact_digest_then_continue',
      }) ||
    !exactKeys(actual.requiredVerification, [
      'imageKeylessSignature',
      'imageAttestations',
      'releaseSetBuildProvenance',
    ]) ||
    JSON.stringify(actual.requiredVerification) !==
      JSON.stringify({
        imageKeylessSignature: true,
        imageAttestations: [...REQUIRED_IMAGE_ATTESTATIONS],
        releaseSetBuildProvenance: true,
      })
  ) {
    fail('standalone release set shape or identity is invalid');
  }

  const selected =
    options.releaseScope === 'local'
      ? [...LOCAL_IMAGES]
      : options.releaseScope === 'cluster'
      ? [...CLUSTER_IMAGES]
      : [...CLUSTER_IMAGES, ...LOCAL_IMAGES];
  const expectedNames = selected.map((entry) => entry.image);
  if (actual.images.length !== selected.length) {
    fail('standalone release set image count is invalid');
  }
  for (let index = 0; index < selected.length; index += 1) {
    const image = actual.images[index];
    const expected = selected[index];
    const repository = `ghcr.io/${repositoryOwner}/${expected.repository}`;
    if (
      !exactKeys(image, [
        'name',
        'repository',
        'digest',
        'reference',
        'versionTag',
        'sourceTag',
        'platforms',
        'imageRecordDigest',
      ]) ||
      image.name !== expected.image ||
      image.repository !== expected.repository ||
      !DIGEST_PATTERN.test(image.digest || '') ||
      image.reference !== `${repository}@${image.digest}` ||
      image.versionTag !== `${repository}:${options.version}` ||
      image.sourceTag !== `${repository}:sha-${options.sourceRevision}` ||
      JSON.stringify(image.platforms) !== JSON.stringify(actual.platforms) ||
      !DIGEST_PATTERN.test(image.imageRecordDigest || '')
    ) {
      fail(`standalone release set image is invalid: ${expected.image}`);
    }
  }

  const expectedFamilies = {
    local: {
      selected: ['local', 'all'].includes(options.releaseScope),
      profiles: ['edge', 'standalone'],
      images: expectedNames.filter((name) => name === 'local'),
    },
    cluster: {
      selected: ['cluster', 'all'].includes(options.releaseScope),
      profiles: ['cluster', 'worker-edge', 'worker-node'],
      images: expectedNames.filter((name) => name !== 'local'),
    },
  };
  if (
    JSON.stringify(actual.deploymentFamilies) !==
    JSON.stringify(expectedFamilies)
  ) {
    fail('standalone release set deployment families are invalid');
  }
  const { releaseSetDigest, ...unsigned } = actual;
  if (
    !DIGEST_PATTERN.test(releaseSetDigest || '') ||
    releaseSetDigest !== sha256(JSON.stringify(unsigned))
  ) {
    fail('standalone release set digest is invalid');
  }
  return Object.freeze({
    compatible: true,
    releaseSetDigest,
    releaseScope: actual.release.scope,
    imageCount: actual.images.length,
    images: Object.freeze([...expectedNames]),
    references: Object.freeze(actual.images.map((entry) => entry.reference)),
    verification: 'standalone_structure_identity_and_self_digest',
    sourceRecordsReplayed: false,
  });
}

function readRecordDirectory(directoryPath, candidate) {
  const resolved = resolveCanonicalAbsolute(directoryPath, 'records');
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail('records must be one canonical directory');
  }
  const expectedNames = candidate.images
    .map((entry) => `${entry.image}.json`)
    .sort();
  const actualNames = fs.readdirSync(resolved).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail('records directory differs from the exact selected image set');
  }
  return candidate.images.map((entry) =>
    readCanonicalJson(
      path.join(resolved, `${entry.image}.json`),
      'image record',
    ),
  );
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  const identity = [
    'mode',
    'release-scope',
    'repository-owner',
    'source-ref',
    'source-revision',
    'version',
  ];
  const common = ['candidate', ...identity];
  const expected =
    values.mode === 'record-image'
      ? [...common, 'digest', 'image', 'output']
      : values.mode === 'aggregate'
      ? [...common, 'output', 'records']
      : values.mode === 'audit'
      ? [...common, 'records', 'report']
      : values.mode === 'inspect'
      ? [...identity, 'report']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    ...(values.candidate ? { candidate: values.candidate } : {}),
    version: values.version,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    releaseScope: values['release-scope'],
    repositoryOwner: values['repository-owner'],
    ...(values.image ? { image: values.image } : {}),
    ...(values.digest ? { digest: values.digest } : {}),
    ...(values.records ? { records: values.records } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.report ? { report: values.report } : {}),
  });
}

function runCli(argv, root = DEFAULT_ROOT, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'inspect') {
    const report = readCanonicalJson(options.report, 'release set');
    const inspection = inspectReleaseSet(report, options);
    output.write(canonicalJson(inspection));
    return inspection;
  }
  const candidate = readCanonicalJson(options.candidate, 'release candidate');
  if (options.mode === 'record-image') {
    const record = createVerifiedImageRecord({ ...options, candidate, root });
    writeNoReplace(options.output, record);
    output.write(canonicalJson(record));
    return record;
  }
  const records = readRecordDirectory(options.records, candidate);
  if (options.mode === 'aggregate') {
    const releaseSet = createReleaseSet({
      ...options,
      candidate,
      records,
      root,
    });
    writeNoReplace(options.output, releaseSet);
    output.write(canonicalJson(releaseSet));
    return releaseSet;
  }
  const report = readCanonicalJson(options.report, 'release set');
  const audit = auditReleaseSet(report, {
    ...options,
    candidate,
    records,
    root,
  });
  output.write(canonicalJson(audit));
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'release set failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  IMAGE_RECORD_SCHEMA,
  RELEASE_SET_SCHEMA,
  QingLong3ReleaseSetError,
  auditReleaseSet,
  createReleaseSet,
  createVerifiedImageRecord,
  inspectReleaseSet,
  parseArguments,
  runCli,
});
