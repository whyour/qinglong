#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/vault-kv-worker-secret-direct-custody-live@v1';
const IMAGE =
  'docker.io/hashicorp/vault@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569';
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[+-][A-Za-z0-9.-]+)?$/;
const FORBIDDEN_KEY =
  /(secretRef|secretValue|clientToken|rootToken|accessor|endpoint|pathPrefix|tokenFile|caFile|materialValue|materialBytes|privateKey)/i;
const REQUIRED_GATES = Object.freeze([
  'digestPinnedVaultImage',
  'nativeVaultArchitecture',
  'tls13WithExplicitPrivateCa',
  'untrustedCaRejected',
  'initializedWithThreeOfTwoSealAuthority',
  'kvV2ExternalCustody',
  'oneExactReadOnlyPolicy',
  'shortLivedOrphanNonRenewableToken',
  'tokenRevalidatedPerResolution',
  'digestDerivedPathsOnly',
  'normalSecretBoundPreserved',
  'opaqueEnvironmentBundleBoundPreserved',
  'valueRotationObservedWithoutControlRestart',
  'tokenRotationObservedWithoutControlRestart',
  'revokedTokenRemoved',
  'missingMaterialFailsClosed',
  'sealedVaultFailsClosed',
  'thresholdUnsealRestoresResolution',
  'persistentValuesSurviveContainerReplacement',
  'reportIsContentFree',
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
  if (
    typeof value === 'string' &&
    /(hvs\.[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|qlsecret:v1:|vault-private-|bundle-private-)/.test(
      value,
    )
  ) {
    findings.push(`${location} contains sensitive material`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scan(entry, findings, `${location}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      findings.push(`${location}.${key} is forbidden`);
    }
    scan(entry, findings, `${location}.${key}`);
  }
}

function validateVaultKvWorkerSecretLiveReport(report) {
  const findings = [];
  if (
    !exact(report, [
      'schemaVersion',
      'fixture',
      'platform',
      'custody',
      'gates',
      'limitations',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE
  ) {
    findings.push('report envelope is invalid');
  }
  if (
    !exact(report?.platform, [
      'architecture',
      'vaultImage',
      'vaultImageId',
      'vaultVersion',
      'transport',
      'storage',
    ]) ||
    !['amd64', 'arm64'].includes(report?.platform?.architecture) ||
    report?.platform?.vaultImage !== IMAGE ||
    !SHA256.test(report?.platform?.vaultImageId ?? '') ||
    !VERSION.test(report?.platform?.vaultVersion ?? '') ||
    report?.platform?.transport !== 'TLSv1.3 with an explicit private CA' ||
    report?.platform?.storage !== 'persistent file barrier fixture'
  ) {
    findings.push('platform evidence is invalid');
  }
  if (
    !exact(report?.custody, [
      'provider',
      'kvVersion',
      'policyCount',
      'maximumTokenTtlSeconds',
      'tokenLeaseSeconds',
      'secretCount',
      'environmentBundleCount',
      'observedVersions',
      'containerReplacements',
    ]) ||
    report?.custody?.provider !== 'vault-kv-v2' ||
    report?.custody?.kvVersion !== 2 ||
    report?.custody?.policyCount !== 1 ||
    report?.custody?.maximumTokenTtlSeconds !== 900 ||
    report?.custody?.tokenLeaseSeconds !== 600 ||
    report?.custody?.secretCount !== 2 ||
    report?.custody?.environmentBundleCount !== 1 ||
    JSON.stringify(report?.custody?.observedVersions) !==
      JSON.stringify([1, 2]) ||
    report?.custody?.containerReplacements !== 1
  ) {
    findings.push('custody evidence is invalid');
  }
  if (
    !exact(report?.gates, REQUIRED_GATES) ||
    REQUIRED_GATES.some((gate) => report?.gates?.[gate] !== true)
  ) {
    findings.push('one or more required gates are false or missing');
  }
  if (
    !Array.isArray(report?.limitations) ||
    report.limitations.length !== 3 ||
    report.limitations.some(
      (value) =>
        typeof value !== 'string' || value.length < 32 || value.length > 512,
    )
  ) {
    findings.push('limitations are invalid');
  }
  scan(report, findings);
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function main(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--report=/')) {
    throw new Error(
      'usage: ql3-vault-kv-worker-secret-live-audit --report=/absolute/report.json',
    );
  }
  const reportPath = argv[0].slice('--report='.length);
  if (path.resolve(reportPath) !== reportPath) {
    throw new Error('report path is invalid');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const result = validateVaultKvWorkerSecretLiveReport(report);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `QL3 Vault KV Worker Secret live audit failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  IMAGE,
  REQUIRED_GATES,
  validateVaultKvWorkerSecretLiveReport,
};
