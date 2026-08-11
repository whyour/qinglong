#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

const FIXTURE =
  'qinglong/prompt-output-key-retirement-kubernetes-live-contract@v1';
const LIMITATIONS = Object.freeze([
  'three privileged K3s Docker nodes with dynamic local-path volumes are not production infrastructure, CSI or control-plane HA evidence',
  'the reachable deny canary is an in-cluster deterministic fixture rather than a production monitoring dependency',
  'Kubernetes Secret resourceVersion CAS is not KMS wrapping, HSM non-exportability or external key custody evidence',
]);
const BANNED_KEYS = new Set([
  'authorization',
  'data',
  'keyring',
  'material',
  'password',
  'resourceVersion',
  'secret',
  'token',
  'uid',
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key)) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([nestedKey, nestedValue]) =>
      containsSensitiveMaterial(nestedValue, nestedKey),
    );
  }
  return false;
}

function validatePromptOutputKeyRetirementKubernetesLiveReport(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'database',
      'fixture',
      'gates',
      'limitations',
      'observedAt',
      'operation',
      'platform',
    ]) ||
    report.fixture !== FIXTURE ||
    typeof report.observedAt !== 'string' ||
    Number.isNaN(Date.parse(report.observedAt))
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_REPORT_SHAPE');
  }
  if (
    !exactKeys(report?.platform, [
      'architecture',
      'cniName',
      'controlPlaneNodes',
      'distribution',
      'kubernetesImageId',
      'kubernetesVersion',
      'workerNodes',
    ]) ||
    report?.platform?.distribution !== 'k3s' ||
    report?.platform?.cniName !== 'flannel' ||
    report?.platform?.controlPlaneNodes !== 1 ||
    report?.platform?.workerNodes !== 2 ||
    !isSha256(report?.platform?.kubernetesImageId)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_PLATFORM');
  }
  if (
    !exactKeys(report?.database, [
      'aiMigrationCount',
      'instances',
      'migrationCount',
      'operator',
      'operatorVersion',
      'postgresVersionNumber',
      'readyInstances',
      'role',
      'tlsVerified',
    ]) ||
    report?.database?.operator !== 'cloudnative-pg' ||
    report?.database?.instances !== 3 ||
    report?.database?.readyInstances !== 3 ||
    report?.database?.migrationCount !== 54 ||
    report?.database?.aiMigrationCount !== 16 ||
    report?.database?.role !== 'ql3_ai_maintenance' ||
    report?.database?.tlsVerified !== true
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_DATABASE');
  }
  if (
    !exactKeys(report?.operation, [
      'activeKeyRetained',
      'completionCount',
      'denyCanaryControlReachable',
      'denyCanaryEgressDenied',
      'generationAfter',
      'inactiveKeyRemoved',
      'jobsRun',
      'preparationCount',
      'projectedTokenExpirationSeconds',
      'rbacExact',
      'replayStatus',
      'resourceVersionChangedOnce',
      'retirementCount',
      'secretIdentityBound',
      'status',
      'tokenAbsentFromInit',
    ]) ||
    report?.operation?.jobsRun !== 2 ||
    report?.operation?.status !== 'completed' ||
    report?.operation?.replayStatus !== 'existing' ||
    report?.operation?.generationAfter !== 2 ||
    report?.operation?.retirementCount !== 1 ||
    report?.operation?.preparationCount !== 1 ||
    report?.operation?.completionCount !== 1 ||
    report?.operation?.projectedTokenExpirationSeconds !== 600 ||
    ![
      'activeKeyRetained',
      'denyCanaryControlReachable',
      'denyCanaryEgressDenied',
      'inactiveKeyRemoved',
      'rbacExact',
      'resourceVersionChangedOnce',
      'secretIdentityBound',
      'tokenAbsentFromInit',
    ].every((key) => report?.operation?.[key] === true)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_OPERATION');
  }
  if (
    !exactKeys(report?.gates, [
      'contentFreeEvidence',
      'durableReplay',
      'exactRbac',
      'passed',
      'realCloudNativePg',
      'realKubernetesApi',
      'resourceVersionCas',
      'samePodNetworkBarrier',
      'shortLivedToken',
    ]) ||
    !Object.values(report?.gates ?? {}).every((value) => value === true)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_GATES');
  }
  if (
    JSON.stringify(report?.limitations) !== JSON.stringify(LIMITATIONS) ||
    containsSensitiveMaterial(report)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_KEY_RETIREMENT_LIVE_CONTENT');
  }
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: node audit.cjs /absolute/report.json\n');
    process.exitCode = 64;
  } else {
    const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const result =
      validatePromptOutputKeyRetirementKubernetesLiveReport(report);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.compatible) process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputKeyRetirementKubernetesLiveReport,
};
