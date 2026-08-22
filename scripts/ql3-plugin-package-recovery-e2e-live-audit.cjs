#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  postgresqlControlSchemaContract,
  postgresqlMainMigrationStream,
} = require('../packages/ql3-cluster-postgres/dist/migration/migration.js');

const FIXTURE = 'qinglong/plugin-package-recovery-e2e-live-contract@v3';
const CONTRACT_VERSION = postgresqlControlSchemaContract.contractVersion;
const MIGRATION_COUNT = postgresqlMainMigrationStream.migrations.length;
const LIMITATIONS = Object.freeze([
  'isolated PostgreSQL uses explicit TLS disable; production manifests remain verify-full',
  'the authenticated HTTPS OCI Distribution fixture implements the immutable GET/referrers surface used by the resolver, not a production registry storage implementation',
  'the disposable Kind control plane is single-replica; this gate proves workload ordering, not Kubernetes control-plane HA',
]);
const GATE_KEYS = Object.freeze([
  'healthyInitialActivation',
  'invalidUpgradeRejectedBeforeActivation',
  'activePointerUidUnchanged',
  'activePointerResourceVersionUnchanged',
  'activePointerJsonUnchanged',
  'candidateRevisionAbsent',
  'exactAuthenticatedOciRequests',
  'recoveryRbacLeastPrivilege',
  'runtimeRolledOutAfterRecovery',
  'passed',
]);
const BANNED_KEYS = new Set([
  'activejson',
  'assertion',
  'authorization',
  'bearer',
  'certificate',
  'connectionstring',
  'credential',
  'dsn',
  'kubeconfig',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function exactKeys(value, expected) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...expected].sort()),
  );
}

function imageDigest(value) {
  if (typeof value !== 'string') return undefined;
  return value.match(/sha256:[a-f0-9]{64}$/)?.[0];
}

function safeToken(value, maximum = 256) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)
  );
}

function sensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:CERTIFICATE|(?:RSA |EC |OPENSSH )?PRIVATE KEY)-----/.test(
        value,
      ) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\bBasic\s+[A-Za-z0-9+/=_-]{8,}/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\./.test(value) ||
      /\bqlsecret(?::|\/\/)/i.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => sensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([entryKey, entry]) =>
      sensitiveMaterial(entry, entryKey),
    );
  }
  return false;
}

function validIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validRuntime(report) {
  const runtime = report.runtime;
  const ordering = report.ordering;
  return (
    exactKeys(runtime, [
      'replicas',
      'creationTimestamp',
      'recoveryJobUid',
      'recoveryCompletedAt',
      'nodes',
      'imageIds',
    ]) &&
    runtime.replicas === 2 &&
    runtime.creationTimestamp === ordering?.runtimeCreatedAt &&
    runtime.recoveryJobUid === ordering?.upgradeRecoveryJobUid &&
    runtime.recoveryCompletedAt === ordering?.upgradeRecoveryCompletedAt &&
    Array.isArray(runtime.nodes) &&
    runtime.nodes.length === 2 &&
    new Set(runtime.nodes).size === 2 &&
    runtime.nodes.every((value) => safeToken(value)) &&
    Array.isArray(runtime.imageIds) &&
    runtime.imageIds.length === 1 &&
    imageDigest(runtime.imageIds[0]) === report.images?.controlBuildId
  );
}

function validatePluginPackageRecoveryE2ELiveReport(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'schema',
      'observedAt',
      'sourceRevision',
      'passed',
      'cluster',
      'architecture',
      'elapsedMs',
      'images',
      'ordering',
      'failedUpgrade',
      'database',
      'oci',
      'kubernetes',
      'runtime',
      'gates',
      'limitations',
    ]) ||
    report?.schema !== FIXTURE ||
    report?.passed !== true ||
    !validIso(report?.observedAt) ||
    !/^[a-f0-9]{40}$/.test(report?.sourceRevision ?? '') ||
    !/^ql3-plugin-recovery-e2e(?:-[a-z0-9](?:[-a-z0-9]{0,24}[a-z0-9])?)?$/.test(
      report?.cluster ?? '',
    ) ||
    !['amd64', 'arm64'].includes(report?.architecture) ||
    !Number.isSafeInteger(report?.elapsedMs) ||
    report.elapsedMs < 1 ||
    report.elapsedMs > 60 * 60 * 1000
  ) {
    findings.push(
      finding('QL3_PLUGIN_RECOVERY_E2E_ENVELOPE', 'report envelope is invalid'),
    );
  }

  const images = report?.images;
  if (
    !exactKeys(images, [
      'adminBuildId',
      'adminSourceRevision',
      'controlBuildId',
      'controlSourceRevision',
      'postgresRepositoryDigest',
      'migrationImageId',
      'initialRecoveryImageId',
      'upgradeRecoveryImageId',
      'postgresImageId',
    ]) ||
    !SHA256_ID.test(images?.adminBuildId ?? '') ||
    !SHA256_ID.test(images?.controlBuildId ?? '') ||
    images?.adminSourceRevision !== report?.sourceRevision ||
    images?.controlSourceRevision !== report?.sourceRevision ||
    images?.postgresRepositoryDigest !==
      'postgres@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296' ||
    !imageDigest(images?.migrationImageId) ||
    imageDigest(images?.initialRecoveryImageId) !==
      imageDigest(images?.migrationImageId) ||
    imageDigest(images?.upgradeRecoveryImageId) !==
      imageDigest(images?.migrationImageId) ||
    !imageDigest(images?.postgresImageId)
  ) {
    findings.push(
      finding('QL3_PLUGIN_RECOVERY_E2E_IMAGES', 'image provenance is invalid'),
    );
  }

  const ordering = report?.ordering;
  const timeKeys = [
    'migrationCompletedAt',
    'initialRecoveryCompletedAt',
    'upgradeRecoveryCompletedAt',
    'runtimeCreatedAt',
  ];
  const uidKeys = [
    'migrationJobUid',
    'initialRecoveryJobUid',
    'upgradeRecoveryJobUid',
    'runtimeBoundRecoveryJobUid',
  ];
  const times = timeKeys.map((key) => Date.parse(ordering?.[key]));
  if (
    !exactKeys(ordering, [...uidKeys, ...timeKeys]) ||
    uidKeys.some((key) => !UUID.test(ordering?.[key] ?? '')) ||
    ordering?.runtimeBoundRecoveryJobUid !==
      ordering?.upgradeRecoveryJobUid ||
    timeKeys.some((key) => !validIso(ordering?.[key])) ||
    times.some((value, index) => index > 0 && value < times[index - 1])
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_ORDERING',
        'Job and rollout ordering is invalid',
      ),
    );
  }

  const failed = report?.failedUpgrade;
  if (
    !exactKeys(failed, [
      'recoveryJobUid',
      'rejectionReason',
      'candidateRevisionCount',
      'activePointerUnchanged',
    ]) ||
    failed?.recoveryJobUid !== ordering?.upgradeRecoveryJobUid ||
    failed?.rejectionReason !== 'activation_fact_conflict' ||
    failed?.candidateRevisionCount !== 0 ||
    failed?.activePointerUnchanged !== true
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_FAILED_UPGRADE',
        'failed upgrade evidence is invalid',
      ),
    );
  }

  const database = report?.database;
  const databaseKeys = [
    'migrationCount',
    'capabilityVersion',
    'initialState',
    'initialActiveLockDigest',
    'upgradeState',
    'upgradePreviousActiveLockDigest',
    'upgradeActiveLockDigest',
    'upgradeFailureReason',
    'initialMutationCount',
    'upgradeMutationCount',
    'headInstallationId',
    'initialRevisionCount',
    'upgradeRevisionCount',
    'recoverableCount',
  ];
  if (
    !exactKeys(database, databaseKeys) ||
    database?.migrationCount !== MIGRATION_COUNT ||
    database?.capabilityVersion !== CONTRACT_VERSION ||
    database?.initialState !== 'active' ||
    database?.upgradeState !== 'failed' ||
    !SHA256.test(database?.initialActiveLockDigest ?? '') ||
    database?.upgradePreviousActiveLockDigest !==
      database?.initialActiveLockDigest ||
    database?.upgradeActiveLockDigest !== database?.initialActiveLockDigest ||
    database?.upgradeFailureReason !== 'activation_fact_conflict' ||
    database?.initialMutationCount !== 4 ||
    database?.upgradeMutationCount !== 3 ||
    database?.headInstallationId !== 'install-plugin-recovery-e2e-upgrade' ||
    database?.initialRevisionCount !== 1 ||
    database?.upgradeRevisionCount !== 0 ||
    database?.recoverableCount !== 0
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_DATABASE',
        'durable database evidence is invalid',
      ),
    );
  }

  const oci = report?.oci;
  if (
    !exactKeys(oci, [
      'https',
      'authentication',
      'authenticatedRequestCount',
      'requestCount',
      'uniquePaths',
      'initialRequestCount',
      'upgradeRequestCount',
      'redirects',
    ]) ||
    oci?.https !== true ||
    oci?.authentication !== 'exact-registry-basic' ||
    oci?.authenticatedRequestCount !== 24 ||
    oci?.requestCount !== 24 ||
    oci?.uniquePaths !== 12 ||
    oci?.initialRequestCount !== 12 ||
    oci?.upgradeRequestCount !== 12 ||
    oci?.redirects !== 0
  ) {
    findings.push(
      finding('QL3_PLUGIN_RECOVERY_E2E_OCI', 'OCI request evidence is invalid'),
    );
  }

  const kubernetes = report?.kubernetes;
  const pointer = kubernetes?.activePointer;
  const rbac = kubernetes?.rbac;
  if (
    !exactKeys(kubernetes, ['activePointer', 'rbac']) ||
    !exactKeys(pointer, [
      'name',
      'uid',
      'resourceVersion',
      'activeJsonDigest',
      'intentDigest',
      'activationRef',
    ]) ||
    !safeToken(pointer?.name) ||
    !UUID.test(pointer?.uid ?? '') ||
    !/^[1-9][0-9]*$/.test(pointer?.resourceVersion ?? '') ||
    !SHA256.test(pointer?.activeJsonDigest ?? '') ||
    !SHA256.test(pointer?.intentDigest ?? '') ||
    !safeToken(pointer?.activationRef) ||
    !exactKeys(rbac, [
      'getConfigMaps',
      'createConfigMaps',
      'updateConfigMaps',
      'listConfigMaps',
      'deleteConfigMaps',
      'getSecrets',
    ]) ||
    rbac?.getConfigMaps !== true ||
    rbac?.createConfigMaps !== true ||
    rbac?.updateConfigMaps !== true ||
    rbac?.listConfigMaps !== false ||
    rbac?.deleteConfigMaps !== false ||
    rbac?.getSecrets !== false
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_KUBERNETES',
        'active pointer or RBAC evidence is invalid',
      ),
    );
  }

  if (!validRuntime(report ?? {})) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_RUNTIME',
        'runtime rollout evidence is invalid',
      ),
    );
  }
  if (
    !exactKeys(report?.gates, GATE_KEYS) ||
    GATE_KEYS.some((key) => report?.gates?.[key] !== true)
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_GATES',
        'every gate must be explicitly true',
      ),
    );
  }
  if (
    !Array.isArray(report?.limitations) ||
    JSON.stringify([...report.limitations].sort()) !==
      JSON.stringify([...LIMITATIONS].sort())
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_LIMITATIONS',
        'limitations must remain exact',
      ),
    );
  }
  if (sensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_PLUGIN_RECOVERY_E2E_SENSITIVE',
        'report contains a forbidden key or sensitive material',
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function readPrivateReport(filePath) {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new Error('report path must be absolute and canonical');
  }
  const before = fs.lstatSync(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > 1024 * 1024 ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'report must be an owner-private regular file between 2 bytes and 1 MiB',
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error('report identity or mode changed while opening');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const currentPath = fs.lstatSync(filePath);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      currentPath.dev !== opened.dev ||
      currentPath.ino !== opened.ino ||
      currentPath.size !== opened.size ||
      (currentPath.mode & 0o777) !== 0o600
    ) {
      throw new Error('report changed while reading');
    }
    return JSON.parse(text);
  } finally {
    fs.closeSync(descriptor);
  }
}

function main(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--report=')) {
    throw new Error(
      'usage: ql3-plugin-package-recovery-e2e-live-audit --report=/absolute/report.json',
    );
  }
  const result = validatePluginPackageRecoveryE2ELiveReport(
    readPrivateReport(argv[0].slice('--report='.length)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `QL3 Plugin Package recovery E2E live audit failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 2;
  }
}

module.exports = {
  CONTRACT_VERSION,
  FIXTURE,
  GATE_KEYS,
  LIMITATIONS,
  MIGRATION_COUNT,
  readPrivateReport,
  validatePluginPackageRecoveryE2ELiveReport,
};
