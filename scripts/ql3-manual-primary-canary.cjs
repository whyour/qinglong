#!/usr/bin/env node

require('ts-node/register/transpile-only');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createLegacyShadowPrimaryGateReceipt,
  legacyShadowPrimaryEvidenceSha256,
  parseLegacyShadowPrimaryGateReceipt,
} = require('../back/runtime/domain/legacyShadowPrimaryGate');
const {
  createManualPrimaryCanaryDisabledManifest,
  createManualPrimaryCanaryEnabledManifest,
  createManualPrimaryCanaryPlan,
  createManualPrimaryCanaryQualification,
  manualPrimaryCanarySha256,
  parseManualPrimaryCanaryPlan,
  parseManualPrimaryCanaryQualification,
} = require('../back/runtime/domain/manualPrimaryCanaryCeremony');
const {
  parseRuntimeRolloutManifest,
} = require('../back/runtime/domain/runtimeRolloutManifest');

const MAX_PRIVATE_JSON_BYTES = 1024 * 1024;
const MODES = new Set([
  'prepare',
  'observe',
  'resource',
  'qualify',
  'approve',
  'status',
  'rollback',
]);
const ROLLBACK_REASONS = new Set([
  'operator_request',
  'runtime_failure',
  'gate_rejected',
  'approval_expired',
]);

class ManualPrimaryCanaryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ManualPrimaryCanaryError';
    this.code = code;
  }
}

function integer(name, value, minimum, maximum) {
  if (!/^\d+$/u.test(value)) {
    throw new ManualPrimaryCanaryError(
      'argument_invalid',
      `${name} must be an integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ManualPrimaryCanaryError(
      'argument_invalid',
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument.startsWith('--mode=')) {
      options.mode = argument.slice('--mode='.length);
    } else if (argument.startsWith('--root=')) {
      const value = argument.slice('--root='.length);
      if (!value) throw new ManualPrimaryCanaryError('argument_invalid');
      options.root = path.resolve(value);
    } else if (argument.startsWith('--session=')) {
      options.sessionId = argument.slice('--session='.length);
    } else if (argument.startsWith('--profile=')) {
      options.profile = argument.slice('--profile='.length);
    } else if (argument.startsWith('--admissions=')) {
      options.admissions = integer(
        '--admissions',
        argument.slice('--admissions='.length),
        1,
        128,
      );
    } else if (argument.startsWith('--database=')) {
      const value = argument.slice('--database='.length);
      if (!value) throw new ManualPrimaryCanaryError('argument_invalid');
      options.database = path.resolve(value);
    } else if (argument.startsWith('--approved-by=')) {
      options.approvedBy = argument.slice('--approved-by='.length);
    } else if (argument.startsWith('--approval-ms=')) {
      options.approvalMs = integer(
        '--approval-ms',
        argument.slice('--approval-ms='.length),
        60_000,
        24 * 60 * 60 * 1_000,
      );
    } else if (argument.startsWith('--operator=')) {
      options.operator = argument.slice('--operator='.length);
    } else if (argument.startsWith('--reason=')) {
      options.reason = argument.slice('--reason='.length);
    } else {
      throw new ManualPrimaryCanaryError(
        'argument_invalid',
        `Unsupported argument: ${argument}`,
      );
    }
  }
  if (!MODES.has(options.mode)) {
    throw new ManualPrimaryCanaryError('argument_invalid', '--mode is invalid');
  }
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new ManualPrimaryCanaryError(
      'argument_invalid',
      '--root must be an absolute path',
    );
  }
  if (!options.sessionId) {
    throw new ManualPrimaryCanaryError(
      'argument_invalid',
      '--session is required',
    );
  }
  if (options.mode === 'prepare') {
    if (options.profile !== 'edge' && options.profile !== 'standalone') {
      throw new ManualPrimaryCanaryError(
        'argument_invalid',
        '--profile must be edge or standalone',
      );
    }
    if (options.admissions === undefined) {
      options.admissions = options.profile === 'edge' ? 8 : 32;
    }
  }
  if (options.mode === 'observe' && !options.database) {
    throw new ManualPrimaryCanaryError(
      'argument_invalid',
      '--database is required for observe',
    );
  }
  if (options.mode === 'approve') {
    if (!options.approvedBy) {
      throw new ManualPrimaryCanaryError(
        'argument_invalid',
        '--approved-by is required for approve',
      );
    }
    options.approvalMs ??= 60 * 60 * 1_000;
  }
  if (options.mode === 'rollback') {
    if (
      !options.operator ||
      options.operator.trim() !== options.operator ||
      options.operator.length < 3 ||
      options.operator.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(options.operator) ||
      !ROLLBACK_REASONS.has(options.reason)
    ) {
      throw new ManualPrimaryCanaryError(
        'argument_invalid',
        '--operator and a supported --reason are required for rollback',
      );
    }
  }
  return options;
}

function assertRoot(root) {
  if (!path.isAbsolute(root)) {
    throw new ManualPrimaryCanaryError('root_unsafe');
  }
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new ManualPrimaryCanaryError(
      'root_unsafe',
      'Canary root must be an owner-controlled real directory',
    );
  }
}

function filePath(root, fileName) {
  if (path.basename(fileName) !== fileName || fileName.includes('..')) {
    throw new ManualPrimaryCanaryError('file_name_invalid');
  }
  return path.join(root, fileName);
}

function readPrivateJson(sourcePath, maximumBytes = MAX_PRIVATE_JSON_BYTES) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      stat.size < 2 ||
      stat.size > maximumBytes
    ) {
      throw new ManualPrimaryCanaryError('private_file_unsafe');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0)
        throw new ManualPrimaryCanaryError('private_file_stalled');
      offset += count;
    }
    return {
      bytes,
      sha256: manualPrimaryCanarySha256(bytes),
      value: JSON.parse(bytes.toString('utf8')),
    };
  } catch (error) {
    if (error instanceof ManualPrimaryCanaryError) throw error;
    throw new ManualPrimaryCanaryError(
      'private_file_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishNoReplace(targetPath, value) {
  const bytes = Buffer.isBuffer(value) ? value : serialized(value);
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.ql3-canary-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, targetPath);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { bytes, sha256: manualPrimaryCanarySha256(bytes), state: 'created' };
}

function publishOrVerify(targetPath, value) {
  const expected = Buffer.isBuffer(value) ? value : serialized(value);
  try {
    return publishNoReplace(targetPath, expected);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readPrivateJson(targetPath);
    if (!existing.bytes.equals(expected)) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
    return { ...existing, state: 'existing' };
  }
}

function readPlan(root, sessionId) {
  const candidate = createManualPrimaryCanaryPlan({
    sessionId,
    profile: 'edge',
    createdAtMs: 0,
    admissionTarget: 8,
    currentRollout: { state: 'absent' },
  });
  const planRead = readPrivateJson(
    filePath(root, candidate.files.plan),
    64 * 1024,
  );
  const plan = parseManualPrimaryCanaryPlan(planRead.value);
  if (plan.sessionId !== sessionId) {
    throw new ManualPrimaryCanaryError('plan_session_mismatch');
  }
  return { plan, read: planRead };
}

function currentRollout(root, now) {
  const target = filePath(root, 'qinglong3-rollout.json');
  let read;
  try {
    read = readPrivateJson(target, 64 * 1024);
  } catch (error) {
    if (error.code === 'private_file_unavailable' && !fs.existsSync(target)) {
      return { state: 'absent', target };
    }
    throw error;
  }
  const decision = parseRuntimeRolloutManifest(read.value, now);
  return {
    state: decision.manifest.enabled ? 'enabled' : 'disabled',
    target,
    read,
    manifest: decision.manifest,
  };
}

function assertRolloutExpectation(plan, current) {
  if (plan.currentRollout.state !== current.state) {
    throw new ManualPrimaryCanaryError('rollout_changed');
  }
  if (
    current.state === 'disabled' &&
    plan.currentRollout.sha256 !== current.read.sha256
  ) {
    throw new ManualPrimaryCanaryError('rollout_changed');
  }
}

function replaceRollout(targetPath, expected, nextBytes) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.ql3-rollout-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, nextBytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = fs.existsSync(targetPath)
      ? readPrivateJson(targetPath, 64 * 1024)
      : undefined;
    if (
      (expected === undefined && current !== undefined) ||
      (expected !== undefined && current?.sha256 !== expected)
    ) {
      throw new ManualPrimaryCanaryError('rollout_changed');
    }
    if (current === undefined) {
      fs.linkSync(temporaryPath, targetPath);
      fs.unlinkSync(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, targetPath);
    }
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function validateCapture(plan, value, now) {
  const evidence = value && typeof value === 'object' ? value : {};
  const capture = evidence.capture ?? {};
  const totals = capture.totals ?? {};
  if (
    evidence.schema !== 'qinglong/legacy-shadow-capture-evidence@v1' ||
    evidence.profile !== plan.profile ||
    evidence.qualification?.passed !== true ||
    capture.profile !== plan.profile ||
    capture.assessment !== 'captured' ||
    capture.capturePermille !== 1_000 ||
    capture.window?.basis !== 'process_local_legacy_admission' ||
    !Number.isSafeInteger(capture.window?.startInclusiveMs) ||
    !Number.isSafeInteger(capture.window?.endExclusiveMs) ||
    capture.window.startInclusiveMs >= capture.window.endExclusiveMs ||
    capture.configuredOriginCount !== 1 ||
    capture.byOrigin?.length !== 1 ||
    capture.byOrigin[0]?.origin !== 'manual' ||
    capture.byOrigin[0]?.admitted !== plan.admissionTarget ||
    capture.byOrigin[0]?.captured !== plan.admissionTarget ||
    capture.byOrigin[0]?.failed !== 0 ||
    capture.byOrigin[0]?.pending !== 0 ||
    totals.admitted !== plan.admissionTarget ||
    totals.captured !== plan.admissionTarget ||
    totals.failed !== 0 ||
    totals.pending !== 0 ||
    capture.window?.startInclusiveMs < plan.createdAtMs ||
    capture.window?.endExclusiveMs + plan.minimumSettlingAgeMs > now
  ) {
    throw new ManualPrimaryCanaryError('capture_not_ready');
  }
  return capture.window;
}

function runJsonChild(script, arguments_, timeoutMs, dependencies) {
  const result = (dependencies.spawnSync ?? spawnSync)(
    process.execPath,
    [script, ...arguments_],
    {
      cwd: dependencies.workspaceRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_PRIVATE_JSON_BYTES,
      env: process.env,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new ManualPrimaryCanaryError('evidence_child_failed');
  }
  if (
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > MAX_PRIVATE_JSON_BYTES
  ) {
    throw new ManualPrimaryCanaryError('evidence_child_output_invalid');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ManualPrimaryCanaryError('evidence_child_output_invalid');
  }
}

function prepare(options, dependencies) {
  assertRoot(options.root);
  const now = dependencies.clock.now();
  const current = currentRollout(options.root, now);
  if (current.state === 'enabled') {
    throw new ManualPrimaryCanaryError('primary_already_enabled');
  }
  const expectedFiles = createManualPrimaryCanaryPlan({
    sessionId: options.sessionId,
    profile: options.profile,
    createdAtMs: 0,
    admissionTarget: options.admissions,
    currentRollout: { state: 'absent' },
  }).files;
  const existingPlanPath = filePath(options.root, expectedFiles.plan);
  if (existsRegular(existingPlanPath)) {
    const existing = parseManualPrimaryCanaryPlan(
      readPrivateJson(existingPlanPath, 64 * 1024).value,
    );
    if (
      existing.profile !== options.profile ||
      existing.admissionTarget !== options.admissions
    ) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
    assertRolloutExpectation(existing, current);
    return {
      state: 'prepared',
      publication: 'existing',
      sessionId: existing.sessionId,
      profile: existing.profile,
      admissionTarget: existing.admissionTarget,
      environment: {
        QL_DEPLOYMENT_PROFILE: existing.profile,
        QL3_SHADOW_ORIGINS: 'manual',
        QL3_SHADOW_CAPTURE_EVIDENCE_FILE: existing.files.capture,
      },
      automaticActivation: false,
    };
  }
  const plan = createManualPrimaryCanaryPlan({
    sessionId: options.sessionId,
    profile: options.profile,
    createdAtMs: now,
    admissionTarget: options.admissions,
    currentRollout:
      current.state === 'absent'
        ? { state: 'absent' }
        : { state: 'disabled', sha256: current.read.sha256 },
  });
  const publication = publishOrVerify(
    filePath(options.root, plan.files.plan),
    plan,
  );
  return {
    state: 'prepared',
    publication: publication.state,
    sessionId: plan.sessionId,
    profile: plan.profile,
    admissionTarget: plan.admissionTarget,
    environment: {
      QL_DEPLOYMENT_PROFILE: plan.profile,
      QL3_SHADOW_ORIGINS: 'manual',
      QL3_SHADOW_CAPTURE_EVIDENCE_FILE: plan.files.capture,
    },
    automaticActivation: false,
  };
}

function observe(options, dependencies) {
  assertRoot(options.root);
  const { plan } = readPlan(options.root, options.sessionId);
  const now = dependencies.clock.now();
  const capture = readPrivateJson(filePath(options.root, plan.files.capture));
  const window = validateCapture(plan, capture.value, now);
  const terminalPath = filePath(options.root, plan.files.terminal);
  if (existsRegular(terminalPath)) {
    const terminal = readPrivateJson(terminalPath).value;
    if (
      terminal?.schema !==
        'qinglong/legacy-shadow-terminal-difference-report@v1' ||
      terminal.profile !== plan.profile ||
      terminal.assessment !== 'matched' ||
      terminal.window?.startInclusiveMs !== window.startInclusiveMs ||
      terminal.window?.endExclusiveMs !== window.endExclusiveMs ||
      terminal.scanned !== plan.admissionTarget
    ) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
    return {
      state: 'terminal_observed',
      publication: 'existing',
      sessionId: plan.sessionId,
      profile: plan.profile,
      assessment: terminal.assessment,
      scanned: terminal.scanned,
    };
  }
  const databaseStat = fs.lstatSync(options.database);
  if (
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    (typeof process.getuid === 'function' &&
      databaseStat.uid !== process.getuid()) ||
    (databaseStat.mode & 0o022) !== 0
  ) {
    throw new ManualPrimaryCanaryError('database_unsafe');
  }
  const terminal = runJsonChild(
    path.join(
      dependencies.workspaceRoot,
      'scripts/ql3-legacy-shadow-terminal-audit.cjs',
    ),
    [
      `--database=${options.database}`,
      `--profile=${plan.profile}`,
      '--origin=manual',
      `--window-start-ms=${window.startInclusiveMs}`,
      `--window-end-ms=${window.endExclusiveMs}`,
      `--observed-at-ms=${now}`,
      `--minimum-settling-age-ms=${plan.minimumSettlingAgeMs}`,
      '--json',
      '--fail-on-difference',
    ],
    30_000,
    dependencies,
  );
  const publication = publishOrVerify(terminalPath, terminal);
  return {
    state: 'terminal_observed',
    publication: publication.state,
    sessionId: plan.sessionId,
    profile: plan.profile,
    assessment: terminal.assessment,
    scanned: terminal.scanned,
  };
}

function resource(options, dependencies) {
  assertRoot(options.root);
  const { plan } = readPlan(options.root, options.sessionId);
  const resourcePath = filePath(options.root, plan.files.resource);
  if (existsRegular(resourcePath)) {
    const existing = readPrivateJson(resourcePath).value;
    if (
      existing?.fixture !==
        'qinglong/legacy-shadow-resource-rollback-evidence@v1' ||
      existing.profile !== plan.profile ||
      existing.workload?.mode !== 'full' ||
      existing.workload?.runtime !== 'compiled_backend' ||
      existing.qualification?.passed !== true ||
      existing.rollback?.performed !== true ||
      existing.rollback?.legacyContinued !== true ||
      existing.rollback?.shadowWritesStopped !== true ||
      existing.rollback?.databaseIntegrity !== 'ok'
    ) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
    return {
      state: 'resource_proven',
      publication: 'existing',
      sessionId: plan.sessionId,
      profile: plan.profile,
      qualified: true,
    };
  }
  const report = runJsonChild(
    path.join(
      dependencies.workspaceRoot,
      'scripts/ql3-legacy-shadow-resource-rollback.cjs',
    ),
    [
      `--profile=${plan.profile}`,
      '--mode=full',
      '--samples=8',
      '--require-compiled',
      '--json',
    ],
    plan.profile === 'edge' ? 120_000 : 180_000,
    dependencies,
  );
  const publication = publishOrVerify(resourcePath, report);
  return {
    state: 'resource_proven',
    publication: publication.state,
    sessionId: plan.sessionId,
    profile: plan.profile,
    qualified: report.qualification?.passed === true,
  };
}

function qualify(options, dependencies) {
  assertRoot(options.root);
  const { plan, read: planRead } = readPlan(options.root, options.sessionId);
  const gatePath = filePath(options.root, plan.files.primaryGate);
  const qualificationPath = filePath(options.root, plan.files.qualification);
  if (existsRegular(gatePath) && existsRegular(qualificationPath)) {
    const { qualification } = verifyQualification(options.root, plan, planRead);
    return {
      state: 'qualified',
      publication: 'existing',
      sessionId: plan.sessionId,
      profile: plan.profile,
      admitted: qualification.counts.admitted,
      automaticActivation: false,
    };
  }
  const capture = readPrivateJson(filePath(options.root, plan.files.capture));
  const terminal = readPrivateJson(filePath(options.root, plan.files.terminal));
  const resourceRead = readPrivateJson(
    filePath(options.root, plan.files.resource),
  );
  const now = dependencies.clock.now();
  validateCapture(plan, capture.value, now);
  const gate = existsRegular(gatePath)
    ? parseLegacyShadowPrimaryGateReceipt(
        readPrivateJson(gatePath, 64 * 1024).value,
      )
    : createLegacyShadowPrimaryGateReceipt({
        profile: plan.profile,
        generatedAtMs: now,
        capture: capture.value,
        terminal: terminal.value,
        resource: resourceRead.value,
      });
  if (gate.assessment !== 'eligible') {
    throw new ManualPrimaryCanaryError(
      'primary_gate_ineligible',
      gate.violations.join(','),
    );
  }
  if (
    legacyShadowPrimaryEvidenceSha256(capture.value) !==
      gate.evidence.captureSha256 ||
    legacyShadowPrimaryEvidenceSha256(terminal.value) !==
      gate.evidence.terminalSha256 ||
    legacyShadowPrimaryEvidenceSha256(resourceRead.value) !==
      gate.evidence.resourceSha256
  ) {
    throw new ManualPrimaryCanaryError('primary_gate_source_drift');
  }
  const gatePublication = publishOrVerify(gatePath, gate);
  const qualification = createManualPrimaryCanaryQualification({
    plan,
    planSha256: planRead.sha256,
    primaryGate: gate,
    primaryGateFileSha256: gatePublication.sha256,
    sourceFileSha256: {
      capture: capture.sha256,
      terminal: terminal.sha256,
      resource: resourceRead.sha256,
    },
    qualifiedAtMs: now,
  });
  const qualificationPublication = publishOrVerify(
    qualificationPath,
    qualification,
  );
  return {
    state: 'qualified',
    publication: qualificationPublication.state,
    sessionId: plan.sessionId,
    profile: plan.profile,
    admitted: qualification.counts.admitted,
    automaticActivation: false,
  };
}

function verifyQualification(root, plan, planRead) {
  const gateRead = readPrivateJson(
    filePath(root, plan.files.primaryGate),
    64 * 1024,
  );
  const gate = parseLegacyShadowPrimaryGateReceipt(gateRead.value);
  const qualificationRead = readPrivateJson(
    filePath(root, plan.files.qualification),
    64 * 1024,
  );
  const qualification = parseManualPrimaryCanaryQualification(
    qualificationRead.value,
  );
  const capture = readPrivateJson(filePath(root, plan.files.capture));
  const terminal = readPrivateJson(filePath(root, plan.files.terminal));
  const resource = readPrivateJson(filePath(root, plan.files.resource));
  if (
    qualification.sessionId !== plan.sessionId ||
    qualification.profile !== plan.profile ||
    qualification.planSha256 !== planRead.sha256 ||
    qualification.primaryGateFileSha256 !== gateRead.sha256 ||
    qualification.sourceFileSha256.capture !== capture.sha256 ||
    qualification.sourceFileSha256.terminal !== terminal.sha256 ||
    qualification.sourceFileSha256.resource !== resource.sha256 ||
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
    gate.counts.admitted !== plan.admissionTarget ||
    legacyShadowPrimaryEvidenceSha256(capture.value) !==
      qualification.sourceCanonicalSha256.capture ||
    legacyShadowPrimaryEvidenceSha256(terminal.value) !==
      qualification.sourceCanonicalSha256.terminal ||
    legacyShadowPrimaryEvidenceSha256(resource.value) !==
      qualification.sourceCanonicalSha256.resource ||
    gate.assessment !== 'eligible'
  ) {
    throw new ManualPrimaryCanaryError('qualification_drift');
  }
  return { gate, gateRead, qualification, qualificationRead };
}

function approve(options, dependencies) {
  assertRoot(options.root);
  const { plan, read: planRead } = readPlan(options.root, options.sessionId);
  const { qualification } = verifyQualification(options.root, plan, planRead);
  const now = dependencies.clock.now();
  const current = currentRollout(options.root, now);
  if (
    current.state === 'enabled' &&
    current.manifest.revision === `manual-primary-${plan.sessionId}`
  ) {
    if (
      current.manifest.primaryGate.receiptSha256 !==
        qualification.primaryGateFileSha256 ||
      current.manifest.primaryGate.receiptFile !== plan.files.primaryGate ||
      current.manifest.rollout.origins.manual !== 'primary' ||
      current.manifest.approvedBy !== options.approvedBy ||
      current.manifest.expiresAtMs - current.manifest.approvedAtMs !==
        options.approvalMs
    ) {
      throw new ManualPrimaryCanaryError('active_rollout_drift');
    }
    const selection = {
      schema: 'qinglong/manual-primary-canary-selection@v1',
      schemaVersion: 1,
      sessionId: plan.sessionId,
      profile: plan.profile,
      selectedAtMs: current.manifest.approvedAtMs,
      expiresAtMs: current.manifest.expiresAtMs,
      manifestSha256: current.read.sha256,
      priorRollout: plan.currentRollout,
    };
    const publication = publishOrVerify(
      filePath(options.root, plan.files.selection),
      selection,
    );
    return {
      state: 'activation_approved',
      publication: publication.state,
      sessionId: plan.sessionId,
      expiresAtMs: current.manifest.expiresAtMs,
      requiresRestart: true,
    };
  }
  assertRolloutExpectation(plan, current);
  const manifest = createManualPrimaryCanaryEnabledManifest({
    plan,
    qualification,
    approvedBy: options.approvedBy,
    approvedAtMs: now,
    approvalMs: options.approvalMs,
  });
  const manifestBytes = serialized(manifest);
  if (current.state === 'disabled') {
    publishOrVerify(
      filePath(options.root, plan.files.previousRollout),
      current.read.bytes,
    );
  }
  replaceRollout(
    current.target,
    current.state === 'disabled' ? current.read.sha256 : undefined,
    manifestBytes,
  );
  const manifestSha256 = manualPrimaryCanarySha256(manifestBytes);
  const selection = {
    schema: 'qinglong/manual-primary-canary-selection@v1',
    schemaVersion: 1,
    sessionId: plan.sessionId,
    profile: plan.profile,
    selectedAtMs: now,
    expiresAtMs: manifest.expiresAtMs,
    manifestSha256,
    priorRollout: plan.currentRollout,
  };
  const selectionPublication = publishOrVerify(
    filePath(options.root, plan.files.selection),
    selection,
  );
  return {
    state: 'activation_approved',
    publication: selectionPublication.state,
    sessionId: plan.sessionId,
    expiresAtMs: manifest.expiresAtMs,
    requiresRestart: true,
  };
}

function rollback(options, dependencies) {
  assertRoot(options.root);
  const { plan } = readPlan(options.root, options.sessionId);
  const now = dependencies.clock.now();
  const target = filePath(options.root, plan.files.rollout);
  const currentRead = readPrivateJson(target, 64 * 1024);
  const raw = currentRead.value;
  const evaluationTime =
    raw?.enabled === true && Number.isSafeInteger(raw.approvedAtMs)
      ? raw.approvedAtMs
      : now;
  const decision = parseRuntimeRolloutManifest(raw, evaluationTime);
  const disabled = createManualPrimaryCanaryDisabledManifest(plan.sessionId);
  const disabledBytes = serialized(disabled);
  const disabledSha256 = manualPrimaryCanarySha256(disabledBytes);
  if (decision.manifest.enabled === false) {
    if (currentRead.sha256 !== disabledSha256) {
      throw new ManualPrimaryCanaryError('different_disabled_rollout');
    }
  } else if (
    decision.manifest.revision !== `manual-primary-${plan.sessionId}`
  ) {
    throw new ManualPrimaryCanaryError('rollout_session_mismatch');
  }
  const intentPath = filePath(options.root, plan.files.rollbackIntent);
  let intent;
  let intentSha256;
  if (existsRegular(intentPath)) {
    const intentRead = readPrivateJson(intentPath, 64 * 1024);
    intent = intentRead.value;
    intentSha256 = intentRead.sha256;
    if (
      intent?.schema !== 'qinglong/manual-primary-canary-rollback-intent@v1' ||
      intent.sessionId !== plan.sessionId ||
      intent.profile !== plan.profile ||
      intent.operator !== options.operator ||
      intent.reason !== options.reason ||
      intent.disabledManifestSha256 !== disabledSha256 ||
      (decision.manifest.enabled === true &&
        intent.enabledManifestSha256 !== currentRead.sha256)
    ) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
  } else {
    if (decision.manifest.enabled === false) {
      throw new ManualPrimaryCanaryError('rollback_intent_missing');
    }
    intent = {
      schema: 'qinglong/manual-primary-canary-rollback-intent@v1',
      schemaVersion: 1,
      sessionId: plan.sessionId,
      profile: plan.profile,
      createdAtMs: now,
      operator: options.operator,
      reason: options.reason,
      enabledManifestSha256: currentRead.sha256,
      disabledManifestSha256: disabledSha256,
    };
    intentSha256 = publishNoReplace(intentPath, intent).sha256;
  }
  if (decision.manifest.enabled === true) {
    replaceRollout(target, currentRead.sha256, disabledBytes);
  }
  const completedPath = filePath(options.root, plan.files.rollbackComplete);
  let publication;
  if (existsRegular(completedPath)) {
    const completed = readPrivateJson(completedPath, 64 * 1024).value;
    if (
      completed?.schema !==
        'qinglong/manual-primary-canary-rollback-complete@v1' ||
      completed.sessionId !== plan.sessionId ||
      completed.profile !== plan.profile ||
      completed.intentSha256 !== intentSha256 ||
      completed.disabledManifestSha256 !== disabledSha256
    ) {
      throw new ManualPrimaryCanaryError('publication_conflict');
    }
    publication = { state: 'existing' };
  } else {
    publication = publishNoReplace(completedPath, {
      schema: 'qinglong/manual-primary-canary-rollback-complete@v1',
      schemaVersion: 1,
      sessionId: plan.sessionId,
      profile: plan.profile,
      completedAtMs: now,
      intentSha256,
      disabledManifestSha256: disabledSha256,
    });
  }
  return {
    state: 'rolled_back',
    publication: publication.state,
    sessionId: plan.sessionId,
    profile: plan.profile,
  };
}

function existsRegular(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function status(options, dependencies) {
  assertRoot(options.root);
  const { plan, read: planRead } = readPlan(options.root, options.sessionId);
  const present = Object.fromEntries(
    [
      'capture',
      'terminal',
      'resource',
      'primaryGate',
      'qualification',
      'selection',
      'rollbackIntent',
      'rollbackComplete',
    ].map((name) => [
      name,
      existsRegular(filePath(options.root, plan.files[name])),
    ]),
  );
  let stage = 'prepared';
  if (present.capture) stage = 'captured';
  if (present.terminal) stage = 'terminal_observed';
  if (present.resource) stage = 'resource_proven';
  if (present.primaryGate || present.qualification) {
    if (!present.primaryGate || !present.qualification) {
      throw new ManualPrimaryCanaryError('qualification_incomplete');
    }
    verifyQualification(options.root, plan, planRead);
    stage = 'qualified';
  }
  const rolloutTarget = filePath(options.root, plan.files.rollout);
  let rolloutMode = 'off';
  let approvalExpired = false;
  if (existsRegular(rolloutTarget)) {
    const read = readPrivateJson(rolloutTarget, 64 * 1024);
    const raw = read.value;
    const now = dependencies.clock.now();
    approvalExpired =
      raw?.enabled === true &&
      Number.isSafeInteger(raw.expiresAtMs) &&
      raw.expiresAtMs <= now;
    const evaluatedAt = approvalExpired ? raw.approvedAtMs : now;
    const decision = parseRuntimeRolloutManifest(raw, evaluatedAt);
    if (decision.manifest.enabled && !approvalExpired) {
      if (decision.manifest.revision !== `manual-primary-${plan.sessionId}`) {
        throw new ManualPrimaryCanaryError('rollout_session_mismatch');
      }
      rolloutMode = 'primary_selected';
      stage = 'activation_approved';
    } else if (approvalExpired) {
      stage = 'approval_expired';
    }
  }
  if (present.rollbackComplete) {
    const disabled = createManualPrimaryCanaryDisabledManifest(plan.sessionId);
    const read = readPrivateJson(rolloutTarget, 64 * 1024);
    if (read.sha256 !== manualPrimaryCanarySha256(serialized(disabled))) {
      throw new ManualPrimaryCanaryError('rollback_not_effective');
    }
    rolloutMode = 'off';
    stage = 'rolled_back';
  }
  return {
    state: stage,
    sessionId: plan.sessionId,
    profile: plan.profile,
    admissionTarget: plan.admissionTarget,
    rolloutMode,
    approvalExpired,
    runtimeActivationObserved: false,
    artifacts: present,
  };
}

function run(options, overrides = {}) {
  const dependencies = {
    clock: overrides.clock ?? { now: () => Date.now() },
    spawnSync: overrides.spawnSync,
    workspaceRoot: overrides.workspaceRoot ?? path.resolve(__dirname, '..'),
  };
  switch (options.mode) {
    case 'prepare':
      return prepare(options, dependencies);
    case 'observe':
      return observe(options, dependencies);
    case 'resource':
      return resource(options, dependencies);
    case 'qualify':
      return qualify(options, dependencies);
    case 'approve':
      return approve(options, dependencies);
    case 'rollback':
      return rollback(options, dependencies);
    case 'status':
      return status(options, dependencies);
    default:
      throw new ManualPrimaryCanaryError('mode_invalid');
  }
}

function main() {
  const result = run(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  MAX_PRIVATE_JSON_BYTES,
  ManualPrimaryCanaryError,
  parseArguments,
  publishNoReplace,
  publishOrVerify,
  readPrivateJson,
  run,
  serialized,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof ManualPrimaryCanaryError
        ? error.code
        : error instanceof Error
        ? error.name
        : 'unknown';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
