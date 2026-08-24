#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_FIXTURE =
  'qinglong/plugin-package-secret-binding-kubernetes-live@v1';
const FIXTURE = 'qinglong/plugin-package-secret-binding-kubernetes-live@v2';
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_KEY =
  /(secretRef|secretValue|material|assertion|jwt|password|dsn|privateKey|certificate|kubeconfig|podUid|nodeUid|podName|nodeName)/i;
const CORE_GATES = Object.freeze([
  'realThreeNodeKubernetes',
  'twoManagementReplicasOnDistinctNodes',
  'formalHttpsClientCommands',
  'planReplayedAcrossReplicas',
  'separationOfDutyDecision',
  'authorizedInspection',
  'realExecutorJob',
  'projectedSecretMetadataAccepted',
  'bindingPublishedExactlyOnce',
  'managementCannotReadSecrets',
  'managementDoesNotMountPackageValues',
  'executorCannotReadSecrets',
  'executorHasNoServiceAccountToken',
  'executorProjectionReadOnly',
  'databaseContainsNoSensitiveValue',
]);
const LEGACY_REQUIRED_GATES = Object.freeze([
  ...CORE_GATES,
  'passed',
]);
const REQUIRED_GATES = Object.freeze([
  ...CORE_GATES,
  'twoProviderReplicasOnDistinctNodes',
  'productionMountedProviderUsed',
  'atomicProjectionRotationObserved',
  'providerCannotReadSecretApi',
  'providerHasNoServiceAccountToken',
  'providerProjectionReadOnly',
  'providerOutputSensitiveFree',
  'missingProjectionFailsClosed',
  'passed',
]);

function exact(value, keys) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...keys].sort()),
  );
}

function scan(value, findings, location = 'report') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scan(entry, findings, `${location}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key))
      findings.push(`${location}.${key} is forbidden`);
    if (
      typeof entry === 'string' &&
      /(qlsecret:v1:|-----BEGIN |postgres(?:ql)?:\/\/|eyJ[A-Za-z0-9_-]+\.)/.test(
        entry,
      )
    ) {
      findings.push(`${location}.${key} contains sensitive material`);
    }
    scan(entry, findings, `${location}.${key}`);
  }
}

function validatePluginPackageSecretBindingKubernetesLiveReport(report) {
  const findings = [];
  const legacy =
    report?.schemaVersion === 1 && report?.fixture === LEGACY_FIXTURE;
  const current = report?.schemaVersion === 2 && report?.fixture === FIXTURE;
  if (
    (!legacy && !current) ||
    !exact(report, [
      'schemaVersion', 'fixture', 'observedAtMs', 'platform', 'management',
      'review', 'executor', 'persistence', ...(current ? ['provider'] : []),
      'gates', 'limitations',
    ]) ||
    !Number.isSafeInteger(report.observedAtMs) ||
    report.observedAtMs < 1
  ) {
    findings.push('report envelope is invalid');
  }
  if (
    !exact(report.platform, [
      'architecture', 'kubernetesVersion', 'nodeCount',
      'postgresVersionNumber', 'adminImageId',
      ...(current ? ['controlImageId'] : []),
    ]) ||
    !['amd64', 'arm64'].includes(report.platform?.architecture) ||
    typeof report.platform?.kubernetesVersion !== 'string' ||
    report.platform?.nodeCount !== 3 ||
    report.platform?.postgresVersionNumber !== 180004 ||
    !SHA256.test(report.platform?.adminImageId ?? '') ||
    (current && !SHA256.test(report.platform?.controlImageId ?? ''))
  ) {
    findings.push('platform evidence is invalid');
  }
  if (
    !exact(report.management, [
      'replicas',
      'distinctNodeHashes',
      'serviceAccountTokenMounted',
      'packageValueVolumeMounted',
      'canGetSecrets',
      'canListSecrets',
    ]) ||
    report.management?.replicas !== 2 ||
    !Array.isArray(report.management?.distinctNodeHashes) ||
    report.management.distinctNodeHashes.length !== 2 ||
    new Set(report.management.distinctNodeHashes).size !== 2 ||
    !report.management.distinctNodeHashes.every((value) =>
      SHA256.test(value),
    ) ||
    report.management.serviceAccountTokenMounted !== false ||
    report.management.packageValueVolumeMounted !== false ||
    report.management.canGetSecrets !== false ||
    report.management.canListSecrets !== false
  ) {
    findings.push('management isolation evidence is invalid');
  }
  if (
    !exact(report.review, [
      'commands',
      'requesterSubjectHash',
      'reviewerSubjectHash',
      'distinctUsers',
      'planStatus',
      'replayStatus',
      'decisionStatus',
      'inspectionStale',
      'actionDigest',
      'planDigest',
    ]) ||
    JSON.stringify(report.review?.commands) !==
      JSON.stringify([
        'plugin-package.secret-binding.plan',
        'plugin-package.secret-binding.plan',
        'plugin-package.secret-binding.propose',
        'plugin-package.secret-binding.decide',
        'plugin-package.secret-binding.inspect',
      ]) ||
    !SHA256.test(report.review?.requesterSubjectHash ?? '') ||
    !SHA256.test(report.review?.reviewerSubjectHash ?? '') ||
    report.review?.requesterSubjectHash ===
      report.review?.reviewerSubjectHash ||
    report.review?.distinctUsers !== true ||
    report.review?.planStatus !== 'created' ||
    report.review?.replayStatus !== 'existing' ||
    report.review?.decisionStatus !== 'decided' ||
    report.review?.inspectionStale !== false ||
    !SHA256.test(`sha256:${report.review?.actionDigest ?? ''}`) ||
    !SHA256.test(`sha256:${report.review?.planDigest ?? ''}`)
  ) {
    findings.push('review ceremony evidence is invalid');
  }
  if (
    !exact(report.executor, [
      'jobSucceeded',
      'serviceAccountTokenMounted',
      'canGetSecrets',
      'canListSecrets',
      'projectionReadOnly',
      'projectionFileCount',
      'projectionKeyHash',
      'outputSensitiveFree',
    ]) ||
    report.executor?.jobSucceeded !== true ||
    report.executor?.serviceAccountTokenMounted !== false ||
    report.executor?.canGetSecrets !== false ||
    report.executor?.canListSecrets !== false ||
    report.executor?.projectionReadOnly !== true ||
    report.executor?.projectionFileCount !== 1 ||
    !SHA256.test(report.executor?.projectionKeyHash ?? '') ||
    report.executor?.outputSensitiveFree !== true
  ) {
    findings.push('executor projection evidence is invalid');
  }
  if (
    !exact(report.persistence, [
      'bindingCount',
      'authorityKind',
      'evidenceDigest',
      'entryCount',
      'approvalConsumed',
      'executionSucceeded',
      'sensitiveMatchCount',
    ]) ||
    report.persistence?.bindingCount !== 1 ||
    report.persistence?.authorityKind !== 'approved-action-execution' ||
    !SHA256.test(`sha256:${report.persistence?.evidenceDigest ?? ''}`) ||
    report.persistence?.entryCount !== 1 ||
    report.persistence?.approvalConsumed !== true ||
    report.persistence?.executionSucceeded !== true ||
    report.persistence?.sensitiveMatchCount !== 0
  ) {
    findings.push('durable binding evidence is invalid');
  }
  if (
    current &&
    (!exact(report.provider, [
      'provider',
      'replicas',
      'distinctNodeHashes',
      'serviceAccountTokenMounted',
      'canGetSecrets',
      'canListSecrets',
      'canPatchSecrets',
      'projectionReadOnly',
      'projectionMode',
      'firstGenerationObserved',
      'rotatedGenerationObserved',
      'resourceVersionAdvanced',
      'outputSensitiveFree',
      'missingProjectionRejected',
      'missingErrorCode',
    ]) ||
      report.provider?.provider !== 'mounted-files' ||
      report.provider?.replicas !== 2 ||
      !Array.isArray(report.provider?.distinctNodeHashes) ||
      report.provider.distinctNodeHashes.length !== 2 ||
      new Set(report.provider.distinctNodeHashes).size !== 2 ||
      !report.provider.distinctNodeHashes.every((value) =>
        SHA256.test(value),
      ) ||
      report.provider.serviceAccountTokenMounted !== false ||
      report.provider.canGetSecrets !== false ||
      report.provider.canListSecrets !== false ||
      report.provider.canPatchSecrets !== false ||
      report.provider.projectionReadOnly !== true ||
      report.provider.projectionMode !== '0440' ||
      report.provider.firstGenerationObserved !== 2 ||
      report.provider.rotatedGenerationObserved !== 2 ||
      report.provider.resourceVersionAdvanced !== true ||
      report.provider.outputSensitiveFree !== true ||
      report.provider.missingProjectionRejected !== true ||
      report.provider.missingErrorCode !==
        'QL3_CLUSTER_MOUNTED_SECRET_UNAVAILABLE')
  ) {
    findings.push('mounted provider evidence is invalid');
  }
  const requiredGates = current ? REQUIRED_GATES : LEGACY_REQUIRED_GATES;
  if (
    !exact(report.gates, requiredGates) ||
    requiredGates.some((gate) => report.gates?.[gate] !== true)
  ) {
    findings.push('one or more required gates are false or missing');
  }
  if (
    !Array.isArray(report.limitations) ||
    report.limitations.length !== (current ? 3 : 2) ||
    report.limitations.some(
      (value) =>
        typeof value !== 'string' || value.length < 16 || value.length > 512,
    )
  ) {
    findings.push('limitations are invalid');
  }
  scan(report, findings);
  return Object.freeze({
    schemaVersion: 1,
    fixture: current ? FIXTURE : LEGACY_FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function main(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--report=/')) {
    throw new Error(
      'usage: ql3-plugin-package-secret-binding-kubernetes-live-audit --report=/absolute/report.json',
    );
  }
  const reportPath = argv[0].slice('--report='.length);
  if (path.resolve(reportPath) !== reportPath)
    throw new Error('report path is invalid');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const result = validatePluginPackageSecretBindingKubernetesLiveReport(report);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `QL3 Secret binding Kubernetes live audit failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  LEGACY_FIXTURE,
  LEGACY_REQUIRED_GATES,
  REQUIRED_GATES,
  validatePluginPackageSecretBindingKubernetesLiveReport,
};
