import { createHash } from 'crypto';
import {
  parseLegacyShadowPrimaryGateReceipt,
  type LegacyShadowPrimaryGateReceipt,
} from './legacyShadowPrimaryGate';
import {
  parseRuntimeRolloutManifest,
  REQUIRED_RUNTIME_ROLLOUT_GATES,
  type DisabledRuntimeRolloutManifest,
  type EnabledRuntimeRolloutManifest,
} from './runtimeRolloutManifest';

export const MANUAL_PRIMARY_CANARY_PLAN_SCHEMA =
  'qinglong/manual-primary-canary-plan@v1';
export const MANUAL_PRIMARY_CANARY_QUALIFICATION_SCHEMA =
  'qinglong/manual-primary-canary-qualification@v1';
export const MANUAL_PRIMARY_CANARY_MINIMUM_SETTLING_AGE_MS = 5 * 60_000;
export const MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS = 24 * 60 * 60 * 1_000;

const SESSION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ManualPrimaryCanaryProfile = 'edge' | 'standalone';
export type ManualPrimaryCanaryCurrentRollout =
  | { state: 'absent' }
  | { state: 'disabled'; sha256: string };

export interface ManualPrimaryCanaryFileSet {
  plan: string;
  capture: string;
  terminal: string;
  resource: string;
  primaryGate: string;
  qualification: string;
  selection: string;
  previousRollout: string;
  rollbackIntent: string;
  rollbackComplete: string;
  rollout: 'qinglong3-rollout.json';
}

export interface ManualPrimaryCanaryPlan {
  schema: typeof MANUAL_PRIMARY_CANARY_PLAN_SCHEMA;
  schemaVersion: 1;
  sessionId: string;
  profile: ManualPrimaryCanaryProfile;
  origin: 'manual';
  createdAtMs: number;
  admissionTarget: number;
  minimumSettlingAgeMs: typeof MANUAL_PRIMARY_CANARY_MINIMUM_SETTLING_AGE_MS;
  currentRollout: ManualPrimaryCanaryCurrentRollout;
  files: ManualPrimaryCanaryFileSet;
  activation: {
    maxApprovalMs: typeof MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS;
    defaultMode: 'off';
    allowLegacyFallbackBeforeStart: false;
  };
}

export interface ManualPrimaryCanaryQualification {
  schema: typeof MANUAL_PRIMARY_CANARY_QUALIFICATION_SCHEMA;
  schemaVersion: 1;
  sessionId: string;
  profile: ManualPrimaryCanaryProfile;
  origin: 'manual';
  qualifiedAtMs: number;
  assessment: 'eligible';
  planSha256: string;
  primaryGateFileSha256: string;
  sourceFileSha256: {
    capture: string;
    terminal: string;
    resource: string;
  };
  sourceCanonicalSha256: {
    capture: string;
    terminal: string;
    resource: string;
  };
  window: {
    startInclusiveMs: number;
    endExclusiveMs: number;
  };
  counts: {
    admitted: number;
    captured: number;
    terminalScanned: number;
    terminalMatched: number;
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${name} shape is invalid`);
  }
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 digest`);
  }
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_PATTERN.test(value)) {
    throw new TypeError('Manual Primary canary session id is invalid');
  }
  return value;
}

function profile(value: unknown): ManualPrimaryCanaryProfile {
  if (value !== 'edge' && value !== 'standalone') {
    throw new TypeError('Manual Primary canary profile is invalid');
  }
  return value;
}

function admissionTarget(
  selectedProfile: ManualPrimaryCanaryProfile,
  value: unknown,
): number {
  const target = safeInteger(value, 'admissionTarget');
  if (
    (selectedProfile === 'edge' && target !== 8) ||
    (selectedProfile === 'standalone' && (target < 32 || target > 128))
  ) {
    throw new TypeError('Manual Primary canary admission target is invalid');
  }
  return target;
}

export function manualPrimaryCanaryFileSet(
  rawSessionId: string,
): ManualPrimaryCanaryFileSet {
  const id = sessionId(rawSessionId);
  const prefix = `ql3-primary-canary-${id}`;
  return Object.freeze({
    plan: `${prefix}.plan.json`,
    capture: `${prefix}.capture.json`,
    terminal: `${prefix}.terminal.json`,
    resource: `${prefix}.resource.json`,
    primaryGate: `${prefix}.primary-gate.json`,
    qualification: `${prefix}.qualification.json`,
    selection: `${prefix}.selection.json`,
    previousRollout: `${prefix}.previous-rollout.json`,
    rollbackIntent: `${prefix}.rollback-intent.json`,
    rollbackComplete: `${prefix}.rollback-complete.json`,
    rollout: 'qinglong3-rollout.json',
  });
}

export function manualPrimaryCanarySha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createManualPrimaryCanaryPlan(input: {
  sessionId: string;
  profile: ManualPrimaryCanaryProfile;
  createdAtMs: number;
  admissionTarget: number;
  currentRollout: ManualPrimaryCanaryCurrentRollout;
}): ManualPrimaryCanaryPlan {
  const id = sessionId(input.sessionId);
  const selectedProfile = profile(input.profile);
  const createdAtMs = safeInteger(input.createdAtMs, 'createdAtMs');
  const target = admissionTarget(selectedProfile, input.admissionTarget);
  const currentRollout = input.currentRollout;
  if (currentRollout.state === 'disabled') {
    sha256(currentRollout.sha256, 'currentRollout.sha256');
  } else if (currentRollout.state !== 'absent') {
    throw new TypeError('Current rollout state is invalid');
  }
  return Object.freeze({
    schema: MANUAL_PRIMARY_CANARY_PLAN_SCHEMA,
    schemaVersion: 1,
    sessionId: id,
    profile: selectedProfile,
    origin: 'manual',
    createdAtMs,
    admissionTarget: target,
    minimumSettlingAgeMs: MANUAL_PRIMARY_CANARY_MINIMUM_SETTLING_AGE_MS,
    currentRollout: { ...currentRollout },
    files: manualPrimaryCanaryFileSet(id),
    activation: {
      maxApprovalMs: MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS,
      defaultMode: 'off' as const,
      allowLegacyFallbackBeforeStart: false as const,
    },
  });
}

export function parseManualPrimaryCanaryPlan(
  value: unknown,
): ManualPrimaryCanaryPlan {
  const plan = record(value, 'plan');
  exactKeys(
    plan,
    [
      'schema',
      'schemaVersion',
      'sessionId',
      'profile',
      'origin',
      'createdAtMs',
      'admissionTarget',
      'minimumSettlingAgeMs',
      'currentRollout',
      'files',
      'activation',
    ],
    'plan',
  );
  if (
    plan.schema !== MANUAL_PRIMARY_CANARY_PLAN_SCHEMA ||
    plan.schemaVersion !== 1 ||
    plan.origin !== 'manual' ||
    plan.minimumSettlingAgeMs !== MANUAL_PRIMARY_CANARY_MINIMUM_SETTLING_AGE_MS
  ) {
    throw new TypeError('Manual Primary canary plan header is invalid');
  }
  const selectedProfile = profile(plan.profile);
  const id = sessionId(plan.sessionId);
  const current = record(plan.currentRollout, 'plan.currentRollout');
  if (current.state === 'absent') {
    exactKeys(current, ['state'], 'plan.currentRollout');
  } else if (current.state === 'disabled') {
    exactKeys(current, ['state', 'sha256'], 'plan.currentRollout');
    sha256(current.sha256, 'plan.currentRollout.sha256');
  } else {
    throw new TypeError('Manual Primary canary current rollout is invalid');
  }
  const files = record(plan.files, 'plan.files');
  const expectedFiles = manualPrimaryCanaryFileSet(id);
  exactKeys(files, Object.keys(expectedFiles), 'plan.files');
  for (const [key, expected] of Object.entries(expectedFiles)) {
    if (files[key] !== expected) {
      throw new TypeError(`plan.files.${key} is invalid`);
    }
  }
  const activation = record(plan.activation, 'plan.activation');
  exactKeys(
    activation,
    ['maxApprovalMs', 'defaultMode', 'allowLegacyFallbackBeforeStart'],
    'plan.activation',
  );
  if (
    activation.maxApprovalMs !== MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS ||
    activation.defaultMode !== 'off' ||
    activation.allowLegacyFallbackBeforeStart !== false
  ) {
    throw new TypeError('Manual Primary canary activation policy is invalid');
  }
  return createManualPrimaryCanaryPlan({
    sessionId: id,
    profile: selectedProfile,
    createdAtMs: safeInteger(plan.createdAtMs, 'plan.createdAtMs'),
    admissionTarget: admissionTarget(selectedProfile, plan.admissionTarget),
    currentRollout: current as ManualPrimaryCanaryCurrentRollout,
  });
}

export function createManualPrimaryCanaryQualification(input: {
  plan: ManualPrimaryCanaryPlan;
  planSha256: string;
  primaryGate: LegacyShadowPrimaryGateReceipt;
  primaryGateFileSha256: string;
  sourceFileSha256: {
    capture: string;
    terminal: string;
    resource: string;
  };
  qualifiedAtMs: number;
}): ManualPrimaryCanaryQualification {
  const plan = parseManualPrimaryCanaryPlan(input.plan);
  const gate = parseLegacyShadowPrimaryGateReceipt(input.primaryGate);
  const qualifiedAtMs = safeInteger(input.qualifiedAtMs, 'qualifiedAtMs');
  if (
    gate.assessment !== 'eligible' ||
    gate.profile !== plan.profile ||
    gate.origin !== plan.origin ||
    gate.counts.admitted !== plan.admissionTarget ||
    gate.counts.captured !== plan.admissionTarget ||
    gate.counts.terminalScanned !== plan.admissionTarget ||
    gate.counts.terminalMatched !== plan.admissionTarget ||
    gate.window.startInclusiveMs < plan.createdAtMs ||
    gate.window.endExclusiveMs > gate.generatedAtMs ||
    gate.generatedAtMs > qualifiedAtMs
  ) {
    throw new TypeError('Manual Primary canary gate does not match the plan');
  }
  return Object.freeze({
    schema: MANUAL_PRIMARY_CANARY_QUALIFICATION_SCHEMA,
    schemaVersion: 1,
    sessionId: plan.sessionId,
    profile: plan.profile,
    origin: 'manual',
    qualifiedAtMs,
    assessment: 'eligible',
    planSha256: sha256(input.planSha256, 'planSha256'),
    primaryGateFileSha256: sha256(
      input.primaryGateFileSha256,
      'primaryGateFileSha256',
    ),
    sourceFileSha256: {
      capture: sha256(input.sourceFileSha256.capture, 'capture file digest'),
      terminal: sha256(input.sourceFileSha256.terminal, 'terminal file digest'),
      resource: sha256(input.sourceFileSha256.resource, 'resource file digest'),
    },
    sourceCanonicalSha256: {
      capture: gate.evidence.captureSha256,
      terminal: gate.evidence.terminalSha256,
      resource: gate.evidence.resourceSha256,
    },
    window: { ...gate.window },
    counts: { ...gate.counts },
  });
}

export function parseManualPrimaryCanaryQualification(
  value: unknown,
): ManualPrimaryCanaryQualification {
  const qualification = record(value, 'qualification');
  exactKeys(
    qualification,
    [
      'schema',
      'schemaVersion',
      'sessionId',
      'profile',
      'origin',
      'qualifiedAtMs',
      'assessment',
      'planSha256',
      'primaryGateFileSha256',
      'sourceFileSha256',
      'sourceCanonicalSha256',
      'window',
      'counts',
    ],
    'qualification',
  );
  if (
    qualification.schema !== MANUAL_PRIMARY_CANARY_QUALIFICATION_SCHEMA ||
    qualification.schemaVersion !== 1 ||
    qualification.origin !== 'manual' ||
    qualification.assessment !== 'eligible'
  ) {
    throw new TypeError('Manual Primary canary qualification is invalid');
  }
  sessionId(qualification.sessionId);
  profile(qualification.profile);
  safeInteger(qualification.qualifiedAtMs, 'qualification.qualifiedAtMs');
  sha256(qualification.planSha256, 'qualification.planSha256');
  sha256(
    qualification.primaryGateFileSha256,
    'qualification.primaryGateFileSha256',
  );
  for (const name of ['sourceFileSha256', 'sourceCanonicalSha256'] as const) {
    const digests = record(qualification[name], `qualification.${name}`);
    exactKeys(digests, ['capture', 'terminal', 'resource'], name);
    for (const key of ['capture', 'terminal', 'resource']) {
      sha256(digests[key], `qualification.${name}.${key}`);
    }
  }
  const window = record(qualification.window, 'qualification.window');
  exactKeys(window, ['startInclusiveMs', 'endExclusiveMs'], 'window');
  const start = safeInteger(window.startInclusiveMs, 'window.startInclusiveMs');
  const end = safeInteger(window.endExclusiveMs, 'window.endExclusiveMs');
  if (start >= end) throw new TypeError('Qualification window is invalid');
  const counts = record(qualification.counts, 'qualification.counts');
  exactKeys(
    counts,
    ['admitted', 'captured', 'terminalScanned', 'terminalMatched'],
    'counts',
  );
  const normalizedCounts = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [
      key,
      safeInteger(count, `counts.${key}`),
    ]),
  ) as ManualPrimaryCanaryQualification['counts'];
  if (new Set(Object.values(normalizedCounts)).size !== 1) {
    throw new TypeError('Qualification counts do not agree');
  }
  return qualification as unknown as ManualPrimaryCanaryQualification;
}

export function createManualPrimaryCanaryEnabledManifest(input: {
  plan: ManualPrimaryCanaryPlan;
  qualification: ManualPrimaryCanaryQualification;
  approvedBy: string;
  approvedAtMs: number;
  approvalMs: number;
}): EnabledRuntimeRolloutManifest {
  const plan = parseManualPrimaryCanaryPlan(input.plan);
  const qualification = parseManualPrimaryCanaryQualification(
    input.qualification,
  );
  const approvedAtMs = safeInteger(input.approvedAtMs, 'approvedAtMs');
  const approvalMs = safeInteger(input.approvalMs, 'approvalMs');
  if (
    qualification.sessionId !== plan.sessionId ||
    qualification.profile !== plan.profile ||
    qualification.qualifiedAtMs > approvedAtMs ||
    approvalMs < 60_000 ||
    approvalMs > MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS ||
    typeof input.approvedBy !== 'string' ||
    input.approvedBy.trim() !== input.approvedBy ||
    input.approvedBy.length < 3 ||
    input.approvedBy.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input.approvedBy)
  ) {
    throw new TypeError('Manual Primary canary approval is invalid');
  }
  const manifest: EnabledRuntimeRolloutManifest = {
    schemaVersion: 2,
    revision: `manual-primary-${plan.sessionId}`,
    enabled: true,
    approvedBy: input.approvedBy,
    approvedAtMs,
    expiresAtMs: approvedAtMs + approvalMs,
    rollbackPlanRef: plan.files.plan,
    primaryGate: {
      schema: 'qinglong/legacy-shadow-primary-gate-reference@v1',
      origin: 'manual',
      receiptFile: plan.files.primaryGate,
      receiptSha256: qualification.primaryGateFileSha256,
    },
    rollout: {
      defaultMode: 'off',
      origins: { manual: 'primary' },
      allowLegacyFallbackBeforeStart: false,
    },
    gates: Object.fromEntries(
      REQUIRED_RUNTIME_ROLLOUT_GATES.map((gate) => [gate, 'passed']),
    ) as EnabledRuntimeRolloutManifest['gates'],
  };
  parseRuntimeRolloutManifest(manifest, approvedAtMs);
  return Object.freeze(manifest);
}

export function createManualPrimaryCanaryDisabledManifest(
  rawSessionId: string,
): DisabledRuntimeRolloutManifest {
  const manifest: DisabledRuntimeRolloutManifest = {
    schemaVersion: 2,
    revision: `manual-primary-${sessionId(rawSessionId)}-rollback`,
    enabled: false,
  };
  parseRuntimeRolloutManifest(manifest, 0);
  return Object.freeze(manifest);
}
