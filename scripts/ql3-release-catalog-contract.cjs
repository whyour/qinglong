#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  RELEASE_SET_SCHEMA,
  inspectReleaseSet,
} = require('./ql3-release-set-contract.cjs');

const CATALOG_PLAN_SCHEMA = 'qinglong/release-catalog-plan@v2';
const CATALOG_PUBLICATION_DECISION_SCHEMA =
  'qinglong/release-catalog-publication-decision@v1';
const CATALOG_RECEIPT_SCHEMA = 'qinglong/release-catalog-receipt@v2';
const CATALOG_TAG_INVENTORY_DECISION_SCHEMA =
  'qinglong/release-catalog-tag-inventory-decision@v1';
const ARTIFACT_TYPE = 'application/vnd.qinglong.release-set.v4+json';
const FILE_MEDIA_TYPE = ARTIFACT_TYPE;
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const OCI_EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
const OCI_EMPTY_CONFIG_DIGEST =
  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OCI_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const MAX_FILE_BYTES = 1024 * 1024;
const PUBLICATION_POLICY = Object.freeze({
  title: 'basename_only',
  crossRunnerDeterministic: true,
  stagingTagAuthority: 'none',
  discoveryTagAuthority: 'none',
  immutableDigestAuthority: 'required',
  roundTrip: 'byte_exact',
  conflict: 'fail_closed_before_discovery_tag_mutation',
  recovery: 'reuse_exact_manifest_digest_only',
});

class QingLong3ReleaseCatalogError extends Error {
  constructor(message) {
    super(`QingLong 3 release catalog failed: ${message}`);
    this.name = 'QingLong3ReleaseCatalogError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseCatalogError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function resolveCanonicalAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    fail(`${label} path must be absolute`);
  }
  const resolved = path.resolve(input);
  if (resolved !== input) fail(`${label} path must be normalized`);
  return resolved;
}

function readBoundedFile(filePath, label) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_FILE_BYTES ||
    fs.realpathSync(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  return Object.freeze({
    path: resolved,
    contents: fs.readFileSync(resolved, 'utf8'),
    bytes: stat.size,
  });
}

function parseJson(contents, label, requireCanonical) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (requireCanonical && canonicalJson(value) !== contents) {
    fail(`${label} must use exact canonical JSON encoding`);
  }
  return value;
}

function readCanonicalJson(filePath, label) {
  const file = readBoundedFile(filePath, label);
  return Object.freeze({
    ...file,
    value: parseJson(file.contents, label, true),
  });
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

function normalizeSourceRepository(value, repositoryOwner) {
  if (
    typeof value !== 'string' ||
    !SOURCE_REPOSITORY_PATTERN.test(value) ||
    !value.startsWith(`${repositoryOwner}/`)
  ) {
    fail(
      'source repository must be one lowercase repository owned by the publisher',
    );
  }
  return value;
}

function expectedFileName(version, releaseScope) {
  return `qinglong3-release-set-${version}-${releaseScope}.json`;
}

function createCatalogPlan(releaseSet, options) {
  inspectReleaseSet(releaseSet, options);
  const sourceRepository = normalizeSourceRepository(
    options.sourceRepository,
    releaseSet.repositoryOwner,
  );
  const contents = canonicalJson(releaseSet);
  const fileName = expectedFileName(options.version, options.releaseScope);
  const registryRepository = `ghcr.io/${releaseSet.repositoryOwner}/qinglong3-release-catalog`;
  const unsigned = {
    schemaVersion: 1,
    schema: CATALOG_PLAN_SCHEMA,
    release: { ...releaseSet.release },
    sourceRepository,
    releaseSet: {
      schema: RELEASE_SET_SCHEMA,
      releaseSetDigest: releaseSet.releaseSetDigest,
      contentDigest: sha256(contents),
      bytes: Buffer.byteLength(contents),
      fileName,
    },
    catalog: {
      repository: 'qinglong3-release-catalog',
      registryRepository,
      discoveryTag: `${registryRepository}:v${options.version}-${options.releaseScope}`,
      artifactType: ARTIFACT_TYPE,
      fileMediaType: FILE_MEDIA_TYPE,
      annotations: {
        'dev.qinglong.release.scope': options.releaseScope,
        'org.opencontainers.image.revision': options.sourceRevision,
        'org.opencontainers.image.source': `https://github.com/${sourceRepository}`,
        'org.opencontainers.image.version': options.version,
      },
    },
    publicationPolicy: { ...PUBLICATION_POLICY },
  };
  return Object.freeze({
    ...unsigned,
    planDigest: sha256(JSON.stringify(unsigned)),
  });
}

function auditCatalogPlan(actual, releaseSet, options) {
  const expected = createCatalogPlan(releaseSet, options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('catalog plan differs from the standalone release set');
  }
  return expected;
}

function validatePlanShape(plan) {
  if (
    !exactKeys(plan, [
      'schemaVersion',
      'schema',
      'release',
      'sourceRepository',
      'releaseSet',
      'catalog',
      'publicationPolicy',
      'planDigest',
    ]) ||
    plan.schemaVersion !== 1 ||
    plan.schema !== CATALOG_PLAN_SCHEMA ||
    JSON.stringify(plan.publicationPolicy) !==
      JSON.stringify(PUBLICATION_POLICY) ||
    !DIGEST_PATTERN.test(plan.planDigest || '')
  ) {
    fail('catalog plan shape is invalid');
  }
  const { planDigest, ...unsigned } = plan;
  if (planDigest !== sha256(JSON.stringify(unsigned))) {
    fail('catalog plan digest is invalid');
  }
  return plan;
}

function validateManifest(plan, manifestContents, manifestDigest) {
  if (
    !DIGEST_PATTERN.test(manifestDigest || '') ||
    sha256(manifestContents) !== manifestDigest
  ) {
    fail('catalog manifest digest is invalid');
  }
  const manifest = parseJson(manifestContents, 'catalog manifest', false);
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'mediaType',
      'artifactType',
      'config',
      'layers',
      'annotations',
    ]) ||
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
    manifest.artifactType !== plan.catalog.artifactType ||
    !exactKeys(manifest.config, ['mediaType', 'digest', 'size']) ||
    manifest.config.mediaType !== OCI_EMPTY_CONFIG_MEDIA_TYPE ||
    manifest.config.digest !== OCI_EMPTY_CONFIG_DIGEST ||
    manifest.config.size !== 2 ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length !== 1 ||
    !exactKeys(manifest.layers[0], [
      'mediaType',
      'digest',
      'size',
      'annotations',
    ]) ||
    manifest.layers[0].mediaType !== plan.catalog.fileMediaType ||
    manifest.layers[0].digest !== plan.releaseSet.contentDigest ||
    manifest.layers[0].size !== plan.releaseSet.bytes ||
    JSON.stringify(manifest.layers[0].annotations) !==
      JSON.stringify({
        'org.opencontainers.image.title': plan.releaseSet.fileName,
      }) ||
    JSON.stringify(manifest.annotations) !==
      JSON.stringify(plan.catalog.annotations)
  ) {
    fail('catalog manifest differs from the exact publication plan');
  }
  return manifest;
}

function createCatalogPublicationDecision(
  plan,
  manifestContents,
  manifestDigest,
  observedDiscoveryDigest,
) {
  validatePlanShape(plan);
  validateManifest(plan, manifestContents, manifestDigest);
  if (
    observedDiscoveryDigest !== 'absent' &&
    !DIGEST_PATTERN.test(observedDiscoveryDigest || '')
  ) {
    fail('observed discovery tag digest is invalid');
  }
  if (
    observedDiscoveryDigest !== 'absent' &&
    observedDiscoveryDigest !== manifestDigest
  ) {
    fail('discovery tag already points at another catalog manifest');
  }
  const action =
    observedDiscoveryDigest === 'absent'
      ? 'publish_if_absent'
      : 'reuse_exact_digest';
  const unsigned = {
    schemaVersion: 1,
    schema: CATALOG_PUBLICATION_DECISION_SCHEMA,
    planDigest: plan.planDigest,
    catalog: {
      discoveryTag: plan.catalog.discoveryTag,
      manifestDigest,
      immutableReference: `${plan.catalog.registryRepository}@${manifestDigest}`,
    },
    observation:
      observedDiscoveryDigest === 'absent' ? 'absent' : 'exact_manifest_digest',
    action,
    guards: {
      stagingTagAuthority: 'none',
      discoveryTagAuthority: 'none',
      overwriteConflicts: false,
      verifyAfterPublication: true,
    },
  };
  return Object.freeze({
    ...unsigned,
    decisionDigest: sha256(JSON.stringify(unsigned)),
  });
}

function createCatalogTagInventoryDecision(plan, inventoryContents) {
  validatePlanShape(plan);
  if (
    typeof inventoryContents !== 'string' ||
    Buffer.byteLength(inventoryContents) > MAX_FILE_BYTES ||
    (inventoryContents.length > 0 && !inventoryContents.endsWith('\n'))
  ) {
    fail('catalog tag inventory is invalid or unbounded');
  }
  const tags =
    inventoryContents.length === 0
      ? []
      : inventoryContents.slice(0, -1).split('\n');
  if (
    tags.some((value) => !OCI_TAG_PATTERN.test(value)) ||
    new Set(tags).size !== tags.length
  ) {
    fail('catalog tag inventory is malformed');
  }
  const separator = plan.catalog.discoveryTag.lastIndexOf(':');
  const discoveryTagName = plan.catalog.discoveryTag.slice(separator + 1);
  const unsigned = {
    schemaVersion: 1,
    schema: CATALOG_TAG_INVENTORY_DECISION_SCHEMA,
    planDigest: plan.planDigest,
    discoveryTag: plan.catalog.discoveryTag,
    inventory: {
      count: tags.length,
      contentDigest: sha256(inventoryContents),
    },
    observation: tags.includes(discoveryTagName) ? 'present' : 'absent',
  };
  return Object.freeze({
    ...unsigned,
    decisionDigest: sha256(JSON.stringify(unsigned)),
  });
}

function createCatalogReceipt(plan, manifestContents, manifestDigest) {
  validatePlanShape(plan);
  validateManifest(plan, manifestContents, manifestDigest);
  const unsigned = {
    schemaVersion: 1,
    schema: CATALOG_RECEIPT_SCHEMA,
    release: { ...plan.release },
    planDigest: plan.planDigest,
    releaseSet: { ...plan.releaseSet },
    catalog: {
      repository: plan.catalog.repository,
      discoveryTag: plan.catalog.discoveryTag,
      manifestDigest,
      immutableReference: `${plan.catalog.registryRepository}@${manifestDigest}`,
      artifactType: plan.catalog.artifactType,
    },
    verification: {
      remoteManifestStructure: 'exact',
      releaseSetRoundTrip: 'byte_exact',
      keylessSignature: 'exact_workflow_identity',
      githubProvenance: 'source_tag_and_revision_bound',
      discoveryTagAuthority: 'none',
      immutableDigestAuthority: 'verified',
      discoveryTagConflictPolicy: 'fail_closed_before_mutation',
      responseLossRecovery: 'reuse_exact_manifest_digest_only',
    },
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  });
}

function auditCatalogReceipt(actual, plan, manifestContents, manifestDigest) {
  const expected = createCatalogReceipt(plan, manifestContents, manifestDigest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('catalog receipt differs from the verified OCI manifest');
  }
  return Object.freeze({
    compatible: true,
    releaseSetDigest: actual.releaseSet.releaseSetDigest,
    releaseScope: actual.release.scope,
    catalogManifestDigest: actual.catalog.manifestDigest,
    immutableReference: actual.catalog.immutableReference,
    discoveryTagAuthority: actual.verification.discoveryTagAuthority,
    discoveryTagConflictPolicy: actual.verification.discoveryTagConflictPolicy,
  });
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
    'source-repository',
    'source-revision',
    'version',
  ];
  const expected =
    values.mode === 'plan'
      ? [...identity, 'output', 'release-set']
      : values.mode === 'tag-inventory'
      ? ['mode', 'output', 'plan', 'tag-inventory']
      : values.mode === 'publication-decision'
      ? [
          'manifest',
          'manifest-digest',
          'mode',
          'observed-discovery-digest',
          'output',
          'plan',
        ]
      : values.mode === 'receipt'
      ? ['manifest', 'manifest-digest', 'mode', 'output', 'plan']
      : values.mode === 'audit'
      ? ['manifest', 'manifest-digest', 'mode', 'plan', 'receipt']
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
    ...(values.version ? { version: values.version } : {}),
    ...(values['source-revision']
      ? { sourceRevision: values['source-revision'] }
      : {}),
    ...(values['source-ref'] ? { sourceRef: values['source-ref'] } : {}),
    ...(values['release-scope']
      ? { releaseScope: values['release-scope'] }
      : {}),
    ...(values['repository-owner']
      ? { repositoryOwner: values['repository-owner'] }
      : {}),
    ...(values['source-repository']
      ? { sourceRepository: values['source-repository'] }
      : {}),
    ...(values['release-set'] ? { releaseSet: values['release-set'] } : {}),
    ...(values.plan ? { plan: values.plan } : {}),
    ...(values.manifest ? { manifest: values.manifest } : {}),
    ...(values['manifest-digest']
      ? { manifestDigest: values['manifest-digest'] }
      : {}),
    ...(values['observed-discovery-digest']
      ? { observedDiscoveryDigest: values['observed-discovery-digest'] }
      : {}),
    ...(values.receipt ? { receipt: values.receipt } : {}),
    ...(values['tag-inventory']
      ? { tagInventory: values['tag-inventory'] }
      : {}),
    ...(values.output ? { output: values.output } : {}),
  });
}

function runCli(argv, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'plan') {
    const releaseSetFile = readCanonicalJson(options.releaseSet, 'release set');
    if (
      path.basename(releaseSetFile.path) !==
      expectedFileName(options.version, options.releaseScope)
    ) {
      fail('release set filename must be deterministic');
    }
    const plan = createCatalogPlan(releaseSetFile.value, options);
    writeNoReplace(options.output, plan);
    output.write(canonicalJson(plan));
    return plan;
  }
  const plan = readCanonicalJson(options.plan, 'catalog plan').value;
  if (options.mode === 'tag-inventory') {
    const inventoryPath = resolveCanonicalAbsolute(
      options.tagInventory,
      'catalog tag inventory',
    );
    const stat = fs.lstatSync(inventoryPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_FILE_BYTES ||
      fs.realpathSync(inventoryPath) !== inventoryPath ||
      fs.realpathSync(path.dirname(inventoryPath)) !==
        path.dirname(inventoryPath)
    ) {
      fail('catalog tag inventory must be one bounded canonical regular file');
    }
    const decision = createCatalogTagInventoryDecision(
      plan,
      fs.readFileSync(inventoryPath, 'utf8'),
    );
    writeNoReplace(options.output, decision);
    output.write(canonicalJson(decision));
    return decision;
  }
  const manifest = readBoundedFile(options.manifest, 'catalog manifest');
  if (options.mode === 'publication-decision') {
    const decision = createCatalogPublicationDecision(
      plan,
      manifest.contents,
      options.manifestDigest,
      options.observedDiscoveryDigest,
    );
    writeNoReplace(options.output, decision);
    output.write(canonicalJson(decision));
    return decision;
  }
  if (options.mode === 'receipt') {
    const receipt = createCatalogReceipt(
      plan,
      manifest.contents,
      options.manifestDigest,
    );
    writeNoReplace(options.output, receipt);
    output.write(canonicalJson(receipt));
    return receipt;
  }
  const receipt = readCanonicalJson(options.receipt, 'catalog receipt').value;
  const audit = auditCatalogReceipt(
    receipt,
    plan,
    manifest.contents,
    options.manifestDigest,
  );
  output.write(canonicalJson(audit));
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'release catalog failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ARTIFACT_TYPE,
  CATALOG_PLAN_SCHEMA,
  CATALOG_PUBLICATION_DECISION_SCHEMA,
  CATALOG_RECEIPT_SCHEMA,
  CATALOG_TAG_INVENTORY_DECISION_SCHEMA,
  FILE_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  QingLong3ReleaseCatalogError,
  auditCatalogPlan,
  auditCatalogReceipt,
  createCatalogPlan,
  createCatalogPublicationDecision,
  createCatalogReceipt,
  createCatalogTagInventoryDecision,
  parseArguments,
  runCli,
});
