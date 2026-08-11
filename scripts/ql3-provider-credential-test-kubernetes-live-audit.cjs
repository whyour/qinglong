#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/provider-credential-test-kubernetes-live-contract@v1';
const LIMITATIONS = Object.freeze([
  'three privileged K3s Docker nodes with fixture-only prebound hostPath volumes are not production infrastructure, dynamic storage or control-plane HA evidence',
  'the private HTTPS provider is a deterministic in-cluster fixture rather than an external SaaS provider',
  'the manager plan uses a local strong-User database actor rather than the external OIDC and mTLS transport',
  'CloudNativePG failover inside one Docker host is not infrastructure STONITH evidence',
]);
const BANNED_KEYS = new Set([
  'authorization',
  'bearer',
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

function validKubernetesVersion(value) {
  const match =
    typeof value === 'string'
      ? /^v1\.([0-9]{2,3})\.([0-9]+)(?:[-+][0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?)?$/.exec(
          value,
        )
      : null;
  return Boolean(match && Number(match[1]) >= 32);
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

function allTrue(value, keys) {
  return exactKeys(value, keys) && keys.every((key) => value[key] === true);
}

function validateProviderCredentialTestKubernetesLiveReport(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'database',
      'durability',
      'executor',
      'fixture',
      'gates',
      'isolation',
      'limitations',
      'observedAt',
      'platform',
      'provider',
      'rotation',
      'schemaVersion',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_REPORT_SHAPE',
        'the report must use the exact versioned live-contract envelope',
      ),
    );
  }
  if (containsSensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_SENSITIVE',
        'the report must not contain credentials, DSNs, kubeconfig, private keys or raw certificates',
      ),
    );
  }

  const platform = report?.platform;
  if (
    !exactKeys(platform, [
      'adminImageId',
      'architecture',
      'cniDistributionBinding',
      'cniName',
      'cniReadyNodes',
      'controlPlaneNodes',
      'distribution',
      'kubernetesImageId',
      'kubernetesVersion',
      'workerNodes',
    ]) ||
    platform?.distribution !== 'k3s' ||
    !validKubernetesVersion(platform?.kubernetesVersion) ||
    !['amd64', 'arm64'].includes(platform?.architecture) ||
    !isSha256(platform?.kubernetesImageId) ||
    !isSha256(platform?.adminImageId) ||
    platform?.cniName !== 'flannel' ||
    platform?.cniDistributionBinding !== 'rancher/k3s:v1.34.3-k3s1' ||
    platform?.controlPlaneNodes !== 1 ||
    platform?.workerNodes !== 2 ||
    platform?.cniReadyNodes !== 3
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_PLATFORM',
        'the fixture must bind three real K3s nodes, Flannel and exact runtime images',
      ),
    );
  }

  const database = report?.database;
  if (
    !exactKeys(database, [
      'aiMigrationCount',
      'instances',
      'managerRole',
      'migrationCount',
      'operator',
      'operatorVersion',
      'postgresImageId',
      'postgresVersionNumber',
      'primaryChangedDuringFailover',
      'readyInstances',
      'testerRole',
      'tlsVerified',
    ]) ||
    database?.operator !== 'cloudnative-pg' ||
    typeof database?.operatorVersion !== 'string' ||
    database.operatorVersion.length < 1 ||
    database.operatorVersion.length > 64 ||
    database?.postgresVersionNumber !== 180004 ||
    !isSha256(database?.postgresImageId) ||
    database?.instances !== 3 ||
    database?.readyInstances !== 3 ||
    database?.managerRole !== 'ql3_ai_credential_manager' ||
    database?.testerRole !== 'ql3_ai_credential_tester' ||
    database?.migrationCount < 50 ||
    database?.aiMigrationCount !== 15 ||
    database?.tlsVerified !== true ||
    database?.primaryChangedDuringFailover !== true
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_DATABASE',
        'three TLS CloudNativePG instances and the isolated manager/tester roles must survive promotion',
      ),
    );
  }

  const provider = report?.provider;
  if (
    !exactKeys(provider, [
      'caSha256',
      'exactPrivateCidrPolicy',
      'initialPodIdentitySha256',
      'materialGenerationCount',
      'modelCount',
      'port',
      'protocol',
      'replicas',
      'requestCount',
      'rotatedPodIdentitySha256',
      'service',
    ]) ||
    provider?.protocol !== 'HTTPS' ||
    provider?.service !== 'ql3-provider-live' ||
    provider?.port !== 8443 ||
    provider?.replicas !== 1 ||
    !isSha256(provider?.initialPodIdentitySha256) ||
    !isSha256(provider?.rotatedPodIdentitySha256) ||
    provider.initialPodIdentitySha256 === provider.rotatedPodIdentitySha256 ||
    !isSha256(provider?.caSha256) ||
    provider?.modelCount !== 2 ||
    provider?.requestCount !== 5 ||
    provider?.materialGenerationCount !== 2 ||
    provider?.exactPrivateCidrPolicy !== true
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_PROVIDER',
        'the exact private HTTPS provider must rotate once and observe only five bounded requests',
      ),
    );
  }

  const executor = report?.executor;
  const expectedOutcomes = {
    baseDenied: 'unreachable',
    exactAllowed: 'reachable',
    exactReplay: 'reachable',
    postFailover: 'reachable',
    refreshedCidr: 'reachable',
    rotatedMaterial: 'reachable',
    staleCidr: 'unreachable',
    staleMaterial: 'unreachable',
  };
  if (
    !exactKeys(executor, [
      'activeDeadlineSeconds',
      'backoffLimit',
      'binary',
      'callerDrivenJobs',
      'jobsRun',
      'outcomes',
      'poolMaxConnections',
      'rbacGranted',
      'responseRedacted',
      'serviceAccount',
      'serviceAccountTokenMounted',
      'ttlSecondsAfterFinished',
    ]) ||
    executor?.binary !== 'ql3-provider-credential-test-execute' ||
    executor?.callerDrivenJobs !== true ||
    executor?.jobsRun !== 8 ||
    executor?.backoffLimit !== 0 ||
    executor?.activeDeadlineSeconds !== 60 ||
    executor?.ttlSecondsAfterFinished !== 300 ||
    executor?.serviceAccount !== 'ql3-provider-credential-test-executor' ||
    executor?.serviceAccountTokenMounted !== false ||
    executor?.rbacGranted !== false ||
    executor?.poolMaxConnections !== 1 ||
    executor?.responseRedacted !== true ||
    JSON.stringify(executor?.outcomes) !== JSON.stringify(expectedOutcomes)
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_EXECUTOR',
        'eight one-shot product Jobs must prove exact outcomes with no retry, token or RBAC authority',
      ),
    );
  }

  if (
    !allTrue(report?.rotation, [
      'newPodObservedNewProjection',
      'oldMaterialRejectedAfterRotation',
      'projectedMaterialReresolved',
      'providerPodReplaced',
      'staleCidrFailedClosed',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_ROTATION',
        'material rotation and provider Pod replacement must fail closed until exact network authority is refreshed',
      ),
    );
  }

  if (
    !allTrue(report?.isolation, [
      'baseProviderEgressDenied',
      'cloudNativePgEgressAllowed',
      'exactProviderEgressAllowed',
      'kubernetesApiEgressDenied',
      'managerMountedNoProviderMaterial',
      'publicInternetEgressDenied',
      'staleProviderCidrDenied',
      'testerMutationRbacDenied',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_ISOLATION',
        'CNI and RBAC evidence must prove DNS-only base, exact provider/database egress and denied ambient authority',
      ),
    );
  }

  const durability = report?.durability;
  if (
    !exactKeys(durability, [
      'credentialUseAuditCount',
      'executionCount',
      'planAuditCount',
      'planCount',
      'providerRequestCount',
      'reachableCount',
      'replayDuplicateCount',
      'resultCount',
      'survivedCloudNativePgFailover',
      'unreachableCount',
    ]) ||
    durability?.planCount !== 7 ||
    durability?.executionCount !== 7 ||
    durability?.resultCount !== 7 ||
    durability?.credentialUseAuditCount !== 5 ||
    durability?.planAuditCount !== 7 ||
    durability?.reachableCount !== 4 ||
    durability?.unreachableCount !== 3 ||
    durability?.providerRequestCount !== 5 ||
    durability?.replayDuplicateCount !== 0 ||
    durability?.survivedCloudNativePgFailover !== true
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_DURABILITY',
        'seven immutable plans/executions/results, seven plan audits and five credential-use audits must survive failover without replay duplication',
      ),
    );
  }

  if (
    !allTrue(report?.gates, [
      'contentFreeEvidence',
      'durableFactsSurvivedFailover',
      'exactPrivateProviderEgress',
      'leastPrivilege',
      'passed',
      'projectedMaterialRotation',
      'realCniPolicy',
      'realThreeNodeKubernetes',
      'eightOneShotJobs',
      'threeInstanceCloudNativePg',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_GATES',
        'every independent credential test Kubernetes live gate must be explicitly true',
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
        'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_LIMITATIONS',
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
  if (!path.isAbsolute(filePath))
    throw new Error('report path must be absolute');
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
      'usage: ql3-provider-credential-test-kubernetes-live-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = validateProviderCredentialTestKubernetesLiveReport(
        readReport(args[0].slice('--report='.length)),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.compatible) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        `provider credential test Kubernetes live audit failed: ${
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
  validateProviderCredentialTestKubernetesLiveReport,
};
