#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/cloudnativepg-disaster-recovery@v1';
const EXPECTED_ROLES = Object.freeze([
  'ql3_admin',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_ai_maintenance',
  'ql3_approval_manager',
  'ql3_automation_manager',
  'ql3_migration',
  'ql3_package_executor',
  'ql3_package_manager',
  'ql3_runtime',
  'ql3_worker_credential_executor',
  'ql3_worker_credential_manager',
  'ql3_worker_ingress',
]);
const EXPECTED_PLATFORM_IMAGES = Object.freeze({
  amd64: Object.freeze({
    barmanController:
      'sha256:417449fe4f6f0a56acdeb30e4131930815f2b46b9afeb808059b57aa8b4c2ef5',
    barmanSidecar:
      'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
    certManager: Object.freeze([
      'sha256:1e4af57beb469cc3bb0fb48b9201caea2723819b9ffd3c3ea98568f55b4dd38b',
      'sha256:a2b12d27950d1603d2c8168c3ccd95d07b93ce6ec4b530316196a31db592a9c0',
      'sha256:953a97df613f7da7eda8ce4b1c8d8e6b50963db0800fab595d040db6eb5cb060',
    ]),
  }),
  arm64: Object.freeze({
    barmanController:
      'sha256:de612e3ad8633a198b91ffbea53848407424155daf2183d656490d843a83b100',
    barmanSidecar:
      'sha256:f53e168e341661cd76334215ead9dfd69f06117685d3232206192cf25218da71',
    certManager: Object.freeze([
      'sha256:af62a025ae4f8fd03209b5e0760868296bad5a9370aab0c91ad3b5476bcb282d',
      'sha256:3c052c134ad1b93122b957f4d214aaa9d85a37b5ff15acc5b4d86f50e3ed822e',
      'sha256:7c510875e038f79f7fba707b5f86d8736777a4dfefcd42179b08844ee75e685b',
    ]),
  }),
});
const BANNED_KEYS = new Set([
  'password',
  'secret',
  'token',
  'accesskey',
  'accesskeyid',
  'secretaccesskey',
  'privatekey',
  'tlskey',
  'connectionstring',
]);

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSourceRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isWal(value) {
  return typeof value === 'string' && /^[0-9A-F]{24}$/.test(value);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function exactJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
      /\bql3w_[A-Za-z0-9_-]+\b/.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) =>
      containsSensitiveMaterial(child, childKey),
    );
  }
  return false;
}

function exactRoles(roles) {
  return (
    Array.isArray(roles) &&
    roles.length === EXPECTED_ROLES.length &&
    roles.every(
      (role, index) =>
        exactKeys(role, [
          'name',
          'superuser',
          'createdb',
          'createrole',
          'replication',
          'bypassrls',
        ]) &&
        role.name === EXPECTED_ROLES[index] &&
        role.superuser === false &&
        role.createdb === false &&
        role.createrole === false &&
        role.replication === false &&
        role.bypassrls === false,
    )
  );
}

function validRestore(restore, expectedCluster, includeTargetTime = false) {
  const keys = [
    'cluster',
    'sourceObjectStore',
    'sourceServerName',
    'sourceClusterUnmodified',
    'targetWalArchiver',
    'instances',
    'ready',
    'migrationCount',
    'controlCoreCapability',
    'databaseOwner',
    'synchronousCommit',
    'synchronousStandbys',
    'roles',
    'beforeMarkerPresent',
    'afterMarkerPresent',
  ];
  if (includeTargetTime) keys.push('targetTime');
  return (
    exactKeys(restore, keys) &&
    restore.cluster === expectedCluster &&
    restore.sourceObjectStore === 'ql3-postgres-recovery-source' &&
    restore.sourceServerName === 'ql3-postgres' &&
    restore.sourceClusterUnmodified === true &&
    restore.targetWalArchiver === false &&
    restore.instances === 3 &&
    restore.ready === true &&
    restore.migrationCount === 54 &&
    restore.controlCoreCapability === 53 &&
    restore.databaseOwner === 'ql3_migration' &&
    restore.synchronousCommit === 'remote_apply' &&
    restore.synchronousStandbys === 1 &&
    exactRoles(restore.roles) &&
    restore.beforeMarkerPresent === true
  );
}

function validRotationIdentity(identity) {
  return (
    exactKeys(identity, [
      'previousSerialSha256',
      'currentSerialSha256',
      'previousSecretResourceVersion',
      'currentSecretResourceVersion',
    ]) &&
    isSha256(identity.previousSerialSha256) &&
    isSha256(identity.currentSerialSha256) &&
    identity.previousSerialSha256 !== identity.currentSerialSha256 &&
    typeof identity.previousSecretResourceVersion === 'string' &&
    identity.previousSecretResourceVersion.length > 0 &&
    typeof identity.currentSecretResourceVersion === 'string' &&
    identity.currentSecretResourceVersion.length > 0 &&
    identity.previousSecretResourceVersion !==
      identity.currentSecretResourceVersion
  );
}

function validateCloudNativePgDrEvidence(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'sourceRevision',
      'platform',
      'source',
      'latestRestore',
      'pitrRestore',
      'certificateRotation',
      'objectStoreAuthority',
      'serviceLevels',
      'gates',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt) ||
    !isSourceRevision(report?.sourceRevision)
  ) {
    findings.push(
      finding(
        'QL3_DR_REPORT_SHAPE',
        'the disaster-recovery report must use the exact versioned non-secret envelope',
      ),
    );
  }

  if (containsSensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_DR_SECRET_EXPOSURE',
        'the disaster-recovery report must not contain credentials, tokens, connection strings or private keys',
      ),
    );
  }

  const platform = report?.platform;
  const expectedPlatformImages =
    EXPECTED_PLATFORM_IMAGES[platform?.architecture];
  if (
    !exactKeys(platform, [
      'kubernetesVersion',
      'architecture',
      'cloudNativePgVersion',
      'cloudNativePgImageId',
      'postgresVersionNumber',
      'postgresImageId',
      'barmanVersion',
      'barmanControllerImageId',
      'barmanSidecarImageIds',
      'certManagerVersion',
      'certManagerImageIds',
    ]) ||
    platform?.kubernetesVersion !== '1.32.8' ||
    !['amd64', 'arm64'].includes(platform?.architecture) ||
    platform?.cloudNativePgVersion !== '1.30.0' ||
    !isSha256(platform?.cloudNativePgImageId) ||
    platform?.postgresVersionNumber !== 180004 ||
    !isSha256(platform?.postgresImageId) ||
    platform?.barmanVersion !== '0.13.0' ||
    platform?.barmanControllerImageId !==
      expectedPlatformImages?.barmanController ||
    !Array.isArray(platform?.barmanSidecarImageIds) ||
    platform.barmanSidecarImageIds.length !== 3 ||
    !platform.barmanSidecarImageIds.every(
      (imageId) => imageId === expectedPlatformImages?.barmanSidecar,
    ) ||
    platform?.certManagerVersion !== '1.20.3' ||
    !exactJson(
      platform?.certManagerImageIds,
      expectedPlatformImages?.certManager,
    )
  ) {
    findings.push(
      finding(
        'QL3_DR_PLATFORM_PROVENANCE',
        'the report must bind the exact Kubernetes, CNPG, PostgreSQL, Barman and cert-manager runtime images',
      ),
    );
  }

  const source = report?.source;
  const markers = source?.markers;
  const backup = source?.backup;
  const beforeAt = Date.parse(markers?.before?.createdAt);
  const afterAt = Date.parse(markers?.after?.createdAt);
  if (
    !exactKeys(source, ['cluster', 'backup', 'markers', 'wal']) ||
    source?.cluster !== 'ql3-postgres' ||
    backup?.phase !== 'completed' ||
    typeof backup?.name !== 'string' ||
    backup.name.length === 0 ||
    !isIsoTime(backup?.startedAt) ||
    !isIsoTime(backup?.completedAt) ||
    Date.parse(backup.completedAt) < Date.parse(backup.startedAt) ||
    !isWal(backup?.beginWal) ||
    !isWal(backup?.endWal) ||
    !isUuid(markers?.before?.id) ||
    !isIsoTime(markers?.before?.createdAt) ||
    !isWal(markers?.before?.wal) ||
    !isUuid(markers?.after?.id) ||
    markers.before.id === markers.after.id ||
    !isIsoTime(markers?.after?.createdAt) ||
    !isWal(markers?.after?.wal) ||
    !Number.isFinite(beforeAt) ||
    !Number.isFinite(afterAt) ||
    beforeAt >= afterAt ||
    source?.wal?.archiveHealthy !== true ||
    source?.wal?.continuous !== true ||
    source?.wal?.noGaps !== true ||
    !isWal(source?.wal?.lastArchivedWal)
  ) {
    findings.push(
      finding(
        'QL3_DR_SOURCE_BACKUP_WAL',
        'the source must prove one completed backup, two ordered unique markers and continuous gap-free WAL',
      ),
    );
  }

  if (
    !validRestore(report?.latestRestore, 'ql3-postgres-restore-latest') ||
    report?.latestRestore?.afterMarkerPresent !== true
  ) {
    findings.push(
      finding(
        'QL3_DR_LATEST_RESTORE',
        'latest restore must be isolated, HA-ready and contain both ordered markers with the exact schema and roles',
      ),
    );
  }

  const pitr = report?.pitrRestore;
  const targetAt = Date.parse(pitr?.targetTime);
  if (
    !validRestore(pitr, 'ql3-postgres-restore-pitr', true) ||
    pitr?.afterMarkerPresent !== false ||
    !isIsoTime(pitr?.targetTime) ||
    !Number.isFinite(targetAt) ||
    targetAt <= beforeAt ||
    targetAt >= afterAt
  ) {
    findings.push(
      finding(
        'QL3_DR_PITR_RESTORE',
        'PITR must target between the markers, contain only the first marker and preserve the exact HA/schema/role contract',
      ),
    );
  }

  const authority = report?.objectStoreAuthority;
  if (
    !exactKeys(authority, [
      'sourceObjectStore',
      'recoveryObjectStore',
      'sourceWriterIdentitySha256',
      'recoveryReaderIdentitySha256',
      'recoveryReadOnly',
      'versioning',
      'immutability',
      'lifecycleDays',
    ]) ||
    authority?.sourceObjectStore !== 'ql3-postgres-backup' ||
    authority?.recoveryObjectStore !== 'ql3-postgres-recovery-source' ||
    !isSha256(authority?.sourceWriterIdentitySha256) ||
    !isSha256(authority?.recoveryReaderIdentitySha256) ||
    authority.sourceWriterIdentitySha256 ===
      authority.recoveryReaderIdentitySha256 ||
    authority?.recoveryReadOnly !== true ||
    authority?.versioning !== true ||
    authority?.immutability !== true ||
    !Number.isInteger(authority?.lifecycleDays) ||
    authority.lifecycleDays < 30
  ) {
    findings.push(
      finding(
        'QL3_DR_OBJECT_STORE_AUTHORITY',
        'source and recovery identities must be distinct, recovery read-only, and storage protected for at least 30 days',
      ),
    );
  }

  const rotation = report?.certificateRotation;
  if (
    !exactKeys(rotation, [
      'client',
      'server',
      'walArchivedDuringRotation',
      'backupCompletedAfterRotation',
      'latestRestoreCompletedAfterRotation',
      'pitrCompletedAfterRotation',
      'maxObservedInterruptionSeconds',
    ]) ||
    !validRotationIdentity(rotation?.client) ||
    !validRotationIdentity(rotation?.server) ||
    rotation?.walArchivedDuringRotation !== true ||
    rotation?.backupCompletedAfterRotation !== true ||
    rotation?.latestRestoreCompletedAfterRotation !== true ||
    rotation?.pitrCompletedAfterRotation !== true ||
    typeof rotation?.maxObservedInterruptionSeconds !== 'number' ||
    rotation.maxObservedInterruptionSeconds < 0
  ) {
    findings.push(
      finding(
        'QL3_DR_CERTIFICATE_ROTATION',
        'both plugin certificates must rotate while WAL, backup, latest restore and PITR continue',
      ),
    );
  }

  const levels = report?.serviceLevels;
  const numericLevels = [
    levels?.targetMaxRpoSeconds,
    levels?.observedRpoSeconds,
    levels?.targetMaxDatabaseRtoSeconds,
    levels?.latestDatabaseRtoSeconds,
    levels?.pitrDatabaseRtoSeconds,
    levels?.targetMaxApplicationRtoSeconds,
    levels?.latestApplicationRtoSeconds,
    levels?.pitrApplicationRtoSeconds,
  ];
  if (
    !exactKeys(levels, [
      'targetMaxRpoSeconds',
      'observedRpoSeconds',
      'targetMaxDatabaseRtoSeconds',
      'latestDatabaseRtoSeconds',
      'pitrDatabaseRtoSeconds',
      'targetMaxApplicationRtoSeconds',
      'latestApplicationRtoSeconds',
      'pitrApplicationRtoSeconds',
    ]) ||
    numericLevels.some(
      (value) =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    ) ||
    levels?.observedRpoSeconds > levels?.targetMaxRpoSeconds ||
    levels?.latestDatabaseRtoSeconds > levels?.targetMaxDatabaseRtoSeconds ||
    levels?.pitrDatabaseRtoSeconds > levels?.targetMaxDatabaseRtoSeconds ||
    levels?.latestApplicationRtoSeconds >
      levels?.targetMaxApplicationRtoSeconds ||
    levels?.pitrApplicationRtoSeconds > levels?.targetMaxApplicationRtoSeconds
  ) {
    findings.push(
      finding(
        'QL3_DR_SERVICE_LEVELS',
        'observed RPO and both database/application RTO values must meet explicit deployment targets',
      ),
    );
  }

  if (
    !exactKeys(report?.gates, [
      'latestRestore',
      'pointInTimeRestore',
      'schemaAndRoles',
      'sourceIsolation',
      'certificateRotation',
      'serviceLevels',
      'passed',
    ]) ||
    Object.values(report?.gates || {}).some((value) => value !== true)
  ) {
    findings.push(
      finding(
        'QL3_DR_GATE_SUMMARY',
        'every independent disaster-recovery gate must be explicitly true',
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

function validateCloudNativePgDrReleaseEvidence(report, options = {}) {
  const base = validateCloudNativePgDrEvidence(report);
  const findings = [...base.findings];
  const sourceCommit = options.sourceCommit;
  const releaseVersion = options.releaseVersion;
  const nowMs = options.nowMs ?? Date.now();
  const maximumAgeSeconds = 24 * 60 * 60;
  const observedAtMs = Date.parse(report?.observedAt);
  if (
    !isSourceRevision(sourceCommit) ||
    report?.sourceRevision !== sourceCommit
  ) {
    findings.push(
      finding(
        'QL3_DR_RELEASE_SOURCE',
        'the disaster-recovery evidence must bind the exact release source commit',
      ),
    );
  }
  if (
    typeof releaseVersion !== 'string' ||
    !/^3\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      releaseVersion,
    )
  ) {
    findings.push(
      finding(
        'QL3_DR_RELEASE_VERSION',
        'the disaster-recovery release gate requires one exact QingLong 3 SemVer',
      ),
    );
  }
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs > nowMs + 5 * 60 * 1_000 ||
    nowMs - observedAtMs > maximumAgeSeconds * 1_000
  ) {
    findings.push(
      finding(
        'QL3_DR_RELEASE_FRESHNESS',
        'the disaster-recovery evidence must be no older than 24 hours and not more than five minutes in the future',
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    sourceCommit,
    releaseVersion,
    maximumAgeSeconds,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function readEvidenceFile(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error('evidence report path must be absolute');
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('evidence report must be a regular non-symlink file');
  }
  if (stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error('evidence report must be between 2 bytes and 1 MiB');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error('evidence report must not be group/world writable');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--report=')) {
    process.stderr.write(
      'usage: ql3-cloudnativepg-dr-evidence-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const report = readEvidenceFile(args[0].slice('--report='.length));
      const result = validateCloudNativePgDrEvidence(report);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.compatible) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        `${
          error instanceof Error ? error.message : 'unknown evidence error'
        }\n`,
      );
      process.exitCode = 1;
    }
  }
}

module.exports = {
  readEvidenceFile,
  validateCloudNativePgDrEvidence,
  validateCloudNativePgDrReleaseEvidence,
};
