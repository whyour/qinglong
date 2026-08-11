import { assertCompletionReceiptId } from './completionReceipt';
import {
  LOCAL_ARTIFACT_RETENTION_DISPOSITIONS,
  assertLocalArtifactRetentionTimestamp,
  type LocalArtifactRetentionDisposition,
} from './localArtifactRetention';
import { assertLocalExecutionArtifactId } from './localExecutionArtifact';
import {
  MAX_POLICY_SUBJECT_ID_LENGTH,
  POLICY_SUBJECT_TYPES,
  normalizePolicySubject,
  type PolicySubject,
  type PolicySubjectType,
} from './projectPolicy';

export const MAX_LOCAL_ARTIFACT_READ_BYTES = 256 * 1024;
export const MAX_ARTIFACT_READ_SUBJECT_ID_LENGTH = MAX_POLICY_SUBJECT_ID_LENGTH;
export const ARTIFACT_READ_SUBJECT_TYPES = POLICY_SUBJECT_TYPES;

export type ArtifactReadSubjectType = PolicySubjectType;
export type ArtifactReadSubject = PolicySubject;

export interface LocalArtifactReadRange {
  offset: number;
  length: number;
}

export interface LocalArtifactReadRetentionEvidence {
  disposition: LocalArtifactRetentionDisposition;
  finishedAtMs: number;
  eligibleAtMs: number;
  bytesReclaimed: number;
  recordedAtMs: number;
}

export interface LocalArtifactReadMetadata {
  projectId: string;
  runId: string;
  attemptId: string;
  logArtifactId: string;
  retention?: LocalArtifactReadRetentionEvidence;
}

export function assertArtifactReadProjectId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Artifact read projectId is invalid');
  }
}

export function normalizeArtifactReadSubject(
  subject: ArtifactReadSubject,
): Readonly<ArtifactReadSubject> {
  return normalizePolicySubject(subject);
}

export function normalizeLocalArtifactReadRange(
  range: LocalArtifactReadRange,
): Readonly<LocalArtifactReadRange> {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new TypeError('Local Artifact read range must be an object');
  }
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new RangeError('Local Artifact read offset is invalid');
  }
  if (
    !Number.isSafeInteger(range.length) ||
    range.length < 1 ||
    range.length > MAX_LOCAL_ARTIFACT_READ_BYTES
  ) {
    throw new RangeError('Local Artifact read length is invalid');
  }
  return Object.freeze({ offset: range.offset, length: range.length });
}

export function normalizeLocalArtifactReadMetadata(
  value: LocalArtifactReadMetadata,
): Readonly<LocalArtifactReadMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Local Artifact read metadata must be an object');
  }
  assertArtifactReadProjectId(value.projectId);
  assertCompletionReceiptId(value.runId, 'runId');
  assertCompletionReceiptId(value.attemptId, 'attemptId');
  assertLocalExecutionArtifactId(value.logArtifactId);
  let retention: Readonly<LocalArtifactReadRetentionEvidence> | undefined;
  if (value.retention) {
    if (
      !LOCAL_ARTIFACT_RETENTION_DISPOSITIONS.includes(
        value.retention.disposition,
      )
    ) {
      throw new TypeError('Local Artifact retention disposition is invalid');
    }
    assertLocalArtifactRetentionTimestamp(
      'finishedAtMs',
      value.retention.finishedAtMs,
    );
    assertLocalArtifactRetentionTimestamp(
      'eligibleAtMs',
      value.retention.eligibleAtMs,
    );
    assertLocalArtifactRetentionTimestamp(
      'bytesReclaimed',
      value.retention.bytesReclaimed,
    );
    assertLocalArtifactRetentionTimestamp(
      'recordedAtMs',
      value.retention.recordedAtMs,
    );
    if (value.retention.eligibleAtMs < value.retention.finishedAtMs) {
      throw new TypeError('Artifact retention eligibility is invalid');
    }
    if (value.retention.recordedAtMs < value.retention.eligibleAtMs) {
      throw new TypeError('Artifact retention recording time is invalid');
    }
    if (
      value.retention.disposition === 'already_absent' &&
      value.retention.bytesReclaimed !== 0
    ) {
      throw new TypeError(
        'Absent Artifact retention reclaimed bytes is invalid',
      );
    }
    retention = Object.freeze({ ...value.retention });
  }
  return Object.freeze({
    projectId: value.projectId,
    runId: value.runId,
    attemptId: value.attemptId,
    logArtifactId: value.logArtifactId,
    ...(retention ? { retention } : {}),
  });
}
