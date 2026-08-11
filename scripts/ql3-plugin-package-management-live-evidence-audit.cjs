#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const FIXTURE = 'qinglong/plugin-package-management-live-evidence@v1';
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'connectionstring',
  'dsn',
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
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
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

function isExternalIssuer(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.toString() === value &&
    net.isIP(hostname) === 0 &&
    hostname !== 'localhost' &&
    !hostname.endsWith('.localhost') &&
    !hostname.endsWith('.local') &&
    !hostname.endsWith('.test') &&
    !hostname.endsWith('.invalid') &&
    !hostname.endsWith('.example')
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

function strictlyIncreasingGenerations(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (generation) => Number.isSafeInteger(generation) && generation >= 1,
    ) &&
    value[0] < value[1] &&
    value[1] < value[2]
  );
}

function allTrue(value, expectedKeys) {
  return (
    exactKeys(value, expectedKeys) &&
    expectedKeys.every((key) => value[key] === true)
  );
}

function validatePluginPackageManagementLiveEvidence(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'platform',
      'deployment',
      'identity',
      'ceremony',
      'isolation',
      'rotation',
      'gates',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_REPORT_SHAPE',
        'the report must use the exact versioned live-evidence envelope',
      ),
    );
  }

  if (containsSensitiveMaterial(report)) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_SECRET_EXPOSURE',
        'the report must not contain assertions, tokens, credentials, DSNs or private keys',
      ),
    );
  }

  const platform = report?.platform;
  if (
    !exactKeys(platform, [
      'kubernetesVersion',
      'architecture',
      'managementImageId',
      'postgresVersionNumber',
      'postgresImageId',
      'cniName',
      'cniVersion',
      'controlPlaneNodes',
      'workerNodes',
    ]) ||
    !validKubernetesVersion(platform?.kubernetesVersion) ||
    !['amd64', 'arm64'].includes(platform?.architecture) ||
    !isSha256(platform?.managementImageId) ||
    platform?.postgresVersionNumber !== 180004 ||
    !isSha256(platform?.postgresImageId) ||
    !isToken(platform?.cniName, 64) ||
    !isToken(platform?.cniVersion, 64) ||
    !Number.isSafeInteger(platform?.controlPlaneNodes) ||
    platform.controlPlaneNodes < 3 ||
    !Number.isSafeInteger(platform?.workerNodes) ||
    platform.workerNodes < 2
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_PLATFORM',
        'evidence must bind supported Kubernetes, exact images, an identified CNI, three control-plane nodes and two workers',
      ),
    );
  }

  const deployment = report?.deployment;
  if (
    !exactKeys(deployment, [
      'namespace',
      'service',
      'replicas',
      'readyReplicas',
      'podIdentitySha256',
      'nodeIdentitySha256',
      'serviceAccount',
      'automountServiceAccountToken',
      'databaseRole',
      'migrationCount',
      'controlCoreCapability',
      'tableCount',
    ]) ||
    deployment?.namespace !== 'qinglong3-system' ||
    deployment?.service !== 'ql3-plugin-package-management' ||
    deployment?.replicas !== 2 ||
    deployment?.readyReplicas !== 2 ||
    !Array.isArray(deployment?.podIdentitySha256) ||
    deployment.podIdentitySha256.length !== 2 ||
    !deployment.podIdentitySha256.every(isSha256) ||
    new Set(deployment.podIdentitySha256).size !== 2 ||
    !Array.isArray(deployment?.nodeIdentitySha256) ||
    deployment.nodeIdentitySha256.length !== 2 ||
    !deployment.nodeIdentitySha256.every(isSha256) ||
    new Set(deployment.nodeIdentitySha256).size !== 2 ||
    deployment?.serviceAccount !== 'ql3-plugin-package-management' ||
    deployment?.automountServiceAccountToken !== false ||
    deployment?.databaseRole !== 'ql3_package_manager' ||
    deployment?.migrationCount !== 25 ||
    deployment?.controlCoreCapability !== 24 ||
    deployment?.tableCount !== 38
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_DEPLOYMENT',
        'evidence must bind two ready replicas on distinct nodes, zero token mount, manager-only PostgreSQL and the v24 schema',
      ),
    );
  }

  const identity = report?.identity;
  const generations = identity?.keysetGenerations;
  if (
    !exactKeys(identity, [
      'providerKind',
      'issuer',
      'discoveryDocumentSha256',
      'jwksSha256',
      'audience',
      'requesterSubjectSha256',
      'reviewerSubjectSha256',
      'requesterAssurance',
      'reviewerAssurance',
      'keysetGenerations',
      'finalLedgerGeneration',
      'finalRevokedKeyCount',
    ]) ||
    identity?.providerKind !== 'external_oidc' ||
    !isExternalIssuer(identity?.issuer) ||
    !isSha256(identity?.discoveryDocumentSha256) ||
    !isSha256(identity?.jwksSha256) ||
    identity?.audience !== 'qinglong3-package-management' ||
    !isSha256(identity?.requesterSubjectSha256) ||
    !isSha256(identity?.reviewerSubjectSha256) ||
    identity.requesterSubjectSha256 === identity.reviewerSubjectSha256 ||
    !['multi_factor', 'hardware'].includes(identity?.requesterAssurance) ||
    !['multi_factor', 'hardware'].includes(identity?.reviewerAssurance) ||
    !strictlyIncreasingGenerations(generations) ||
    identity?.finalLedgerGeneration !== generations?.[2] ||
    !Number.isSafeInteger(identity?.finalRevokedKeyCount) ||
    identity.finalRevokedKeyCount < 1 ||
    identity.finalRevokedKeyCount > 64
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_IDENTITY',
        'evidence must bind one external canonical OIDC issuer, two distinct strong users and a three-generation durable rotation',
      ),
    );
  }

  if (
    !allTrue(report?.ceremony, [
      'requesterProposeAccepted',
      'requesterSelfDecisionRejected',
      'reviewerDecisionAccepted',
      'requesterAndReviewerDistinct',
      'inspectionAuthorized',
      'durableAuditObserved',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_CEREMONY',
        'the real two-user ceremony must prove propose, self-decision denial, independent approval, inspection and durable audit',
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
      'postgresEgressAllowed',
      'managerSecretReadDenied',
      'managerExecutorMutationDenied',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_ISOLATION',
        'live NetworkPolicy and authority denial evidence must cover ingress, egress, Kubernetes API, Secret and executor mutation',
      ),
    );
  }

  const rotation = report?.rotation;
  if (
    !exactKeys(rotation, [
      'overlapOldAssertionAccepted',
      'newAssertionAccepted',
      'revokedOldAssertionRejected',
      'previousTlsSerialSha256',
      'currentTlsSerialSha256',
      'previousTlsSecretVersionSha256',
      'currentTlsSecretVersionSha256',
      'allReplicasReadyThroughout',
      'tls13BeforeAndAfter',
    ]) ||
    rotation?.overlapOldAssertionAccepted !== true ||
    rotation?.newAssertionAccepted !== true ||
    rotation?.revokedOldAssertionRejected !== true ||
    !isSha256(rotation?.previousTlsSerialSha256) ||
    !isSha256(rotation?.currentTlsSerialSha256) ||
    rotation.previousTlsSerialSha256 === rotation.currentTlsSerialSha256 ||
    !isSha256(rotation?.previousTlsSecretVersionSha256) ||
    !isSha256(rotation?.currentTlsSecretVersionSha256) ||
    rotation.previousTlsSecretVersionSha256 ===
      rotation.currentTlsSecretVersionSha256 ||
    rotation?.allReplicasReadyThroughout !== true ||
    rotation?.tls13BeforeAndAfter !== true
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_ROTATION',
        'evidence must prove overlap/revoke, distinct TLS generations, TLS 1.3 and zero-unavailable two-replica rotation',
      ),
    );
  }

  if (
    !allTrue(report?.gates, [
      'externalIdentity',
      'separationOfDuty',
      'twoReplicaAvailability',
      'networkPolicy',
      'keysetRotation',
      'tlsRotation',
      'leastPrivilege',
      'schema',
      'passed',
    ])
  ) {
    findings.push(
      finding(
        'QL3_PLUGIN_MANAGEMENT_LIVE_GATES',
        'every independent live management gate must be explicitly true',
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
      'usage: ql3-plugin-package-management-live-evidence-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const report = readEvidenceFile(args[0].slice('--report='.length));
      const result = validatePluginPackageManagementLiveEvidence(report);
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
  validatePluginPackageManagementLiveEvidence,
};
