#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILES = new Set(['edge', 'standalone']);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function validateLocalApiCancellationLiveReport(value) {
  const findings = [];
  const record = exactKeys(value, [
    'artifact',
    'compatible',
    'observations',
    'platform',
    'profile',
    'qualification',
    'resourceEnvelope',
    'schemaVersion',
  ]);
  if (!record || value.schemaVersion !== 1 || !PROFILES.has(value.profile)) {
    return Object.freeze({
      compatible: false,
      findings: ['report identity is invalid'],
    });
  }
  const expectedMemory =
    value.profile === 'edge' ? 128 * 1024 * 1024 : 256 * 1024 * 1024;
  const expectedPids = value.profile === 'edge' ? 64 : 256;
  if (
    !exactKeys(value.platform, ['architecture', 'os', 'procfs']) ||
    value.platform?.os !== 'linux' ||
    !['arm64', 'x64'].includes(value.platform?.architecture) ||
    value.platform?.procfs !== true
  )
    findings.push('Linux /proc platform observation is invalid');
  if (
    !exactKeys(value.resourceEnvelope, [
      'apiRssBytes',
      'memoryBytes',
      'pids',
    ]) ||
    value.resourceEnvelope?.memoryBytes !== expectedMemory ||
    value.resourceEnvelope?.pids !== expectedPids ||
    !Number.isSafeInteger(value.resourceEnvelope?.apiRssBytes) ||
    value.resourceEnvelope.apiRssBytes < 1 ||
    value.resourceEnvelope.apiRssBytes > expectedMemory
  )
    findings.push('resource envelope is invalid');
  if (
    !exactKeys(value.artifact, [
      'bytes',
      'compatible',
      'files',
      'loadedModules',
      'profile',
    ]) ||
    value.artifact?.profile !== `${value.profile}-application-api` ||
    !Number.isSafeInteger(value.artifact?.bytes) ||
    value.artifact.bytes < 1 ||
    value.artifact.bytes > 6 * 1024 * 1024 ||
    !Number.isSafeInteger(value.artifact?.files) ||
    value.artifact.files < 1 ||
    value.artifact.files > 640 ||
    !Number.isSafeInteger(value.artifact?.loadedModules) ||
    value.artifact.loadedModules < 1 ||
    value.artifact.loadedModules > 256 ||
    value.artifact.compatible !== true
  )
    findings.push('optional API artifact evidence is invalid');
  const observed = value.observations;
  if (
    !exactKeys(observed, [
      'cancellationAccepted',
      'durableAllowedAudits',
      'durableCancellationEvents',
      'durableIntentEvents',
      'exactReplay',
      'processIdentityGone',
      'processIdentityObserved',
      'restartObservedCancelled',
      'sqliteIntegrity',
      'taskStartAccepted',
    ]) ||
    observed?.taskStartAccepted !== true ||
    observed?.cancellationAccepted !== true ||
    observed?.exactReplay !== true ||
    observed?.durableIntentEvents !== 1 ||
    observed?.durableCancellationEvents !== 1 ||
    observed?.durableAllowedAudits !== 2 ||
    observed?.processIdentityObserved !== true ||
    observed?.processIdentityGone !== true ||
    observed?.restartObservedCancelled !== true ||
    observed?.sqliteIntegrity !== 'ok'
  )
    findings.push('API to durable process-stop observations are incomplete');
  if (
    !exactKeys(value.qualification, [
      'evidenceClass',
      'passed',
      'physicalDevice',
    ]) ||
    value.qualification?.evidenceClass !== 'linux_virtualized_live_contract' ||
    value.qualification?.physicalDevice !== false ||
    value.qualification?.passed !== true
  )
    findings.push('qualification boundary is invalid');
  if (value.compatible !== true) findings.push('report is not compatible');
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function reportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  )
    throw new Error(
      'usage: ql3-local-api-cancellation-live-audit --report=/absolute/private-report.json',
    );
  return argv[0].slice('--report='.length);
}

if (require.main === module) {
  try {
    const filePath = reportPath(process.argv.slice(2));
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 32 * 1024
    ) {
      throw new Error('report must be a private bounded regular file');
    }
    const audit = validateLocalApiCancellationLiveReport(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    );
    process.stdout.write(`${JSON.stringify(audit)}\n`);
    if (!audit.compatible) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { validateLocalApiCancellationLiveReport };
