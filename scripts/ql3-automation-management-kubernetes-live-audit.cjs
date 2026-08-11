#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/automation-management-kubernetes-live-contract@v1';
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

function isSha256(value) {
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
    value.every(isSha256) &&
    new Set(value).size === count
  );
}

function allTrue(value, expected) {
  return (
    exactKeys(value, expected) && expected.every((key) => value[key] === true)
  );
}

function validateAutomationManagementKubernetesLiveReport(report) {
  const findings = [];
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
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_REPORT_SHAPE',
        'the report must use the exact versioned live-contract envelope',
      ),
    );
  }

  if (containsSensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_SECRET_EXPOSURE',
        'the report must not contain certificates, assertions, credentials, DSNs, kubeconfig or private keys',
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
    !isSha256(platform?.kubernetesImageId) ||
    !isSha256(platform?.managementImageId) ||
    platform?.cniName !== 'flannel' ||
    platform?.cniDistributionBinding !== 'rancher/k3s:v1.34.3-k3s1' ||
    platform?.controlPlaneNodes !== 1 ||
    platform?.workerNodes !== 2 ||
    platform?.cniReadyNodes !== 3
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_PLATFORM',
        'the fixture must bind three real K3s nodes, the embedded Flannel distribution and exact runtime images',
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
      'managerRole',
      'controlCoreCapability',
      'tlsVerified',
      'primaryChangedDuringFailover',
    ]) ||
    database?.operator !== 'cloudnative-pg' ||
    !isToken(database?.operatorVersion, 64) ||
    database?.postgresVersionNumber !== 180004 ||
    !isSha256(database?.postgresImageId) ||
    database?.instances !== 3 ||
    database?.readyInstances !== 3 ||
    database?.managerRole !== 'ql3_automation_manager' ||
    database?.controlCoreCapability !== 53 ||
    database?.tlsVerified !== true ||
    database?.primaryChangedDuringFailover !== true
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_DATABASE',
        'the fixture must use three ready TLS CloudNativePG instances, capability v53 and the isolated automation role',
      ),
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
    deployment?.service !== 'ql3-automation-management' ||
    deployment?.port !== 8445 ||
    deployment?.replicas !== 2 ||
    deployment?.readyReplicas !== 2 ||
    !uniqueDigests(deployment?.podIdentitySha256, 2) ||
    !uniqueDigests(deployment?.nodeIdentitySha256, 2) ||
    deployment?.serviceAccount !== 'ql3-automation-management' ||
    deployment?.automountServiceAccountToken !== false ||
    deployment?.requiredPodAntiAffinity !== true ||
    deployment?.podDisruptionBudgetMinAvailable !== 1 ||
    deployment?.maxUnavailable !== 0 ||
    deployment?.maxConnectionsPerPod !== 2
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_DEPLOYMENT',
        'two tokenless manager replicas must be ready on distinct nodes behind the exact service and rollout budget',
      ),
    );
  }

  const client = report?.client;
  if (
    !exactKeys(client, [
      'binary',
      'operation',
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
      'resultStatuses',
      'responseRedacted',
    ]) ||
    client?.binary !== 'ql3-automation-client' ||
    client?.operation !== 'task.publish' ||
    client?.inputKind !== 'Secret' ||
    client?.inputImmutable !== true ||
    client?.callerDrivenJob !== true ||
    client?.backoffLimit !== 0 ||
    client?.serviceAccountTokenMounted !== false ||
    client?.rbacGranted !== false ||
    client?.transportProtocol !== 'TLSv1.3' ||
    client?.mutualTls !== true ||
    client?.servernameVerified !== true ||
    client?.exactPodRequests !== 2 ||
    !Array.isArray(client?.resultStatuses) ||
    [...client.resultStatuses].sort().join(',') !== 'created,existing' ||
    client?.responseRedacted !== true
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_CLIENT',
        'the immutable Secret-backed one-shot product client must reach both manager Pods over verified TLS 1.3 mTLS',
      ),
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
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_IDENTITY_ROTATION',
        'three durable identity generations must prove overlap, revocation, rollback rejection and preserved availability',
      ),
    );
  }

  const certificateRotation = report?.certificateRotation;
  if (
    !exactKeys(certificateRotation, [
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
    !isSha256(certificateRotation?.previousSerialSha256) ||
    !isSha256(certificateRotation?.currentSerialSha256) ||
    certificateRotation.previousSerialSha256 ===
      certificateRotation.currentSerialSha256 ||
    !isSha256(certificateRotation?.previousBundleSha256) ||
    !isSha256(certificateRotation?.currentBundleSha256) ||
    certificateRotation.previousBundleSha256 ===
      certificateRotation.currentBundleSha256 ||
    certificateRotation?.oldClientAcceptedBefore !== true ||
    certificateRotation?.replacementClientAcceptedBefore !== true ||
    certificateRotation?.oldClientRejectedAfter !== true ||
    certificateRotation?.replacementClientAcceptedAfter !== true ||
    certificateRotation?.fullPodReplacement !== true ||
    certificateRotation?.allReplicasReadyThroughout !== true
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_CERTIFICATE_ROTATION',
        'client revocation and server trust generation must be bound to a complete zero-unavailable Pod rollout',
      ),
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
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_AVAILABILITY',
        'database loss must withdraw readiness and require fresh manager activation without forging liveness failure',
      ),
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
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_ISOLATION',
        'CNI and RBAC evidence must prove exact client ingress, CloudNativePG egress and denied ambient authority',
      ),
    );
  }

  const durability = report?.durability;
  if (
    !exactKeys(durability, [
      'taskRevisionCount',
      'triggerRevisionCount',
      'allowedAuditCount',
      'replayDuplicateCount',
      'taskCurrentRevision',
      'triggerCurrentRevision',
      'survivedCloudNativePgFailover',
    ]) ||
    durability?.taskRevisionCount !== 4 ||
    durability?.triggerRevisionCount !== 2 ||
    durability?.allowedAuditCount !== 6 ||
    durability?.replayDuplicateCount !== 0 ||
    durability?.taskCurrentRevision !== 4 ||
    durability?.triggerCurrentRevision !== 2 ||
    durability?.survivedCloudNativePgFailover !== true
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_DURABILITY',
        'the exact Task/Trigger/audit/replay facts must survive CloudNativePG primary failover',
      ),
    );
  }

  if (
    !allTrue(report?.gates, [
      'realThreeNodeKubernetes',
      'realCniPolicy',
      'threeInstanceCloudNativePg',
      'twoManagerPodsOnDistinctNodes',
      'tls13ProductClientAcrossBothPods',
      'identityProjectionRotation',
      'certificateRevocationRollout',
      'databaseReadinessFence',
      'durableFactsSurvivedFailover',
      'leastPrivilege',
      'passed',
    ])
  ) {
    findings.push(
      finding(
        'QL3_AUTOMATION_KUBERNETES_LIVE_GATES',
        'every independent Kubernetes automation live gate must be explicitly true',
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
        'QL3_AUTOMATION_KUBERNETES_LIVE_LIMITATIONS',
        'the disposable fixture limitations must remain explicit and exact',
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

function readReport(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error('report path must be absolute');
  }
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > 1024 * 1024 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(
      'report must be a non-writable regular file between 2 bytes and 1 MiB',
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--report=')) {
    process.stderr.write(
      'usage: ql3-automation-management-kubernetes-live-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = validateAutomationManagementKubernetesLiveReport(
        readReport(args[0].slice('--report='.length)),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.compatible) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        `automation Kubernetes live audit failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 2;
    }
  }
}

module.exports = {
  FIXTURE,
  LIMITATIONS,
  validateAutomationManagementKubernetesLiveReport,
};
