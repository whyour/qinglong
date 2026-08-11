#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalDigest } = require('./ql3-physical-edge-evidence.cjs');
const {
  directProcessIdentity,
  inspectServiceManager,
  normalizeDirectServiceStartManifest,
  normalizeSession: normalizeDirectSession,
  parseStartupReceipt,
  readLinuxClockTicksPerSecond,
  validateDirectServiceStartReport,
} = require('./ql3-physical-edge-direct-service-start.cjs');

const MAX_INPUT_BYTES = 256 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/;
const CONTROLLER_ROOT = '/var/lib/qinglong3-service-bridge';

const SESSION_KEYS = Object.freeze([
  'activeBootId',
  'activeReportDigest',
  'bridge',
  'directSessionDigest',
  'evidenceClass',
  'manifestDigest',
  'preparedAt',
  'processId',
  'processStartTicks',
  'schemaVersion',
  'sessionId',
  'sha256',
  'startupReceiptDigest',
  'uid',
]);
const BRIDGE_KEYS = Object.freeze([
  'actionId',
  'controllerRoot',
  'intentDigest',
  'intentPath',
  'outcomePath',
]);
const REPORT_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'manifest',
  'observed',
  'qualification',
  'schemaVersion',
  'session',
  'sha256',
  'supported',
]);
const REPORT_SESSION_KEYS = Object.freeze([
  'activeBootId',
  'activeReportDigest',
  'directSessionDigest',
  'processId',
  'processStartTicks',
  'sessionDigest',
  'sessionId',
  'startupReceiptDigest',
]);
const OBSERVED_KEYS = Object.freeze([
  'bridge',
  'currentBootId',
  'processIdentityGone',
  'service',
  'shutdownReceipt',
]);
const OBSERVED_BRIDGE_KEYS = Object.freeze([
  'actionId',
  'intentDigest',
  'observationDigest',
  'outcomeDigest',
  'state',
]);
const OBSERVED_SERVICE_KEYS = Object.freeze([
  'active',
  'enabled',
  'fragmentPath',
  'mainPid',
]);
const SHUTDOWN_RECEIPT_KEYS = Object.freeze([
  'bootId',
  'instanceId',
  'nodeExecutable',
  'nodeVersion',
  'processId',
  'processStartTicks',
  'profile',
  'schema',
  'schemaVersion',
  'sha256',
  'signal',
  'stoppedBootAgeMs',
  'stopResult',
  'startupReceiptDigest',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'doesNotProve',
  'measures',
  'passed',
  'violations',
]);
const MEASURES = Object.freeze([
  'owner_stop_intent_root_service_bridge_owner_outcome',
  'application_sigterm_shutdown_receipt',
  'startup_to_shutdown_process_identity_binding',
  'exact_receipted_process_identity_gone',
  'init_managed_service_stopped_and_still_enabled',
]);
const EXCLUSIONS = Object.freeze([
  'service_disable_or_descriptor_removal',
  'unexpected_power_loss_recovery',
  'whole_device_flash_write_amplification',
  'firmware_or_bootloader_shutdown',
  'standalone_or_cluster_profile',
  'release_archive_signature_or_attestation',
]);

class QingLong3PhysicalDirectServiceStopEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge direct service stop evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalDirectServiceStopEvidenceError';
  }
}

function fail(message) {
  throw new QingLong3PhysicalDirectServiceStopEvidenceError(message);
}

function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(`${label} shape is invalid`);
  }
}

function parseArguments(argv) {
  const options = { json: false };
  let phase;
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!phase && ['prepare', 'resume'].includes(argument)) {
      phase = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) fail(`unsupported argument ${argument}`);
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--session') options.directSessionPath = value;
    else if (name === '--active-report') options.activeReportPath = value;
    else if (name === '--stop-session') options.stopSessionPath = value;
    else if (name === '--output') options.outputPath = value;
    else if (name === '--root-command-output')
      options.rootCommandOutputPath = value;
    else fail(`unsupported argument ${argument}`);
  }
  if (!phase) fail('phase must be prepare or resume');
  const required = [
    'manifestPath',
    'directSessionPath',
    'activeReportPath',
    'stopSessionPath',
    ...(phase === 'resume' ? ['outputPath'] : []),
  ];
  for (const name of required) {
    if (
      typeof options[name] !== 'string' ||
      !path.isAbsolute(options[name]) ||
      path.normalize(options[name]) !== options[name]
    ) {
      fail(`${name} must be absolute and normalized`);
    }
  }
  if (
    options.rootCommandOutputPath !== undefined &&
    (phase !== 'prepare' ||
      !path.isAbsolute(options.rootCommandOutputPath) ||
      path.normalize(options.rootCommandOutputPath) !==
        options.rootCommandOutputPath)
  ) {
    fail('rootCommandOutputPath is valid only as a normalized prepare path');
  }
  return Object.freeze({ phase, ...options });
}

function currentUid() {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    fail('real and effective POSIX users must match');
  }
  return process.getuid();
}

function readPrivateFile(filePath, label) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    Number(before.uid) !== currentUid() ||
    (Number(before.mode) & 0o777) !== 0o600 ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(MAX_INPUT_BYTES) ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail(`${label} is not a private regular file`);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1n
    ) {
      fail(`${label} identity changed while opening`);
    }
    const material = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < material.byteLength) {
      const count = fs.readSync(
        descriptor,
        material,
        offset,
        material.byteLength - offset,
        null,
      );
      if (count < 1) fail(`${label} read made no progress`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1n
    ) {
      material.fill(0);
      fail(`${label} identity changed while reading`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(material);
    } finally {
      material.fill(0);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateJson(filePath, label) {
  try {
    return JSON.parse(readPrivateFile(filePath, label));
  } catch (error) {
    if (error instanceof QingLong3PhysicalDirectServiceStopEvidenceError)
      throw error;
    fail(`${label} is not JSON`);
  }
}

function writeNoReplace(filePath, contents) {
  if (fs.existsSync(filePath)) fail(`${filePath} already exists`);
  const parent = fs.realpathSync(path.dirname(filePath));
  if (path.join(parent, path.basename(filePath)) !== filePath) {
    fail('output path parent is not canonical');
  }
  const stat = fs.lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o022) !== 0
  ) {
    fail('output parent is not owner-controlled');
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return filePath;
}

function currentBootId() {
  const value = fs
    .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
    .trim()
    .toLowerCase();
  if (!BOOT_ID_PATTERN.test(value)) fail('current boot ID is invalid');
  return value;
}

function requireDeploymentProduct() {
  try {
    return require(path.join(
      __dirname,
      '..',
      'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
    ));
  } catch (error) {
    fail(`local deployment product must be built first: ${error.message}`);
  }
}

function requireShutdownReceiptProduct() {
  try {
    return require(path.join(
      __dirname,
      '..',
      'packages/ql3-local-application/dist/production-process/shutdownReceipt.js',
    ));
  } catch (error) {
    fail(`local application product must be built first: ${error.message}`);
  }
}

function normalizeStopSession(value, directSession) {
  exact(value, SESSION_KEYS, 'stop session');
  exact(value.bridge, BRIDGE_KEYS, 'stop session bridge');
  const { sha256, ...body } = value;
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_direct_service_stop_session' ||
    !UUID_V4_PATTERN.test(value.sessionId ?? '') ||
    value.uid !== directSession.uid ||
    !Number.isFinite(Date.parse(value.preparedAt ?? '')) ||
    !SHA256_PATTERN.test(value.manifestDigest ?? '') ||
    value.directSessionDigest !== directSession.sha256 ||
    !SHA256_PATTERN.test(value.activeReportDigest ?? '') ||
    !BOOT_ID_PATTERN.test(value.activeBootId ?? '') ||
    !SHA256_PATTERN.test(value.startupReceiptDigest ?? '') ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1 ||
    !START_TICKS_PATTERN.test(value.processStartTicks ?? '') ||
    value.bridge.actionId !== value.sessionId ||
    value.bridge.controllerRoot !== CONTROLLER_ROOT ||
    !SHA256_PATTERN.test(value.bridge.intentDigest ?? '') ||
    value.bridge.intentPath !==
      path.join(
        directSession.paths.deploymentRoot,
        'service',
        'service-manager-intents',
        `${value.sessionId}.json`,
      ) ||
    value.bridge.outcomePath !==
      path.join(
        directSession.paths.deploymentRoot,
        'service',
        'service-manager-outcomes',
        `${value.sessionId}.json`,
      ) ||
    canonicalDigest(body) !== sha256
  ) {
    fail('stop session is invalid or drifted');
  }
  return Object.freeze(value);
}

function processIdentityGone(processId, startTicks) {
  const processRoot = `/proc/${processId}`;
  if (!fs.existsSync(processRoot)) return true;
  let contents;
  try {
    contents = fs.readFileSync(path.join(processRoot, 'stat'), 'utf8');
  } catch {
    fail('prior process identity cannot be inspected');
  }
  const end = contents.lastIndexOf(') ');
  const fields =
    end < 2
      ? []
      : contents
          .slice(end + 2)
          .trim()
          .split(/\s+/u);
  const current = fields[19];
  if (!current || !START_TICKS_PATTERN.test(current)) {
    fail('prior process stat is invalid');
  }
  return current !== startTicks;
}

function evaluateDirectServiceStopEvidence({
  manifest,
  stopSession,
  observed,
}) {
  const violations = [];
  try {
    exact(observed, OBSERVED_KEYS, 'stop observation');
    exact(observed.bridge, OBSERVED_BRIDGE_KEYS, 'stop bridge observation');
    exact(observed.service, OBSERVED_SERVICE_KEYS, 'stop service observation');
    exact(observed.shutdownReceipt, SHUTDOWN_RECEIPT_KEYS, 'shutdown receipt');
  } catch {
    return Object.freeze(['direct service stop observation shape is invalid']);
  }
  const receipt = observed.shutdownReceipt;
  const { sha256: shutdownDigest, ...shutdownPayload } = receipt;
  const recomputedShutdownDigest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
    .update(JSON.stringify(shutdownPayload), 'utf8')
    .digest('hex');
  if (
    canonicalDigest(manifest) !== stopSession.manifestDigest ||
    observed.currentBootId !== stopSession.activeBootId ||
    observed.bridge.actionId !== stopSession.bridge.actionId ||
    observed.bridge.intentDigest !== stopSession.bridge.intentDigest ||
    observed.bridge.state !== 'stopped' ||
    !SHA256_PATTERN.test(observed.bridge.outcomeDigest ?? '') ||
    !SHA256_PATTERN.test(observed.bridge.observationDigest ?? '')
  ) {
    violations.push('Owner stop bridge binding is invalid');
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.schema !== 'qinglong/local-application-shutdown-receipt@v1' ||
    receipt.profile !== 'edge' ||
    receipt.signal !== 'SIGTERM' ||
    receipt.stopResult !== 'stopped' ||
    receipt.startupReceiptDigest !== stopSession.startupReceiptDigest ||
    receipt.bootId !== stopSession.activeBootId ||
    receipt.processId !== stopSession.processId ||
    receipt.processStartTicks !== stopSession.processStartTicks ||
    !SHA256_PATTERN.test(shutdownDigest ?? '') ||
    shutdownDigest !== recomputedShutdownDigest
  ) {
    violations.push('application shutdown receipt binding is invalid');
  }
  if (
    observed.processIdentityGone !== true ||
    observed.service.active !== false ||
    observed.service.enabled !== true ||
    observed.service.fragmentPath !==
      (manifest.serviceManager === 'systemd'
        ? '/etc/systemd/system/qinglong3.service'
        : '/etc/init.d/qinglong3') ||
    (manifest.serviceManager === 'systemd' && observed.service.mainPid !== 0)
  ) {
    violations.push('init or prior process stopped state is invalid');
  }
  return Object.freeze(violations);
}

function buildDirectServiceStopReport({
  manifest,
  stopSession,
  observed,
  generatedAt,
}) {
  const violations = evaluateDirectServiceStopEvidence({
    manifest,
    stopSession,
    observed,
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_stop_candidate',
    supported: false,
    generatedAt,
    manifest,
    session: {
      sessionId: stopSession.sessionId,
      sessionDigest: stopSession.sha256,
      directSessionDigest: stopSession.directSessionDigest,
      activeReportDigest: stopSession.activeReportDigest,
      activeBootId: stopSession.activeBootId,
      startupReceiptDigest: stopSession.startupReceiptDigest,
      processId: stopSession.processId,
      processStartTicks: stopSession.processStartTicks,
    },
    observed,
    qualification: {
      passed: violations.length === 0,
      violations,
      measures: MEASURES,
      doesNotProve: EXCLUSIONS,
    },
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function validateDirectServiceStopReport(report, manifest) {
  const violations = [];
  try {
    exact(report, REPORT_KEYS, 'stop report');
    exact(report.session, REPORT_SESSION_KEYS, 'stop report session');
    exact(report.qualification, QUALIFICATION_KEYS, 'stop qualification');
  } catch {
    return Object.freeze(['direct service stop report shape is invalid']);
  }
  const { sha256, ...body } = report;
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_direct_service_stop_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? '')) ||
    canonicalDigest(report.manifest) !== canonicalDigest(manifest) ||
    !UUID_V4_PATTERN.test(report.session.sessionId ?? '') ||
    !SHA256_PATTERN.test(report.session.sessionDigest ?? '') ||
    !SHA256_PATTERN.test(report.session.directSessionDigest ?? '') ||
    !SHA256_PATTERN.test(report.session.activeReportDigest ?? '') ||
    !BOOT_ID_PATTERN.test(report.session.activeBootId ?? '') ||
    !SHA256_PATTERN.test(report.session.startupReceiptDigest ?? '') ||
    !Number.isSafeInteger(report.session.processId) ||
    report.session.processId < 1 ||
    !START_TICKS_PATTERN.test(report.session.processStartTicks ?? '') ||
    !SHA256_PATTERN.test(sha256 ?? '') ||
    canonicalDigest(body) !== sha256
  ) {
    violations.push('direct service stop report identity is invalid');
  }
  const syntheticSession = {
    manifestDigest: canonicalDigest(manifest),
    activeReportDigest: report.session.activeReportDigest,
    directSessionDigest: report.session.directSessionDigest,
    activeBootId: report.session.activeBootId,
    startupReceiptDigest: report.session?.startupReceiptDigest,
    processId: report.session?.processId,
    processStartTicks: report.session?.processStartTicks,
    bridge: {
      actionId: report.observed?.bridge?.actionId,
      intentDigest: report.observed?.bridge?.intentDigest,
    },
  };
  const recomputed = evaluateDirectServiceStopEvidence({
    manifest,
    stopSession: syntheticSession,
    observed: report.observed,
  });
  if (
    report.qualification.passed !== (recomputed.length === 0) ||
    JSON.stringify(report.qualification.violations) !==
      JSON.stringify(recomputed) ||
    JSON.stringify(report.qualification.measures) !==
      JSON.stringify(MEASURES) ||
    JSON.stringify(report.qualification.doesNotProve) !==
      JSON.stringify(EXCLUSIONS) ||
    recomputed.length > 0
  ) {
    violations.push('direct service stop qualification was widened');
  }
  return Object.freeze(violations);
}

function loadContext(options) {
  const manifest = normalizeDirectServiceStartManifest(
    readPrivateJson(options.manifestPath, 'manifest'),
  );
  const directSession = normalizeDirectSession(
    readPrivateJson(options.directSessionPath, 'direct session'),
  );
  const activeReport = readPrivateJson(
    options.activeReportPath,
    'active report',
  );
  const activeViolations = validateDirectServiceStartReport(
    activeReport,
    manifest,
    activeReport.observed?.after,
  );
  if (
    activeViolations.length > 0 ||
    activeReport.qualification?.passed !== true
  ) {
    fail(`active report is invalid: ${activeViolations.join('; ')}`);
  }
  if (
    directSession.manifestDigest !== canonicalDigest(manifest) ||
    activeReport.session?.sessionDigest !== directSession.sha256 ||
    directSession.uid !== currentUid() ||
    currentBootId() !== activeReport.observed.after.bootId
  ) {
    fail('active report, direct session, Owner UID or current boot drifted');
  }
  return Object.freeze({ manifest, directSession, activeReport });
}

function rootCommand(directSession, bridge) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.execute',
    options: {
      controllerRoot: bridge.controllerRoot,
      allowRootController: true,
      manager:
        directSession.service.kind === 'systemd'
          ? {
              kind: 'systemd',
              executable: directSession.service.managerExecutable,
            }
          : {
              kind: 'openrc',
              serviceExecutable: directSession.service.managerExecutable,
              updateExecutable: directSession.service.enableExecutable,
            },
    },
    request: {
      intentPath: bridge.intentPath,
      expectedIntentDigest: bridge.intentDigest,
    },
  });
}

function preparePhase(options) {
  if (process.platform !== 'linux') fail('prepare requires Linux');
  const { manifest, directSession, activeReport } = loadContext(options);
  if (options.rootCommandOutputPath !== undefined) {
    const dataPath = fs.realpathSync(directSession.paths.dataPath);
    if (
      options.rootCommandOutputPath === options.stopSessionPath ||
      !options.rootCommandOutputPath.startsWith(`${dataPath}${path.sep}`)
    ) {
      fail('rootCommandOutputPath must be a distinct child of dataPath');
    }
  }
  const receipt = parseStartupReceipt(
    readPrivateFile(directSession.paths.startupReceipt, 'startup receipt'),
  );
  if (
    receipt.sha256 !== activeReport.observed.receipt.sha256 ||
    receipt.bootId !== activeReport.observed.after.bootId
  ) {
    fail('current startup receipt drifted from the active report');
  }
  directProcessIdentity(directSession, receipt, readLinuxClockTicksPerSecond());
  const service = inspectServiceManager(directSession, receipt.processId);
  if (!service.active || !service.enabled)
    fail('service is not active and enabled');
  const actionId = crypto.randomUUID();
  const product = requireDeploymentProduct();
  const intent = product.prepareLocalServiceManagerIntent({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: {
      deploymentRoot: directSession.paths.deploymentRoot,
      allowRootService: directSession.uid === 0,
    },
    request: {
      actionId,
      action: 'stop',
      serviceKind: directSession.service.kind,
      lineage: { mode: 'fresh' },
      requestedAtMs: Date.now(),
    },
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_stop_session',
    sessionId: actionId,
    uid: directSession.uid,
    preparedAt: new Date().toISOString(),
    manifestDigest: canonicalDigest(manifest),
    directSessionDigest: directSession.sha256,
    activeReportDigest: activeReport.sha256,
    activeBootId: receipt.bootId,
    startupReceiptDigest: receipt.sha256,
    processId: receipt.processId,
    processStartTicks: receipt.processStartTicks,
    bridge: {
      actionId: intent.actionId,
      controllerRoot: CONTROLLER_ROOT,
      intentDigest: intent.intentDigest,
      intentPath: intent.intentPath,
      outcomePath: intent.outcomePath,
    },
  };
  const stopSession = Object.freeze({ ...body, sha256: canonicalDigest(body) });
  writeNoReplace(
    options.stopSessionPath,
    `${JSON.stringify(stopSession, null, 2)}\n`,
  );
  const command = rootCommand(directSession, stopSession.bridge);
  if (options.rootCommandOutputPath !== undefined) {
    writeNoReplace(
      options.rootCommandOutputPath,
      `${JSON.stringify(command, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'awaiting_root_service_bridge_stop',
      stopSessionDigest: stopSession.sha256,
      rootBridgeCommand: command,
      automaticServiceManagerMutationPerformed: false,
      supported: false,
    })}\n`,
  );
}

function resumePhase(options) {
  if (process.platform !== 'linux') fail('resume requires Linux');
  const { manifest, directSession, activeReport } = loadContext(options);
  const stopSession = normalizeStopSession(
    readPrivateJson(options.stopSessionPath, 'stop session'),
    directSession,
  );
  if (
    stopSession.manifestDigest !== canonicalDigest(manifest) ||
    stopSession.activeReportDigest !== activeReport.sha256 ||
    stopSession.activeBootId !== currentBootId()
  ) {
    fail('stop session lost the active report or boot binding');
  }
  const product = requireDeploymentProduct();
  const outcome = product.consumeLocalServiceManagerOutcome({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.outcome.consume',
    options: {
      deploymentRoot: directSession.paths.deploymentRoot,
      allowRootService: directSession.uid === 0,
    },
    request: {
      actionId: stopSession.bridge.actionId,
      expectedIntentDigest: stopSession.bridge.intentDigest,
    },
  });
  if (outcome.status !== 'verified' || outcome.state !== 'stopped') {
    fail('Owner could not verify a stopped root bridge outcome');
  }
  const shutdownPath = `${directSession.paths.applicationConfig}.stopped.json`;
  const shutdownProduct = requireShutdownReceiptProduct();
  const shutdownReceipt = shutdownProduct.parseLocalApplicationShutdownReceipt(
    readPrivateFile(shutdownPath, 'shutdown receipt'),
  );
  if (
    shutdownReceipt.instanceId !== activeReport.observed.receipt.instanceId ||
    shutdownReceipt.profile !== 'edge' ||
    shutdownReceipt.nodeExecutable !==
      activeReport.observed.receipt.nodeExecutable ||
    shutdownReceipt.stoppedBootAgeMs <
      activeReport.observed.receipt.activeBootAgeMs
  ) {
    fail('shutdown receipt drifted from the active process');
  }
  const service = inspectServiceManager(directSession, stopSession.processId);
  const observed = {
    currentBootId: currentBootId(),
    bridge: {
      actionId: outcome.actionId,
      intentDigest: stopSession.bridge.intentDigest,
      outcomeDigest: outcome.outcomeDigest,
      observationDigest: outcome.observationDigest,
      state: outcome.state,
    },
    shutdownReceipt,
    processIdentityGone: processIdentityGone(
      stopSession.processId,
      stopSession.processStartTicks,
    ),
    service: {
      active: service.active,
      enabled: service.enabled,
      fragmentPath: service.fragmentPath,
      mainPid: service.mainPid,
    },
  };
  const report = buildDirectServiceStopReport({
    manifest,
    stopSession,
    observed,
    generatedAt: new Date().toISOString(),
  });
  writeNoReplace(
    options.outputPath,
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (!report.qualification.passed) process.exitCode = 1;
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    fail('Node.js 24 or newer is required');
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.phase === 'prepare') preparePhase(options);
  else resumePhase(options);
}

module.exports = {
  QingLong3PhysicalDirectServiceStopEvidenceError,
  buildDirectServiceStopReport,
  evaluateDirectServiceStopEvidence,
  normalizeStopSession,
  parseArguments,
  validateDirectServiceStopReport,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
