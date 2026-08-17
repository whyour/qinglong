#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEMA: CATALOG_CONSUMPTION_SCHEMA,
  auditCeremonyBundle,
} = require('./ql3-release-catalog-consumption-ceremony.cjs');

const SCHEMA = 'qinglong/release-deployment-readiness-receipt@v1';
const MAX_REPORT_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u;
const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const LOCAL_REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'profile',
  'generation',
  'exactRepoDigest',
  'composeMerge',
  'rolloutActive',
  'durableReceipt',
  'sqliteWriteContract',
  'sqliteBackup',
  'sqliteWriteObservation',
  'sqliteRestorePrepared',
  'sqliteRestoreCommitted',
  'sqliteRestoreRolloutRecovered',
  'sqliteRestoreReplayUnchanged',
  'sqliteEvidenceCollected',
  'sqliteCollectedRolloutReplayUnchanged',
  'gracefulCleanup',
  'releaseAuthority',
  'compatible',
]);
const LOCAL_AUTHORITY_KEYS = Object.freeze([
  'mode',
  'sourceRevision',
  'sourceRef',
  'scope',
  'releaseSetDigest',
  'catalogManifestDigest',
  'catalogConsumptionDigest',
  'selectionDigest',
]);
const CLUSTER_REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'schema',
  'kubernetes',
  'deployment',
  'releaseAuthority',
  'preflightDigest',
  'receiptDigest',
  'receiptAuditCompatible',
  'retirement',
  'serverSideDryRun',
  'serverSideApply',
  'convergenceRead',
  'deploymentHeadCas',
  'resourceInventoryClosed',
  'crossResourceAtomicity',
  'cleanupComplete',
]);
const CLUSTER_AUTHORITY_KEYS = Object.freeze([
  'mode',
  'version',
  'sourceRevision',
  'sourceRef',
  'scope',
  'releaseSetDigest',
  'catalogManifestDigest',
  'catalogConsumptionDigest',
  'immutableReference',
]);
const VERIFICATION = Object.freeze({
  finalizerCatalogConsumption: 'independently_verified',
  deploymentEvidence: 'scope_exact_catalog_bound_live_reports',
  reportEncoding: 'bounded_canonical_json',
  reportBytesBound: true,
  syntheticFixturesAccepted: false,
  jobResultOnlyAuthority: false,
  tagMutation: false,
});

class QingLong3ReleaseDeploymentReadinessError extends Error {
  constructor(message) {
    super(`QingLong 3 release deployment readiness failed: ${message}`);
    this.name = 'QingLong3ReleaseDeploymentReadinessError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseDeploymentReadinessError(message);
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

function releaseFromIdentity(identity) {
  return Object.freeze({
    version: identity.version,
    sourceRevision: identity.sourceRevision,
    sourceRef: identity.sourceRef,
    scope: identity.releaseScope,
  });
}

function validateIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    typeof identity.version !== 'string' ||
    identity.version.length < 1 ||
    identity.version.length > 64 ||
    !REVISION_PATTERN.test(identity.sourceRevision || '') ||
    identity.sourceRef !== `refs/tags/v${identity.version}` ||
    !['local', 'cluster', 'all'].includes(identity.releaseScope) ||
    !OWNER_PATTERN.test(identity.repositoryOwner || '') ||
    !REPOSITORY_PATTERN.test(identity.sourceRepository || '') ||
    !identity.sourceRepository.startsWith(`${identity.repositoryOwner}/`)
  ) {
    fail('release identity is invalid');
  }
  return releaseFromIdentity(identity);
}

function requiredFamilies(scope) {
  return scope === 'local'
    ? ['local']
    : scope === 'cluster'
    ? ['cluster']
    : ['local', 'cluster'];
}

function validateConsumption(consumption, identity, label) {
  const expectedImmutable = `ghcr.io/${identity.repositoryOwner}/qinglong3-release-catalog@${consumption?.catalogManifestDigest}`;
  if (
    consumption === null ||
    typeof consumption !== 'object' ||
    consumption.compatible !== true ||
    consumption.releaseScope !== identity.releaseScope ||
    consumption.sourceRepository !== identity.sourceRepository ||
    consumption.workflowIdentity !==
      `https://github.com/${identity.sourceRepository}/.github/workflows/ql3-image-release.yml@${identity.sourceRef}` ||
    !DIGEST_PATTERN.test(consumption.releaseSetDigest || '') ||
    !DIGEST_PATTERN.test(consumption.catalogManifestDigest || '') ||
    consumption.immutableReference !== expectedImmutable ||
    consumption.discoveryTagAuthority !== 'none' ||
    consumption.externalToolResultsReplayed !== false ||
    consumption.deploymentMutation !== false ||
    !DIGEST_PATTERN.test(consumption.contentDigest || '') ||
    consumption.releaseSet?.release?.version !== identity.version ||
    consumption.releaseSet?.release?.sourceRevision !==
      identity.sourceRevision ||
    consumption.releaseSet?.release?.sourceRef !== identity.sourceRef ||
    consumption.releaseSet?.release?.scope !== identity.releaseScope ||
    consumption.releaseSet?.releaseSetDigest !== consumption.releaseSetDigest
  ) {
    fail(`${label} catalog consumption is invalid`);
  }
  return consumption;
}

function sameCatalog(authority, consumption, identity, keys) {
  return (
    exactKeys(authority, keys) &&
    authority.mode === 'verified_release_catalog' &&
    authority.sourceRevision === identity.sourceRevision &&
    authority.sourceRef === identity.sourceRef &&
    authority.scope === identity.releaseScope &&
    authority.releaseSetDigest === consumption.releaseSetDigest &&
    authority.catalogManifestDigest === consumption.catalogManifestDigest &&
    authority.catalogConsumptionDigest === consumption.contentDigest
  );
}

function validateLocalReport(entry, profile, consumption, identity) {
  const report = entry?.value;
  if (
    !DIGEST_PATTERN.test(entry?.digest || '') ||
    !exactKeys(report, LOCAL_REPORT_KEYS) ||
    report.schemaVersion !== 1 ||
    report.profile !== profile ||
    !Number.isSafeInteger(report.generation) ||
    report.generation < 1 ||
    report.exactRepoDigest !== true ||
    report.composeMerge !== true ||
    report.rolloutActive !== true ||
    report.durableReceipt !== true ||
    report.sqliteWriteContract !== 37 ||
    report.sqliteBackup !== true ||
    report.sqliteRestorePrepared !== true ||
    report.sqliteRestoreCommitted !== true ||
    report.sqliteRestoreRolloutRecovered !== true ||
    report.sqliteRestoreReplayUnchanged !== true ||
    report.sqliteEvidenceCollected !== true ||
    report.sqliteCollectedRolloutReplayUnchanged !== true ||
    report.gracefulCleanup !== true ||
    report.compatible !== true ||
    !sameCatalog(
      report.releaseAuthority,
      consumption,
      identity,
      LOCAL_AUTHORITY_KEYS,
    ) ||
    !DIGEST_PATTERN.test(report.releaseAuthority.selectionDigest || '')
  ) {
    fail(`${profile} deployment evidence is invalid`);
  }
  return report;
}

function validateClusterReport(entry, consumption, identity) {
  const report = entry?.value;
  if (
    !DIGEST_PATTERN.test(entry?.digest || '') ||
    !exactKeys(report, CLUSTER_REPORT_KEYS) ||
    report.schemaVersion !== 1 ||
    report.schema !== 'qinglong/kubernetes-deployment-live-evidence@v1' ||
    report.kubernetes === null ||
    typeof report.kubernetes !== 'object' ||
    typeof report.kubernetes.serverVersion !== 'string' ||
    !/^linux\/(?:amd64|arm64)$/u.test(report.kubernetes.architecture || '') ||
    report.kubernetes.nodeCount !== 3 ||
    typeof report.kubernetes.clusterUid !== 'string' ||
    report.deployment === null ||
    typeof report.deployment !== 'object' ||
    report.deployment.replicas !== 0 ||
    report.deployment.immutableImages !== true ||
    report.deployment.headPhase !== 'committed' ||
    report.deployment.headGeneration !== 2 ||
    !DIGEST_PATTERN.test(report.deployment.deploymentDigest || '') ||
    !sameCatalog(
      report.releaseAuthority,
      consumption,
      identity,
      CLUSTER_AUTHORITY_KEYS,
    ) ||
    report.releaseAuthority.version !== identity.version ||
    report.releaseAuthority.immutableReference !==
      consumption.immutableReference ||
    !DIGEST_PATTERN.test(report.preflightDigest || '') ||
    !DIGEST_PATTERN.test(report.receiptDigest || '') ||
    report.receiptAuditCompatible !== true ||
    report.retirement === null ||
    typeof report.retirement !== 'object' ||
    report.retirement.receiptAuditCompatible !== true ||
    report.retirement.targetAbsent !== true ||
    report.retirement.uidResourceVersionDeletePreconditions !== true ||
    report.retirement.deploymentHeadCas !== true ||
    report.retirement.unixSocketProxy !== true ||
    report.serverSideDryRun !== true ||
    report.serverSideApply !== true ||
    report.convergenceRead !== true ||
    report.deploymentHeadCas !== true ||
    report.resourceInventoryClosed !== true ||
    report.crossResourceAtomicity !== false ||
    report.cleanupComplete !== true
  ) {
    fail('cluster deployment evidence is invalid');
  }
  return report;
}

function validateEvidenceCatalog(consumption, finalizer) {
  if (
    consumption.releaseSetDigest !== finalizer.releaseSetDigest ||
    consumption.catalogManifestDigest !== finalizer.catalogManifestDigest ||
    consumption.immutableReference !== finalizer.immutableReference
  ) {
    fail('deployment evidence is detached from the finalizer catalog');
  }
}

function createDeploymentReadinessReceipt(input) {
  const identity = input?.identity;
  const release = validateIdentity(identity);
  const finalizer = validateConsumption(
    input.finalizerConsumption,
    identity,
    'finalizer',
  );
  const evidence = [];
  if (identity.releaseScope !== 'cluster') {
    const localConsumption = validateConsumption(
      input.local?.consumption,
      identity,
      'local deployment',
    );
    validateEvidenceCatalog(localConsumption, finalizer);
    const edge = validateLocalReport(
      input.local?.edge,
      'edge',
      localConsumption,
      identity,
    );
    const standalone = validateLocalReport(
      input.local?.standalone,
      'standalone',
      localConsumption,
      identity,
    );
    if (
      edge.releaseAuthority.selectionDigest !==
      standalone.releaseAuthority.selectionDigest
    ) {
      fail('local profiles used different release selections');
    }
    evidence.push({
      family: 'local',
      catalogConsumptionDigest: localConsumption.contentDigest,
      selectionDigest: edge.releaseAuthority.selectionDigest,
      reports: [
        {
          profile: 'edge',
          digest: input.local.edge.digest,
          generation: edge.generation,
        },
        {
          profile: 'standalone',
          digest: input.local.standalone.digest,
          generation: standalone.generation,
        },
      ],
      verification: {
        exactRepoDigest: true,
        rolloutActive: true,
        sqliteBackupRestore: true,
        gracefulCleanup: true,
      },
    });
  } else if (input.local !== undefined) {
    fail('local deployment evidence is forbidden for cluster scope');
  }
  if (identity.releaseScope !== 'local') {
    const clusterConsumption = validateConsumption(
      input.cluster?.consumption,
      identity,
      'cluster deployment',
    );
    validateEvidenceCatalog(clusterConsumption, finalizer);
    const cluster = validateClusterReport(
      input.cluster?.report,
      clusterConsumption,
      identity,
    );
    evidence.push({
      family: 'cluster',
      catalogConsumptionDigest: clusterConsumption.contentDigest,
      reportDigest: input.cluster.report.digest,
      kubernetes: {
        serverVersion: cluster.kubernetes.serverVersion,
        architecture: cluster.kubernetes.architecture,
        nodeCount: cluster.kubernetes.nodeCount,
      },
      verification: {
        immutableImages: true,
        serverSideDryRun: true,
        serverSideApply: true,
        receiptAudited: true,
        retirementAudited: true,
        cleanupComplete: true,
      },
    });
  } else if (input.cluster !== undefined) {
    fail('cluster deployment evidence is forbidden for local scope');
  }
  const unsigned = {
    schemaVersion: 1,
    schema: SCHEMA,
    release,
    sourceRepository: identity.sourceRepository,
    catalog: {
      schema: CATALOG_CONSUMPTION_SCHEMA,
      immutableReference: finalizer.immutableReference,
      manifestDigest: finalizer.catalogManifestDigest,
      releaseSetDigest: finalizer.releaseSetDigest,
      finalizerConsumptionDigest: finalizer.contentDigest,
    },
    requiredDeploymentFamilies: requiredFamilies(identity.releaseScope),
    evidence,
    verification: { ...VERIFICATION },
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  });
}

function validateDeploymentReadinessReceipt(receipt, binding = {}) {
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'schema',
      'release',
      'sourceRepository',
      'catalog',
      'requiredDeploymentFamilies',
      'evidence',
      'verification',
      'receiptDigest',
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.schema !== SCHEMA ||
    !exactKeys(receipt.release, [
      'version',
      'sourceRevision',
      'sourceRef',
      'scope',
    ]) ||
    receipt.release.sourceRef !== `refs/tags/v${receipt.release.version}` ||
    !REVISION_PATTERN.test(receipt.release.sourceRevision || '') ||
    !['local', 'cluster', 'all'].includes(receipt.release.scope) ||
    !REPOSITORY_PATTERN.test(receipt.sourceRepository || '') ||
    !exactKeys(receipt.catalog, [
      'schema',
      'immutableReference',
      'manifestDigest',
      'releaseSetDigest',
      'finalizerConsumptionDigest',
    ]) ||
    receipt.catalog.schema !== CATALOG_CONSUMPTION_SCHEMA ||
    !DIGEST_PATTERN.test(receipt.catalog.manifestDigest || '') ||
    !DIGEST_PATTERN.test(receipt.catalog.releaseSetDigest || '') ||
    !DIGEST_PATTERN.test(receipt.catalog.finalizerConsumptionDigest || '') ||
    !receipt.catalog.immutableReference.endsWith(
      `@${receipt.catalog.manifestDigest}`,
    ) ||
    JSON.stringify(receipt.requiredDeploymentFamilies) !==
      JSON.stringify(requiredFamilies(receipt.release.scope)) ||
    !Array.isArray(receipt.evidence) ||
    JSON.stringify(receipt.evidence.map((entry) => entry.family)) !==
      JSON.stringify(receipt.requiredDeploymentFamilies) ||
    JSON.stringify(receipt.verification) !== JSON.stringify(VERIFICATION) ||
    !DIGEST_PATTERN.test(receipt.receiptDigest || '')
  ) {
    fail('deployment readiness receipt shape is invalid');
  }
  const { receiptDigest, ...unsigned } = receipt;
  if (receiptDigest !== sha256(JSON.stringify(unsigned))) {
    fail('deployment readiness receipt digest is invalid');
  }
  if (
    (binding.release !== undefined &&
      JSON.stringify(receipt.release) !== JSON.stringify(binding.release)) ||
    (binding.sourceRepository !== undefined &&
      receipt.sourceRepository !== binding.sourceRepository) ||
    (binding.releaseSetDigest !== undefined &&
      receipt.catalog.releaseSetDigest !== binding.releaseSetDigest) ||
    (binding.catalogManifestDigest !== undefined &&
      receipt.catalog.manifestDigest !== binding.catalogManifestDigest) ||
    (binding.immutableReference !== undefined &&
      receipt.catalog.immutableReference !== binding.immutableReference)
  ) {
    fail('deployment readiness receipt authority is detached');
  }
  for (const entry of receipt.evidence) {
    if (
      !DIGEST_PATTERN.test(entry.catalogConsumptionDigest || '') ||
      (entry.family === 'local' &&
        (!exactKeys(entry, [
          'family',
          'catalogConsumptionDigest',
          'selectionDigest',
          'reports',
          'verification',
        ]) ||
          !DIGEST_PATTERN.test(entry.selectionDigest || '') ||
          !Array.isArray(entry.reports) ||
          entry.reports.length !== 2 ||
          JSON.stringify(entry.reports.map((report) => report.profile)) !==
            JSON.stringify(['edge', 'standalone']) ||
          entry.reports.some(
            (report) =>
              !exactKeys(report, ['profile', 'digest', 'generation']) ||
              !DIGEST_PATTERN.test(report.digest || '') ||
              !Number.isSafeInteger(report.generation) ||
              report.generation < 1,
          ) ||
          JSON.stringify(entry.verification) !==
            JSON.stringify({
              exactRepoDigest: true,
              rolloutActive: true,
              sqliteBackupRestore: true,
              gracefulCleanup: true,
            }))) ||
      (entry.family === 'cluster' &&
        (!exactKeys(entry, [
          'family',
          'catalogConsumptionDigest',
          'reportDigest',
          'kubernetes',
          'verification',
        ]) ||
          !DIGEST_PATTERN.test(entry.reportDigest || '') ||
          !exactKeys(entry.kubernetes, [
            'serverVersion',
            'architecture',
            'nodeCount',
          ]) ||
          typeof entry.kubernetes.serverVersion !== 'string' ||
          entry.kubernetes?.nodeCount !== 3 ||
          !/^linux\/(?:amd64|arm64)$/u.test(
            entry.kubernetes?.architecture || '',
          ) ||
          JSON.stringify(entry.verification) !==
            JSON.stringify({
              immutableImages: true,
              serverSideDryRun: true,
              serverSideApply: true,
              receiptAudited: true,
              retirementAudited: true,
              cleanupComplete: true,
            }))) ||
      !['local', 'cluster'].includes(entry.family)
    ) {
      fail('deployment readiness evidence summary is invalid');
    }
  }
  return receipt;
}

function auditDeploymentReadinessReceipt(actual, input) {
  const expected = createDeploymentReadinessReceipt(input);
  validateDeploymentReadinessReceipt(actual);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('deployment readiness receipt differs from the exact live evidence');
  }
  return Object.freeze({
    compatible: true,
    releaseScope: actual.release.scope,
    releaseSetDigest: actual.catalog.releaseSetDigest,
    catalogManifestDigest: actual.catalog.manifestDigest,
    requiredDeploymentFamilies: [...actual.requiredDeploymentFamilies],
    reportCount: actual.evidence.reduce(
      (count, entry) => count + (entry.family === 'local' ? 2 : 1),
      0,
    ),
    tagMutation: false,
  });
}

function canonicalAbsolute(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    fail(`${label} path must be canonical and absolute`);
  }
  return value;
}

function readCanonicalReport(filePath, label) {
  const resolved = canonicalAbsolute(filePath, label);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_REPORT_BYTES ||
    fs.realpathSync(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    fail(`${label} must be one owner-private bounded regular file`);
  }
  const contents = fs.readFileSync(resolved);
  let value;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (!contents.equals(Buffer.from(canonicalJson(value), 'utf8'))) {
    fail(`${label} must use canonical JSON encoding`);
  }
  return Object.freeze({ value, digest: sha256(contents) });
}

function writeNoReplace(filePath, value) {
  const resolved = canonicalAbsolute(filePath, 'output');
  const parent = fs.lstatSync(path.dirname(resolved));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail('output parent must be one canonical directory');
  }
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJson(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (!['create', 'audit'].includes(values.mode)) fail('arguments are invalid');
  const common = [
    'finalizer-consumption-bundle',
    'mode',
    'release-scope',
    'repository-owner',
    'source-ref',
    'source-repository',
    'source-revision',
    'version',
  ];
  const local =
    values['release-scope'] === 'cluster'
      ? []
      : ['edge-report', 'local-consumption-bundle', 'standalone-report'];
  const cluster =
    values['release-scope'] === 'local'
      ? []
      : ['cluster-consumption-bundle', 'cluster-report'];
  const terminal = values.mode === 'create' ? ['output'] : ['receipt'];
  const expected = [...common, ...local, ...cluster, ...terminal].sort();
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    version: values.version,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    releaseScope: values['release-scope'],
    repositoryOwner: values['repository-owner'],
    sourceRepository: values['source-repository'],
    finalizerConsumptionBundle: values['finalizer-consumption-bundle'],
    localConsumptionBundle: values['local-consumption-bundle'],
    edgeReport: values['edge-report'],
    standaloneReport: values['standalone-report'],
    clusterConsumptionBundle: values['cluster-consumption-bundle'],
    clusterReport: values['cluster-report'],
    output: values.output,
    receipt: values.receipt,
  });
}

function evidenceInput(options) {
  const identity = {
    version: options.version,
    sourceRevision: options.sourceRevision,
    sourceRef: options.sourceRef,
    releaseScope: options.releaseScope,
    repositoryOwner: options.repositoryOwner,
    sourceRepository: options.sourceRepository,
  };
  const auditOptions = {
    ...identity,
    outputDirectory: options.finalizerConsumptionBundle,
  };
  const input = {
    identity,
    finalizerConsumption: auditCeremonyBundle(auditOptions),
  };
  if (options.releaseScope !== 'cluster') {
    input.local = {
      consumption: auditCeremonyBundle({
        ...identity,
        outputDirectory: options.localConsumptionBundle,
      }),
      edge: readCanonicalReport(options.edgeReport, 'edge report'),
      standalone: readCanonicalReport(
        options.standaloneReport,
        'standalone report',
      ),
    };
  }
  if (options.releaseScope !== 'local') {
    input.cluster = {
      consumption: auditCeremonyBundle({
        ...identity,
        outputDirectory: options.clusterConsumptionBundle,
      }),
      report: readCanonicalReport(options.clusterReport, 'cluster report'),
    };
  }
  return input;
}

function runCli(argv, output = process.stdout) {
  const options = parseArguments(argv);
  const input = evidenceInput(options);
  if (options.mode === 'create') {
    const receipt = createDeploymentReadinessReceipt(input);
    writeNoReplace(options.output, receipt);
    output.write(canonicalJson(receipt));
    return receipt;
  }
  const actual = readCanonicalReport(
    options.receipt,
    'deployment readiness receipt',
  ).value;
  const audit = auditDeploymentReadinessReceipt(actual, input);
  output.write(canonicalJson(audit));
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'release deployment readiness failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA,
  QingLong3ReleaseDeploymentReadinessError,
  auditDeploymentReadinessReceipt,
  createDeploymentReadinessReceipt,
  parseArguments,
  runCli,
  validateDeploymentReadinessReceipt,
});
