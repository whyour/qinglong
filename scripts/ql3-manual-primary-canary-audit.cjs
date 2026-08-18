#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const {
  legacyShadowPrimaryEvidenceSha256,
  parseLegacyShadowPrimaryGateReceipt,
} = require('../back/runtime/domain/legacyShadowPrimaryGate');
const {
  createManualPrimaryCanaryDisabledManifest,
  manualPrimaryCanaryFileSet,
  manualPrimaryCanarySha256,
  parseManualPrimaryCanaryPlan,
  parseManualPrimaryCanaryQualification,
} = require('../back/runtime/domain/manualPrimaryCanaryCeremony');
const {
  parseRuntimeRolloutManifest,
} = require('../back/runtime/domain/runtimeRolloutManifest');
const {
  MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE,
  MAX_MANUAL_PRIMARY_RUNTIME_RECEIPT_BYTES,
  parseManualPrimaryRuntimeReceipt,
} = require('../back/runtime/domain/manualPrimaryRuntimeReceipt');
const {
  readPrivateJson,
  serialized,
} = require('./ql3-manual-primary-canary.cjs');

const REQUIREMENTS = new Set([
  'prepared',
  'qualified',
  'selected',
  'active',
  'off',
  'rolled-back',
]);
const ROLLBACK_REASONS = new Set([
  'operator_request',
  'runtime_failure',
  'gate_rejected',
  'approval_expired',
]);

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseArguments(argv) {
  const options = { require: 'prepared' };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument.startsWith('--root=')) {
      const value = argument.slice('--root='.length);
      if (!value) throw new TypeError('--root must not be empty');
      options.root = path.resolve(value);
    } else if (argument.startsWith('--session=')) {
      options.sessionId = argument.slice('--session='.length);
    } else if (argument.startsWith('--require=')) {
      options.require = argument.slice('--require='.length);
    } else {
      throw new TypeError(`Unsupported argument: ${argument}`);
    }
  }
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new TypeError('--root must be absolute');
  }
  if (!options.sessionId) throw new TypeError('--session is required');
  if (!REQUIREMENTS.has(options.require)) {
    throw new TypeError('--require is invalid');
  }
  return options;
}

function regularFile(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function inspectRuntimeProcess(identity) {
  if (identity.kind !== 'linux-proc' || process.platform !== 'linux') {
    return 'unsupported';
  }
  let bootId;
  try {
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return 'unsupported';
    throw error;
  }
  if (bootId !== identity.bootId) return 'identity_mismatch';
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 'exited';
    throw error;
  }
  const close = stat.lastIndexOf(')');
  const fields =
    close < 1
      ? []
      : stat
          .slice(close + 1)
          .trim()
          .split(/\s+/u);
  if (
    fields.length < 20 ||
    Number(fields[2]) !== identity.processGroupId ||
    fields[19] !== identity.startTimeTicks
  ) {
    return 'identity_mismatch';
  }
  return ['Z', 'X', 'x'].includes(fields[0]) ? 'exited' : 'running';
}

function run(options, dependencies = {}) {
  const rootStat = fs.lstatSync(options.root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())
  ) {
    throw new TypeError('Canary root is unsafe');
  }
  const files = manualPrimaryCanaryFileSet(options.sessionId);
  const resolve = (name) => path.join(options.root, files[name]);
  const planRead = readPrivateJson(resolve('plan'), 64 * 1024);
  const plan = parseManualPrimaryCanaryPlan(planRead.value);
  if (plan.sessionId !== options.sessionId) {
    throw new TypeError('Canary plan session mismatch');
  }
  const gatePresent = regularFile(resolve('primaryGate'));
  const qualificationPresent = regularFile(resolve('qualification'));
  if (gatePresent !== qualificationPresent) {
    throw new TypeError('Canary qualification is partial');
  }
  let eligible = false;
  if (gatePresent) {
    const gateRead = readPrivateJson(resolve('primaryGate'), 64 * 1024);
    const gate = parseLegacyShadowPrimaryGateReceipt(gateRead.value);
    const qualification = parseManualPrimaryCanaryQualification(
      readPrivateJson(resolve('qualification'), 64 * 1024).value,
    );
    const sources = {
      capture: readPrivateJson(resolve('capture')),
      terminal: readPrivateJson(resolve('terminal')),
      resource: readPrivateJson(resolve('resource')),
    };
    if (
      gate.assessment !== 'eligible' ||
      gate.profile !== plan.profile ||
      gate.origin !== 'manual' ||
      gate.counts.admitted !== plan.admissionTarget ||
      qualification.sessionId !== plan.sessionId ||
      qualification.profile !== plan.profile ||
      qualification.planSha256 !== planRead.sha256 ||
      qualification.primaryGateFileSha256 !== gateRead.sha256 ||
      qualification.sourceFileSha256.capture !== sources.capture.sha256 ||
      qualification.sourceFileSha256.terminal !== sources.terminal.sha256 ||
      qualification.sourceFileSha256.resource !== sources.resource.sha256 ||
      qualification.sourceCanonicalSha256.capture !==
        gate.evidence.captureSha256 ||
      qualification.sourceCanonicalSha256.terminal !==
        gate.evidence.terminalSha256 ||
      qualification.sourceCanonicalSha256.resource !==
        gate.evidence.resourceSha256 ||
      qualification.window.startInclusiveMs !== gate.window.startInclusiveMs ||
      qualification.window.endExclusiveMs !== gate.window.endExclusiveMs ||
      qualification.counts.admitted !== gate.counts.admitted ||
      qualification.counts.captured !== gate.counts.captured ||
      qualification.counts.terminalScanned !== gate.counts.terminalScanned ||
      qualification.counts.terminalMatched !== gate.counts.terminalMatched ||
      legacyShadowPrimaryEvidenceSha256(sources.capture.value) !==
        qualification.sourceCanonicalSha256.capture ||
      legacyShadowPrimaryEvidenceSha256(sources.terminal.value) !==
        qualification.sourceCanonicalSha256.terminal ||
      legacyShadowPrimaryEvidenceSha256(sources.resource.value) !==
        qualification.sourceCanonicalSha256.resource
    ) {
      throw new TypeError('Canary qualification drifted');
    }
    eligible = true;
  }
  const rolloutPath = resolve('rollout');
  let rolloutMode = 'off';
  let approvalExpired = false;
  let rolloutSha256;
  if (regularFile(rolloutPath)) {
    const rolloutRead = readPrivateJson(rolloutPath, 64 * 1024);
    const raw = rolloutRead.value;
    const now = Date.now();
    approvalExpired =
      raw?.enabled === true &&
      Number.isSafeInteger(raw.expiresAtMs) &&
      raw.expiresAtMs <= now;
    const evaluatedAt = approvalExpired ? raw.approvedAtMs : now;
    const decision = parseRuntimeRolloutManifest(raw, evaluatedAt);
    rolloutSha256 = rolloutRead.sha256;
    if (decision.manifest.enabled && !approvalExpired) {
      if (
        decision.manifest.revision !== `manual-primary-${plan.sessionId}` ||
        !eligible ||
        decision.manifest.primaryGate.receiptSha256 !==
          readPrivateJson(resolve('primaryGate'), 64 * 1024).sha256
      ) {
        throw new TypeError('Active rollout is not bound to the canary');
      }
      if (!regularFile(resolve('selection'))) {
        throw new TypeError('Selected rollout has no selection receipt');
      }
      const selection = readPrivateJson(resolve('selection'), 64 * 1024).value;
      if (
        !hasExactKeys(selection, [
          'schema',
          'schemaVersion',
          'sessionId',
          'profile',
          'selectedAtMs',
          'expiresAtMs',
          'manifestSha256',
          'priorRollout',
        ]) ||
        selection?.schema !== 'qinglong/manual-primary-canary-selection@v1' ||
        selection.schemaVersion !== 1 ||
        selection.sessionId !== plan.sessionId ||
        selection.profile !== plan.profile ||
        selection.selectedAtMs !== decision.manifest.approvedAtMs ||
        selection.manifestSha256 !== rolloutRead.sha256 ||
        selection.expiresAtMs !== decision.manifest.expiresAtMs ||
        JSON.stringify(selection.priorRollout) !==
          JSON.stringify(plan.currentRollout)
      ) {
        throw new TypeError('Selection receipt drifted');
      }
      rolloutMode = 'primary_selected';
    }
  }
  const rolledBack = regularFile(resolve('rollbackComplete'));
  if (rolledBack) {
    const expectedDisabled = serialized(
      createManualPrimaryCanaryDisabledManifest(plan.sessionId),
    );
    if (
      !regularFile(rolloutPath) ||
      readPrivateJson(rolloutPath, 64 * 1024).sha256 !==
        manualPrimaryCanarySha256(expectedDisabled)
    ) {
      throw new TypeError('Rollback completion is not effective');
    }
    const intentRead = readPrivateJson(resolve('rollbackIntent'), 64 * 1024);
    const intent = intentRead.value;
    const completed = readPrivateJson(
      resolve('rollbackComplete'),
      64 * 1024,
    ).value;
    const disabledSha256 = manualPrimaryCanarySha256(expectedDisabled);
    if (
      !hasExactKeys(intent, [
        'schema',
        'schemaVersion',
        'sessionId',
        'profile',
        'createdAtMs',
        'operator',
        'reason',
        'enabledManifestSha256',
        'disabledManifestSha256',
      ]) ||
      intent?.schema !== 'qinglong/manual-primary-canary-rollback-intent@v1' ||
      intent.schemaVersion !== 1 ||
      intent.sessionId !== plan.sessionId ||
      intent.profile !== plan.profile ||
      typeof intent.operator !== 'string' ||
      intent.operator.length < 3 ||
      intent.operator.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(intent.operator) ||
      !ROLLBACK_REASONS.has(intent.reason) ||
      !Number.isSafeInteger(intent.createdAtMs) ||
      !/^[a-f0-9]{64}$/u.test(intent.enabledManifestSha256) ||
      intent.disabledManifestSha256 !== disabledSha256 ||
      !hasExactKeys(completed, [
        'schema',
        'schemaVersion',
        'sessionId',
        'profile',
        'completedAtMs',
        'intentSha256',
        'disabledManifestSha256',
      ]) ||
      completed?.schema !==
        'qinglong/manual-primary-canary-rollback-complete@v1' ||
      completed.schemaVersion !== 1 ||
      completed.sessionId !== plan.sessionId ||
      completed.profile !== plan.profile ||
      !Number.isSafeInteger(completed.completedAtMs) ||
      completed.completedAtMs < intent.createdAtMs ||
      completed.intentSha256 !== intentRead.sha256 ||
      completed.disabledManifestSha256 !== disabledSha256
    ) {
      throw new TypeError('Rollback receipt chain drifted');
    }
    rolloutMode = 'off';
  }
  let runtimeActivationObserved = false;
  let runtimeActivationCurrent = false;
  let runtimeReceiptState = 'missing';
  let runtimeProcessState = 'missing';
  const runtimeReceiptPath = path.join(
    options.root,
    MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE,
  );
  if (regularFile(runtimeReceiptPath)) {
    const receipt = parseManualPrimaryRuntimeReceipt(
      readPrivateJson(
        runtimeReceiptPath,
        MAX_MANUAL_PRIMARY_RUNTIME_RECEIPT_BYTES,
      ).value,
    );
    runtimeReceiptState = receipt.state;
    const selectionPath = resolve('selection');
    if (regularFile(selectionPath)) {
      const selection = readPrivateJson(selectionPath, 64 * 1024).value;
      runtimeActivationObserved =
        receipt.revision === `manual-primary-${plan.sessionId}` &&
        receipt.profile === plan.profile &&
        selection?.schema === 'qinglong/manual-primary-canary-selection@v1' &&
        selection.sessionId === plan.sessionId &&
        selection.profile === plan.profile &&
        selection.manifestSha256 === receipt.rolloutSourceSha256;
    }
    if (receipt.state === 'active') {
      runtimeProcessState = (
        dependencies.inspectRuntimeProcess ?? inspectRuntimeProcess
      )(receipt.process);
      runtimeActivationCurrent = runtimeProcessState === 'running';
    }
  }
  const compatible =
    options.require === 'prepared' ||
    (options.require === 'qualified' && eligible) ||
    (options.require === 'selected' && rolloutMode === 'primary_selected') ||
    (options.require === 'active' &&
      rolloutMode === 'primary_selected' &&
      runtimeActivationObserved &&
      runtimeActivationCurrent) ||
    (options.require === 'off' &&
      rolloutMode === 'off' &&
      !runtimeActivationCurrent) ||
    (options.require === 'rolled-back' &&
      rolloutMode === 'off' &&
      rolledBack &&
      !runtimeActivationCurrent);
  const report = {
    schema: 'qinglong/manual-primary-canary-audit@v1',
    schemaVersion: 1,
    sessionId: plan.sessionId,
    profile: plan.profile,
    admissionTarget: plan.admissionTarget,
    eligible,
    rolloutMode,
    approvalExpired,
    runtimeActivationObserved,
    runtimeActivationCurrent,
    runtimeReceiptState,
    runtimeProcessState,
    rolledBack,
    planSha256: planRead.sha256,
    ...(rolloutSha256 === undefined ? {} : { rolloutSha256 }),
    requirement: options.require,
    compatible,
  };
  if (!compatible) {
    const error = new Error(
      'Manual Primary canary requirement is not satisfied',
    );
    error.report = report;
    throw error;
  }
  return report;
}

function main() {
  process.stdout.write(
    `${JSON.stringify(run(parseArguments(process.argv.slice(2))))}\n`,
  );
}

module.exports = { parseArguments, run };

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
