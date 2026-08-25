#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE =
  'qinglong/security-administration-kubernetes-live-contract@v1';
const LIMITATIONS = Object.freeze([
  'three privileged K3s Docker nodes are not production infrastructure or control-plane HA evidence',
  'the strong-User assertion is issued by a local deterministic ceremony rather than a production external IdP',
  'CloudNativePG inside one Docker host is not infrastructure STONITH or disaster-recovery evidence',
  'the local-path ReadWriteOnce volume is not encrypted production CSI custody evidence',
  'a dedicated root storage-fixture Job constrains the local-path volume root before every non-root administration Job',
]);
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'connectionstring',
  'dsn',
  'keyset',
  'kubeconfig',
  'password',
  'pepper',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

function finding(code, detail) {
  return Object.freeze({ code, detail });
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

function allTrue(value, keys) {
  return exactKeys(value, keys) && keys.every((key) => value[key] === true);
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\bql3c_[A-Za-z0-9_-]{16,}\b/.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(
        value,
      ) ||
      /-----BEGIN (?:CERTIFICATE|(?:RSA |EC |OPENSSH )?PRIVATE KEY)-----/.test(
        value,
      )
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

function validKubernetesVersion(value) {
  const match =
    typeof value === 'string'
      ? /^v1\.([0-9]{2,3})\.([0-9]+)(?:[-+][0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?)?$/.exec(
          value,
        )
      : null;
  return Boolean(match && Number(match[1]) >= 32);
}

function validateSecurityAdministrationKubernetesLiveReport(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'platform',
      'database',
      'ceremony',
      'inputBoundary',
      'deliveryCustody',
      'isolation',
      'durability',
      'cleanup',
      'gates',
      'limitations',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_REPORT_SHAPE',
        'the report must use the exact versioned live-contract envelope',
      ),
    );
  }
  if (containsSensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_MATERIAL_EXPOSURE',
        'the report must not contain credentials, assertions, database authority, kubeconfig or private key material',
      ),
    );
  }

  const platform = report?.platform;
  if (
    !exactKeys(platform, [
      'distribution',
      'kubernetesVersion',
      'architecture',
      'kubernetesImageId',
      'administrationImageId',
      'cniName',
      'cniDistributionBinding',
      'controlPlaneNodes',
      'workerNodes',
      'readyNodes',
    ]) ||
    platform?.distribution !== 'k3s' ||
    !validKubernetesVersion(platform?.kubernetesVersion) ||
    !['amd64', 'arm64'].includes(platform?.architecture) ||
    !isSha256(platform?.kubernetesImageId) ||
    !isSha256(platform?.administrationImageId) ||
    platform?.cniName !== 'flannel' ||
    platform?.cniDistributionBinding !== 'rancher/k3s:v1.34.3-k3s1' ||
    platform?.controlPlaneNodes !== 1 ||
    platform?.workerNodes !== 2 ||
    platform?.readyNodes !== 3
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_PLATFORM',
        'the fixture must bind three real K3s nodes, Flannel and exact local runtime images',
      ),
    );
  }

  const database = report?.database;
  if (
    !exactKeys(database, [
      'operator',
      'operatorVersion',
      'postgresVersionNumber',
      'postgresImageId',
      'instances',
      'readyInstances',
      'administrationRole',
      'roleConnectionLimit',
      'commandConnectionLimit',
      'migrationCount',
      'controlCoreCapability',
      'tlsVerified',
      'leastPrivilege',
    ]) ||
    database?.operator !== 'cloudnative-pg' ||
    database?.operatorVersion !== '1.30.0' ||
    database?.postgresVersionNumber !== 180004 ||
    !isSha256(database?.postgresImageId) ||
    database?.instances !== 3 ||
    database?.readyInstances !== 3 ||
    database?.administrationRole !== 'ql3_admin' ||
    database?.roleConnectionLimit !== 4 ||
    database?.commandConnectionLimit !== 1 ||
    database?.migrationCount !== 71 ||
    database?.controlCoreCapability !== 70 ||
    database?.tlsVerified !== true ||
    database?.leastPrivilege !== true
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_DATABASE',
        'three TLS CloudNativePG instances must expose only the reviewed one-connection administration authority',
      ),
    );
  }

  const ceremony = report?.ceremony;
  if (
    !exactKeys(ceremony, [
      'operations',
      'completedJobs',
      'failedJobs',
      'callerDriven',
      'backoffLimit',
      'activeDeadlineSeconds',
      'ttlSecondsAfterFinished',
      'serviceAccount',
      'serviceAccountTokenMounted',
      'rbacGranted',
      'responseLossReplayObserved',
      'sensitiveMaterialReported',
    ]) ||
    JSON.stringify(ceremony?.operations) !==
      JSON.stringify([
        'identity.register',
        'audit.list',
        'credential.issue',
        'credential.issue.replay',
        'credential.rotate',
        'credential.revoke',
      ]) ||
    ceremony?.completedJobs !== 6 ||
    ceremony?.failedJobs !== 1 ||
    ceremony?.callerDriven !== true ||
    ceremony?.backoffLimit !== 0 ||
    ceremony?.activeDeadlineSeconds !== 300 ||
    ceremony?.ttlSecondsAfterFinished !== 600 ||
    ceremony?.serviceAccount !== 'ql3-security-administration' ||
    ceremony?.serviceAccountTokenMounted !== false ||
    ceremony?.rbacGranted !== false ||
    ceremony?.responseLossReplayObserved !== true ||
    ceremony?.sensitiveMaterialReported !== false
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_CEREMONY',
        'six serial caller-created commands plus one failed input stage must use the exact tokenless Job contract',
      ),
    );
  }

  if (
    !allTrue(report?.inputBoundary, [
      'immutableSecret',
      'projectedMode0440',
      'memoryBackedPrivateStage',
      'targetDirectoryMode0700',
      'targetFilesMode0600',
      'kubeletAtomicWriterProjectionAccepted',
      'worldReadableProjectionRejected',
      'mainContainerNotStartedAfterStageFailure',
    ])
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_INPUT_BOUNDARY',
        'the real kubelet projection must stage privately and reject widened source permissions before the main container starts',
      ),
    );
  }

  const delivery = report?.deliveryCustody;
  if (
    !exactKeys(delivery, [
      'persistentVolumeClaim',
      'accessMode',
      'fixtureRootProvisioned',
      'fixtureRootMode',
      'fixtureProvisionerRanAsRoot',
      'privateDirectoryMode',
      'fileMode',
      'fileCount',
      'issueDigest',
      'rotationDigest',
      'distinctRotationMaterial',
      'persistentAcrossJobs',
      'noReplaceReplayPreserved',
      'deliverySchemaValidated',
      'bearerFormatValidatedInPod',
      'sensitiveMaterialReported',
    ]) ||
    delivery?.persistentVolumeClaim !== true ||
    delivery?.accessMode !== 'ReadWriteOnce' ||
    delivery?.fixtureRootProvisioned !== true ||
    delivery?.fixtureRootMode !== '2770' ||
    delivery?.fixtureProvisionerRanAsRoot !== true ||
    delivery?.privateDirectoryMode !== '0700' ||
    delivery?.fileMode !== '0600' ||
    delivery?.fileCount !== 2 ||
    !isSha256(delivery?.issueDigest) ||
    !isSha256(delivery?.rotationDigest) ||
    delivery?.issueDigest === delivery?.rotationDigest ||
    ![
      'distinctRotationMaterial',
      'persistentAcrossJobs',
      'noReplaceReplayPreserved',
      'deliverySchemaValidated',
      'bearerFormatValidatedInPod',
    ].every((key) => delivery?.[key] === true) ||
    delivery?.sensitiveMaterialReported !== false
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_DELIVERY',
        'issue and rotation material must remain distinct, private, persistent and no-replace on the caller-owned RWO volume',
      ),
    );
  }

  if (
    !allTrue(report?.isolation, [
      'dnsAndDatabaseEgressAllowed',
      'kubernetesApiEgressDenied',
      'publicInternetEgressDenied',
      'secretReadRbacDenied',
      'jobMutationRbacDenied',
    ])
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_ISOLATION',
        'Flannel and RBAC evidence must allow only DNS/PostgreSQL and deny ambient Kubernetes or public authority',
      ),
    );
  }

  const durability = report?.durability;
  if (
    !exactKeys(durability, [
      'identityVersion',
      'identityStatus',
      'credentialVersion',
      'credentialState',
      'identityMutationCount',
      'credentialMutationCount',
      'issueMutationCount',
      'credentialVersionCount',
      'allowedAuditCount',
    ]) ||
    durability?.identityVersion !== 1 ||
    durability?.identityStatus !== 'active' ||
    durability?.credentialVersion !== 3 ||
    durability?.credentialState !== 'revoked' ||
    durability?.identityMutationCount !== 1 ||
    durability?.credentialMutationCount !== 3 ||
    durability?.issueMutationCount !== 1 ||
    durability?.credentialVersionCount !== 3 ||
    durability?.allowedAuditCount !== 4
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_DURABILITY',
        'the database must retain one identity mutation and exactly three credential generations without replay duplication',
      ),
    );
  }

  if (
    !allTrue(report?.cleanup, [
      'jobsDeleted',
      'inputSecretsDeleted',
      'evidenceJobsDeleted',
      'storageProvisionJobDeleted',
      'deliveryVolumeClaimDeleted',
    ])
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_CLEANUP',
        'all caller-created Jobs, inputs, evidence Pods and the fixture delivery claim must be removed',
      ),
    );
  }

  if (
    !allTrue(report?.gates, [
      'realThreeNodeKubernetes',
      'realCloudNativePg',
      'realKubeletSecretProjection',
      'realAdministrationProductCommands',
      'realPersistentCredentialCustody',
      'responseLossReplay',
      'failedInputStageClosed',
      'leastPrivilege',
      'contentFreeEvidence',
      'passed',
    ])
  ) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_GATES',
        'every real ceremony gate must be explicitly and truthfully closed',
      ),
    );
  }

  if (JSON.stringify(report?.limitations) !== JSON.stringify(LIMITATIONS)) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_LIMITATIONS',
        'the report must retain the exact non-production fixture limitations',
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

function reportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-security-administration-kubernetes-live-audit --report=/absolute/report.json',
    );
  }
  return argv[0].slice('--report='.length);
}

if (require.main === module) {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath(process.argv.slice(2))));
    const result = validateSecurityAdministrationKubernetesLiveReport(report);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.compatible) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `security administration Kubernetes live audit failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 2;
  }
}

module.exports = {
  FIXTURE,
  LIMITATIONS,
  validateSecurityAdministrationKubernetesLiveReport,
};
