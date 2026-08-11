#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

const FIXTURE = 'qinglong/prompt-output-projection-kubernetes-live-contract@v1';
const LIMITATIONS = Object.freeze([
  'three privileged K3s Docker nodes are not production infrastructure, CSI or control-plane HA evidence',
  'the fixture exercises Kubernetes Secret atomic-writer projection rather than a production external Secret operator',
  'exportable in-cluster key bytes are not KMS wrapping, HSM non-exportability or external key custody evidence',
]);
const BANNED_KEYS = new Set([
  'authorization',
  'data',
  'key',
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

function validatePromptOutputProjectionKubernetesLiveReport(report) {
  const findings = [];
  if (
    !exactKeys(report, [
      'fixture',
      'gates',
      'limitations',
      'observedAt',
      'platform',
      'projection',
    ]) ||
    report.fixture !== FIXTURE ||
    typeof report.observedAt !== 'string' ||
    Number.isNaN(Date.parse(report.observedAt))
  ) {
    findings.push('QL3_PROMPT_OUTPUT_PROJECTION_LIVE_REPORT_SHAPE');
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
    !/^sha256:[a-f0-9]{64}$/.test(report?.platform?.kubernetesImageId ?? '')
  ) {
    findings.push('QL3_PROMPT_OUTPUT_PROJECTION_LIVE_PLATFORM');
  }
  if (
    !exactKeys(report?.projection, [
      'activeChanged',
      'atomicWriterSymlink',
      'dataFileOnly',
      'defaultMode',
      'generationAfter',
      'generationBefore',
      'historicalArtifactOpened',
      'podIdentityStable',
      'readOnlyMount',
      'revisionChanged',
      'runtimeCredentialAbsent',
      'transientUnavailableObserved',
    ]) ||
    report?.projection?.generationBefore !== 1 ||
    report?.projection?.generationAfter !== 2 ||
    report?.projection?.defaultMode !== 0o440 ||
    ![
      'activeChanged',
      'atomicWriterSymlink',
      'dataFileOnly',
      'historicalArtifactOpened',
      'podIdentityStable',
      'readOnlyMount',
      'revisionChanged',
      'runtimeCredentialAbsent',
    ].every((key) => report?.projection?.[key] === true) ||
    typeof report?.projection?.transientUnavailableObserved !== 'boolean'
  ) {
    findings.push('QL3_PROMPT_OUTPUT_PROJECTION_LIVE_OPERATION');
  }
  if (
    !exactKeys(report?.gates, [
      'contentFreeEvidence',
      'historicalDecrypt',
      'passed',
      'readOnlyRuntime',
      'realAtomicProjection',
      'realKubernetesApi',
      'rotationRecovered',
      'sameProcessRotation',
    ]) ||
    !Object.values(report?.gates ?? {}).every((value) => value === true)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_PROJECTION_LIVE_GATES');
  }
  if (
    JSON.stringify(report?.limitations) !== JSON.stringify(LIMITATIONS) ||
    containsSensitiveMaterial(report)
  ) {
    findings.push('QL3_PROMPT_OUTPUT_PROJECTION_LIVE_CONTENT');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function main() {
  const argument = process.argv.find((value) => value.startsWith('--report='));
  if (!argument) {
    process.stderr.write(
      'usage: ql3-prompt-output-projection-kubernetes-live-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
    return;
  }
  const report = JSON.parse(fs.readFileSync(argument.slice(9), 'utf8'));
  const result = validatePromptOutputProjectionKubernetesLiveReport(report);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  FIXTURE,
  LIMITATIONS,
  validatePromptOutputProjectionKubernetesLiveReport,
};
