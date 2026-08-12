#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/run-management-kubernetes-live-contract@v1';
const LIMITATIONS = Object.freeze([
  'three privileged K3s Docker nodes are not production infrastructure or control-plane HA evidence',
  'identity assertions use a deterministic local strong-User ceremony rather than an external IdP',
  'CloudNativePG failover inside one Docker host is not infrastructure STONITH evidence',
]);
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'certificate',
  'clientkey',
  'connectionstring',
  'dsn',
  'kubeconfig',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isToken(value, maximum = 128) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)
  );
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:CERTIFICATE|(?:RSA |EC |OPENSSH )?PRIVATE KEY)-----/.test(
        value,
      ) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(
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

function uniqueDigests(value, count) {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.every(isDigest) &&
    new Set(value).size === count
  );
}

function allTrue(value, expected) {
  return (
    exactKeys(value, expected) && expected.every((key) => value[key] === true)
  );
}

function validateRunManagementKubernetesLiveReport(report) {
  const findings = [];
  const reject = (code, detail) =>
    findings.push(Object.freeze({ code, detail }));
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'platform',
      'database',
      'deployment',
      'client',
      'identityRotation',
      'certificateRotation',
      'availability',
      'isolation',
      'durability',
      'gates',
      'limitations',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_REPORT_SHAPE',
      'the report must use the exact versioned Run management live envelope',
    );
  }
  if (containsSensitiveMaterial(report)) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_SECRET_EXPOSURE',
      'the report must not contain credentials, assertions, certificates, DSNs, kubeconfig or private keys',
    );
  }

  const platform = report?.platform;
  if (
    !exactKeys(platform, [
      'distribution',
      'kubernetesVersion',
      'architecture',
      'kubernetesImageId',
      'managementImageId',
      'cniName',
      'cniDistributionBinding',
      'controlPlaneNodes',
      'workerNodes',
      'cniReadyNodes',
    ]) ||
    platform?.distribution !== 'k3s' ||
    !validKubernetesVersion(platform?.kubernetesVersion) ||
    !['amd64', 'arm64'].includes(platform?.architecture) ||
    !isDigest(platform?.kubernetesImageId) ||
    !isDigest(platform?.managementImageId) ||
    platform?.cniName !== 'flannel' ||
    platform?.cniDistributionBinding !== 'rancher/k3s:v1.34.3-k3s1' ||
    platform?.controlPlaneNodes !== 1 ||
    platform?.workerNodes !== 2 ||
    platform?.cniReadyNodes !== 3
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_PLATFORM',
      'the fixture must bind three real K3s nodes, embedded Flannel and exact images',
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
      'managerRole',
      'migrationCount',
      'controlCoreCapability',
      'tlsVerified',
      'primaryChangedDuringFailover',
    ]) ||
    database?.operator !== 'cloudnative-pg' ||
    !isToken(database?.operatorVersion, 64) ||
    database?.postgresVersionNumber !== 180004 ||
    !isDigest(database?.postgresImageId) ||
    database?.instances !== 3 ||
    database?.readyInstances !== 3 ||
    database?.managerRole !== 'ql3_run_manager' ||
    database?.migrationCount !== 57 ||
    database?.controlCoreCapability !== 56 ||
    database?.tlsVerified !== true ||
    database?.primaryChangedDuringFailover !== true
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DATABASE',
      'three TLS CloudNativePG instances must run migration 57, capability 56 and the isolated Run manager role',
    );
  }

  const deployment = report?.deployment;
  if (
    !exactKeys(deployment, [
      'namespace',
      'service',
      'port',
      'replicas',
      'readyReplicas',
      'podIdentitySha256',
      'nodeIdentitySha256',
      'serviceAccount',
      'automountServiceAccountToken',
      'requiredPodAntiAffinity',
      'podDisruptionBudgetMinAvailable',
      'maxUnavailable',
      'maxConnectionsPerPod',
    ]) ||
    deployment?.namespace !== 'qinglong3-system' ||
    deployment?.service !== 'ql3-run-management' ||
    deployment?.port !== 8448 ||
    deployment?.replicas !== 2 ||
    deployment?.readyReplicas !== 2 ||
    !uniqueDigests(deployment?.podIdentitySha256, 2) ||
    !uniqueDigests(deployment?.nodeIdentitySha256, 2) ||
    deployment?.serviceAccount !== 'ql3-run-management' ||
    deployment?.automountServiceAccountToken !== false ||
    deployment?.requiredPodAntiAffinity !== true ||
    deployment?.podDisruptionBudgetMinAvailable !== 1 ||
    deployment?.maxUnavailable !== 0 ||
    deployment?.maxConnectionsPerPod !== 2
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DEPLOYMENT',
      'two tokenless Run manager replicas must be ready on distinct nodes with the exact budget',
    );
  }

  const client = report?.client;
  if (
    !exactKeys(client, [
      'binary',
      'operations',
      'inputKind',
      'inputImmutable',
      'callerDrivenJob',
      'backoffLimit',
      'serviceAccountTokenMounted',
      'rbacGranted',
      'transportProtocol',
      'mutualTls',
      'servernameVerified',
      'exactPodRequests',
      'retryStatuses',
      'stopStatuses',
      'responseRedacted',
    ]) ||
    client?.binary !== 'ql3-run-client' ||
    JSON.stringify(client?.operations) !==
      JSON.stringify(['run.retry', 'run.stop']) ||
    client?.inputKind !== 'Secret' ||
    client?.inputImmutable !== true ||
    client?.callerDrivenJob !== true ||
    client?.backoffLimit !== 0 ||
    client?.serviceAccountTokenMounted !== false ||
    client?.rbacGranted !== false ||
    client?.transportProtocol !== 'TLSv1.3' ||
    client?.mutualTls !== true ||
    client?.servernameVerified !== true ||
    client?.exactPodRequests !== 6 ||
    JSON.stringify(client?.retryStatuses) !==
      JSON.stringify(['accepted', 'existing', 'existing']) ||
    JSON.stringify(client?.stopStatuses) !==
      JSON.stringify(['accepted', 'already_requested', 'already_requested']) ||
    client?.responseRedacted !== true
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_CLIENT',
      'immutable caller-driven clients must retry and stop with exact replay across both Pods over TLS 1.3 mTLS',
    );
  }

  if (
    !allTrue(report?.identityRotation, [
      'overlapOldAssertionAccepted',
      'overlapNewAssertionAccepted',
      'revokedOldAssertionRejected',
      'activeNewAssertionAccepted',
      'rollbackSurgeFailedClosed',
      'twoReadyReplicasPreserved',
      'durableGenerationReachedThree',
    ])
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_IDENTITY_ROTATION',
      'identity overlap, revoke, rollback rejection and two-ready availability are mandatory',
    );
  }

  const certificate = report?.certificateRotation;
  if (
    !exactKeys(certificate, [
      'previousSerialSha256',
      'currentSerialSha256',
      'previousBundleSha256',
      'currentBundleSha256',
      'oldClientAcceptedBefore',
      'replacementClientAcceptedBefore',
      'oldClientRejectedAfter',
      'replacementClientAcceptedAfter',
      'fullPodReplacement',
      'allReplicasReadyThroughout',
    ]) ||
    !isDigest(certificate?.previousSerialSha256) ||
    !isDigest(certificate?.currentSerialSha256) ||
    certificate?.previousSerialSha256 === certificate?.currentSerialSha256 ||
    !isDigest(certificate?.previousBundleSha256) ||
    !isDigest(certificate?.currentBundleSha256) ||
    certificate?.previousBundleSha256 === certificate?.currentBundleSha256 ||
    ![
      'oldClientAcceptedBefore',
      'replacementClientAcceptedBefore',
      'oldClientRejectedAfter',
      'replacementClientAcceptedAfter',
      'fullPodReplacement',
      'allReplicasReadyThroughout',
    ].every((key) => certificate?.[key] === true)
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_CERTIFICATE_ROTATION',
      'CRL rotation must replace all Pods without dropping below two ready replicas',
    );
  }

  if (
    !allTrue(report?.availability, [
      'databaseFailureWithdrewReadiness',
      'databaseFailurePreservedLiveness',
      'stalePodsDidNotRecoverInPlace',
      'freshPodsRecoveredAfterDatabase',
      'bothReplicasServedAfterRecovery',
    ])
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_AVAILABILITY',
      'database loss must withdraw readiness, preserve liveness and require fresh manager Pods',
    );
  }
  if (
    !allTrue(report?.isolation, [
      'labelledClientAllowed',
      'unlabelledClientDenied',
      'wrongPortDenied',
      'kubernetesApiEgressDenied',
      'publicInternetEgressDenied',
      'cloudNativePgEgressAllowed',
      'managerSecretReadDenied',
      'managerMutationRbacDenied',
    ])
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_ISOLATION',
      'CNI and Kubernetes RBAC least-privilege observations are incomplete',
    );
  }

  const durability = report?.durability;
  if (
    !exactKeys(durability, [
      'sourceRunStatus',
      'retryRunCount',
      'retryAttemptCount',
      'retryEventCount',
      'stoppedRunCount',
      'stopEventCount',
      'allowedAuditCount',
      'deniedAuditCount',
      'duplicateMutationCount',
      'identityGeneration',
      'weakAuthenticationAuditCount',
      'survivedCloudNativePgFailover',
    ]) ||
    durability?.sourceRunStatus !== 'failed' ||
    durability?.retryRunCount !== 1 ||
    durability?.retryAttemptCount !== 1 ||
    durability?.retryEventCount !== 2 ||
    durability?.stoppedRunCount !== 1 ||
    durability?.stopEventCount !== 1 ||
    durability?.allowedAuditCount !== 2 ||
    durability?.deniedAuditCount !== 1 ||
    durability?.duplicateMutationCount !== 0 ||
    durability?.identityGeneration !== 3 ||
    durability?.weakAuthenticationAuditCount !== 0 ||
    durability?.survivedCloudNativePgFailover !== true
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DURABILITY',
      'exact Run, Attempt, Event, cancellation and audit facts must survive failover without duplicates',
    );
  }

  if (
    !allTrue(report?.gates, [
      'realThreeNodeKubernetes',
      'realCniPolicy',
      'threeInstanceCloudNativePg',
      'twoManagerPodsOnDistinctNodes',
      'tls13ProductClientAcrossBothPods',
      'strongUserRetryAndStop',
      'identityProjectionRotation',
      'certificateRevocationRollout',
      'databaseReadinessFence',
      'durableFactsSurvivedFailover',
      'leastPrivilege',
      'passed',
    ])
  ) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_GATES',
      'every independently observed release gate must pass',
    );
  }
  if (JSON.stringify(report?.limitations) !== JSON.stringify(LIMITATIONS)) {
    reject(
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_LIMITATIONS',
      'the exact non-production limitations must remain visible',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function main(argv = process.argv.slice(2)) {
  const argument = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    argument.length !== 1 ||
    !argument[0].startsWith('--report=') ||
    !path.isAbsolute(argument[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-run-management-kubernetes-live-audit --report=/absolute/private-report.json',
    );
  }
  const reportFile = argument[0].slice('--report='.length);
  const stat = fs.lstatSync(reportFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      'Run management Kubernetes live report must be a private regular file',
    );
  }
  const audit = validateRunManagementKubernetesLiveReport(
    JSON.parse(fs.readFileSync(reportFile, 'utf8')),
  );
  process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
  if (!audit.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      'QL3 Run management Kubernetes live audit failed: ' +
        (error instanceof Error ? error.message : String(error)) +
        '\n',
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  LIMITATIONS,
  validateRunManagementKubernetesLiveReport,
};
