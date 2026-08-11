import {
  assertApprovedActionLeaseDuration,
  assertApprovedActionLeaseIdentity,
  assertApprovedActionPageSize,
  assertApprovedActionResultCode,
  type ApprovedActionDispatchExecutionSnapshot,
} from './approvedActionDispatchExecution';
import {
  assertApprovalMutationId,
  assertApprovalTimestamp,
} from './approvalRequest';
import {
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  type PolicySubject,
} from './projectPolicy';

export const APPROVED_ACTION_RECOVERY_CONTROL_STATUSES = [
  'armed',
  'leased',
  'manual_required',
  'resolved',
] as const;

export const APPROVED_ACTION_RECOVERY_FINDINGS = [
  'verified_succeeded',
  'verified_failed',
  'still_running',
  'missing',
  'conflict',
  'unsupported',
  'unavailable',
] as const;

export const APPROVED_ACTION_RECOVERY_SOURCES = [
  'automatic_evidence',
  'human',
] as const;

export const APPROVED_ACTION_RECOVERY_DECISIONS = [
  'confirm_succeeded',
  'confirm_failed',
  'abandon_unknown',
] as const;

export type ApprovedActionRecoveryControlStatus =
  (typeof APPROVED_ACTION_RECOVERY_CONTROL_STATUSES)[number];
export type ApprovedActionRecoveryFinding =
  (typeof APPROVED_ACTION_RECOVERY_FINDINGS)[number];
export type ApprovedActionRecoverySource =
  (typeof APPROVED_ACTION_RECOVERY_SOURCES)[number];
export type ApprovedActionRecoveryDecision =
  (typeof APPROVED_ACTION_RECOVERY_DECISIONS)[number];

export interface ApprovedActionRecoveryControlRecord {
  dispatchId: string;
  projectId: string;
  executionVersion: number;
  status: ApprovedActionRecoveryControlStatus;
  version: number;
  nextScanAtMs: number | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
  findingCount: number;
  lastFindingMutationId: string | null;
  lastFinding: ApprovedActionRecoveryFinding | null;
  lastResultCode: string | null;
  lastEvidenceDigest: string | null;
  resolutionMutationId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ApprovedActionRecoveryResolutionRecord {
  dispatchId: string;
  projectId: string;
  executionVersion: number;
  mutationId: string;
  source: ApprovedActionRecoverySource;
  decision: ApprovedActionRecoveryDecision;
  evidenceDigest: string | null;
  reasonCode: string;
  resolvedBy: Readonly<PolicySubject> | null;
  resolvedAtMs: number;
}

export interface ApprovedActionRecoverySnapshot {
  action: Readonly<ApprovedActionDispatchExecutionSnapshot>;
  recovery: Readonly<ApprovedActionRecoveryControlRecord>;
  resolution: Readonly<ApprovedActionRecoveryResolutionRecord> | null;
}

export interface ApprovedActionRecoveryCursor {
  nextScanAtMs: number;
  dispatchId: string;
}

export const MAX_APPROVED_ACTION_RECOVERY_VERSION = 2_147_483_647;
export const MAX_APPROVED_ACTION_RECOVERY_FINDINGS = 2_147_483_647;

const EVIDENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidApprovedActionRecoveryError extends TypeError {
  constructor(message: string) {
    super(`Approved action recovery is invalid: ${message}`);
    this.name = 'InvalidApprovedActionRecoveryError';
  }
}

export class ApprovedActionRecoveryFenceRejectedError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_FENCE_REJECTED';

  constructor() {
    super('Approved action recovery fence was rejected');
    this.name = 'ApprovedActionRecoveryFenceRejectedError';
  }
}

export class ApprovedActionRecoveryBindingConflictError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_BINDING_CONFLICT';

  constructor() {
    super('Approved action recovery identity does not match its execution');
    this.name = 'ApprovedActionRecoveryBindingConflictError';
  }
}

export class ApprovedActionRecoveryRepositoryError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_REPOSITORY_ERROR';

  constructor() {
    super('Approved action recovery repository is unavailable');
    this.name = 'ApprovedActionRecoveryRepositoryError';
  }
}

function assertExactKeys(
  name: string,
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApprovedActionRecoveryError(`${name} shape is invalid`);
  }
}

function assertInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidApprovedActionRecoveryError(`${name} is invalid`);
  }
}

function allNull(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null);
}

export function assertApprovedActionEvidenceDigest(value: string): void {
  if (typeof value !== 'string' || !EVIDENCE_DIGEST_PATTERN.test(value)) {
    throw new InvalidApprovedActionRecoveryError(
      'evidence digest must be a lowercase SHA-256 digest',
    );
  }
}

export function normalizeApprovedActionRecoveryCursor(
  value: ApprovedActionRecoveryCursor,
): Readonly<ApprovedActionRecoveryCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionRecoveryError('cursor must be an object');
  }
  assertExactKeys('cursor', value, ['nextScanAtMs', 'dispatchId']);
  assertApprovalTimestamp('nextScanAtMs', value.nextScanAtMs);
  assertApprovalMutationId(value.dispatchId);
  return Object.freeze({ ...value });
}

export function normalizeApprovedActionRecoveryControlRecord(
  value: ApprovedActionRecoveryControlRecord,
): Readonly<ApprovedActionRecoveryControlRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionRecoveryError(
      'recovery control must be an object',
    );
  }
  assertExactKeys('recovery control', value, [
    'dispatchId',
    'projectId',
    'executionVersion',
    'status',
    'version',
    'nextScanAtMs',
    'leaseOwner',
    'leaseToken',
    'leaseExpiresAtMs',
    'findingCount',
    'lastFindingMutationId',
    'lastFinding',
    'lastResultCode',
    'lastEvidenceDigest',
    'resolutionMutationId',
    'createdAtMs',
    'updatedAtMs',
  ]);
  assertApprovalMutationId(value.dispatchId);
  assertProjectPolicyProjectId(value.projectId);
  if (!APPROVED_ACTION_RECOVERY_CONTROL_STATUSES.includes(value.status)) {
    throw new InvalidApprovedActionRecoveryError('status is invalid');
  }
  assertInteger(
    'execution version',
    value.executionVersion,
    1,
    MAX_APPROVED_ACTION_RECOVERY_VERSION,
  );
  assertInteger(
    'version',
    value.version,
    0,
    MAX_APPROVED_ACTION_RECOVERY_VERSION,
  );
  assertInteger(
    'finding count',
    value.findingCount,
    0,
    MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
  );
  assertApprovalTimestamp('createdAtMs', value.createdAtMs);
  assertApprovalTimestamp('updatedAtMs', value.updatedAtMs);
  if (value.updatedAtMs < value.createdAtMs) {
    throw new InvalidApprovedActionRecoveryError('timestamps are invalid');
  }
  if (value.nextScanAtMs !== null) {
    assertApprovalTimestamp('nextScanAtMs', value.nextScanAtMs);
    if (value.nextScanAtMs <= value.updatedAtMs) {
      throw new InvalidApprovedActionRecoveryError(
        'next scan must be after the latest update',
      );
    }
  }
  const lease = [value.leaseOwner, value.leaseToken, value.leaseExpiresAtMs];
  if (!allNull(lease) && !allPresent(lease)) {
    throw new InvalidApprovedActionRecoveryError('lease tuple is incomplete');
  }
  const hasLease = allPresent(lease);
  if (hasLease) {
    assertApprovedActionLeaseIdentity(value.leaseOwner!);
    assertApprovedActionLeaseIdentity(value.leaseToken!);
    assertApprovalTimestamp('leaseExpiresAtMs', value.leaseExpiresAtMs!);
    assertApprovedActionLeaseDuration(
      value.leaseExpiresAtMs! - value.updatedAtMs,
    );
  }
  const finding = [
    value.lastFindingMutationId,
    value.lastFinding,
    value.lastResultCode,
  ];
  if (!allNull(finding) && !allPresent(finding)) {
    throw new InvalidApprovedActionRecoveryError('finding tuple is incomplete');
  }
  if (value.lastFinding !== null) {
    assertApprovalMutationId(value.lastFindingMutationId!);
    if (!APPROVED_ACTION_RECOVERY_FINDINGS.includes(value.lastFinding)) {
      throw new InvalidApprovedActionRecoveryError('finding is invalid');
    }
    assertApprovedActionResultCode(value.lastResultCode!);
  }
  if (
    (value.findingCount === 0) !==
    (value.lastFindingMutationId === null &&
      value.lastFinding === null &&
      value.lastResultCode === null)
  ) {
    throw new InvalidApprovedActionRecoveryError('finding count is invalid');
  }
  if (value.lastEvidenceDigest !== null) {
    assertApprovedActionEvidenceDigest(value.lastEvidenceDigest);
  }
  if (value.resolutionMutationId !== null) {
    assertApprovalMutationId(value.resolutionMutationId);
  }
  if (
    value.status === 'armed' &&
    (value.nextScanAtMs === null ||
      hasLease ||
      value.resolutionMutationId !== null)
  ) {
    throw new InvalidApprovedActionRecoveryError('armed tuple is invalid');
  }
  if (
    value.status === 'leased' &&
    (!hasLease ||
      value.nextScanAtMs !== value.leaseExpiresAtMs ||
      value.resolutionMutationId !== null)
  ) {
    throw new InvalidApprovedActionRecoveryError('leased tuple is invalid');
  }
  if (
    value.status === 'manual_required' &&
    (value.nextScanAtMs !== null ||
      hasLease ||
      value.findingCount < 1 ||
      value.resolutionMutationId !== null)
  ) {
    throw new InvalidApprovedActionRecoveryError(
      'manual-required tuple is invalid',
    );
  }
  if (
    value.status === 'resolved' &&
    (value.nextScanAtMs !== null ||
      hasLease ||
      value.resolutionMutationId === null)
  ) {
    throw new InvalidApprovedActionRecoveryError('resolved tuple is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeApprovedActionRecoveryResolutionRecord(
  value: ApprovedActionRecoveryResolutionRecord,
): Readonly<ApprovedActionRecoveryResolutionRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionRecoveryError(
      'recovery resolution must be an object',
    );
  }
  assertExactKeys('recovery resolution', value, [
    'dispatchId',
    'projectId',
    'executionVersion',
    'mutationId',
    'source',
    'decision',
    'evidenceDigest',
    'reasonCode',
    'resolvedBy',
    'resolvedAtMs',
  ]);
  assertApprovalMutationId(value.dispatchId);
  assertProjectPolicyProjectId(value.projectId);
  assertInteger(
    'execution version',
    value.executionVersion,
    1,
    MAX_APPROVED_ACTION_RECOVERY_VERSION,
  );
  assertApprovalMutationId(value.mutationId);
  if (!APPROVED_ACTION_RECOVERY_SOURCES.includes(value.source)) {
    throw new InvalidApprovedActionRecoveryError('source is invalid');
  }
  if (!APPROVED_ACTION_RECOVERY_DECISIONS.includes(value.decision)) {
    throw new InvalidApprovedActionRecoveryError('decision is invalid');
  }
  assertApprovedActionResultCode(value.reasonCode);
  assertApprovalTimestamp('resolvedAtMs', value.resolvedAtMs);
  if (value.evidenceDigest !== null) {
    assertApprovedActionEvidenceDigest(value.evidenceDigest);
  }
  const resolvedBy = value.resolvedBy
    ? normalizePolicySubject(value.resolvedBy)
    : null;
  if (
    value.source === 'automatic_evidence' &&
    (value.evidenceDigest === null ||
      resolvedBy !== null ||
      value.decision === 'abandon_unknown')
  ) {
    throw new InvalidApprovedActionRecoveryError(
      'automatic resolution tuple is invalid',
    );
  }
  if (value.source === 'human' && (!resolvedBy || resolvedBy.type !== 'user')) {
    throw new InvalidApprovedActionRecoveryError(
      'human resolution requires a User',
    );
  }
  return Object.freeze({ ...value, resolvedBy });
}

export function assertApprovedActionRecoveryPageSize(value: number): void {
  assertApprovedActionPageSize(value);
}

export function assertApprovedActionRecoveryLeaseDuration(value: number): void {
  assertApprovedActionLeaseDuration(value);
}
