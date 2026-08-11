import { assertCompletionReceiptId } from './completionReceipt';
import { assertLocalExecutionArtifactId } from './localExecutionArtifact';

export const LOCAL_ARTIFACT_RETENTION_DISPOSITIONS = [
  'deleted',
  'already_absent',
] as const;

export type LocalArtifactRetentionDisposition =
  (typeof LOCAL_ARTIFACT_RETENTION_DISPOSITIONS)[number];

export interface LocalArtifactRetentionCursor {
  finishedAtMs: number;
  attemptId: string;
}

export interface LocalArtifactRetentionCandidate
  extends LocalArtifactRetentionCursor {
  logArtifactId: string;
}

export interface LocalArtifactRetentionRecord
  extends LocalArtifactRetentionCandidate {
  eligibleAtMs: number;
  disposition: LocalArtifactRetentionDisposition;
  bytesReclaimed: number;
  recordedAtMs: number;
}

export function assertLocalArtifactRetentionTimestamp(
  name: string,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function normalizeLocalArtifactRetentionCursor(
  cursor: LocalArtifactRetentionCursor,
): Readonly<LocalArtifactRetentionCursor> {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new TypeError('Local Artifact retention cursor must be an object');
  }
  assertLocalArtifactRetentionTimestamp('finishedAtMs', cursor.finishedAtMs);
  assertCompletionReceiptId(cursor.attemptId, 'attemptId');
  return Object.freeze({
    finishedAtMs: cursor.finishedAtMs,
    attemptId: cursor.attemptId,
  });
}

export function normalizeLocalArtifactRetentionCandidate(
  candidate: LocalArtifactRetentionCandidate,
): Readonly<LocalArtifactRetentionCandidate> {
  const cursor = normalizeLocalArtifactRetentionCursor(candidate);
  assertLocalExecutionArtifactId(candidate.logArtifactId);
  return Object.freeze({
    ...cursor,
    logArtifactId: candidate.logArtifactId,
  });
}

export function normalizeLocalArtifactRetentionRecord(
  record: LocalArtifactRetentionRecord,
): Readonly<LocalArtifactRetentionRecord> {
  const candidate = normalizeLocalArtifactRetentionCandidate(record);
  assertLocalArtifactRetentionTimestamp('eligibleAtMs', record.eligibleAtMs);
  assertLocalArtifactRetentionTimestamp('recordedAtMs', record.recordedAtMs);
  assertLocalArtifactRetentionTimestamp(
    'bytesReclaimed',
    record.bytesReclaimed,
  );
  if (record.eligibleAtMs < record.finishedAtMs) {
    throw new TypeError('eligibleAtMs must not precede finishedAtMs');
  }
  if (record.recordedAtMs < record.eligibleAtMs) {
    throw new TypeError('recordedAtMs must not precede eligibleAtMs');
  }
  if (!LOCAL_ARTIFACT_RETENTION_DISPOSITIONS.includes(record.disposition)) {
    throw new TypeError('Local Artifact retention disposition is invalid');
  }
  if (record.disposition === 'already_absent' && record.bytesReclaimed !== 0) {
    throw new TypeError('An absent Artifact cannot reclaim bytes');
  }
  return Object.freeze({
    ...candidate,
    eligibleAtMs: record.eligibleAtMs,
    disposition: record.disposition,
    bytesReclaimed: record.bytesReclaimed,
    recordedAtMs: record.recordedAtMs,
  });
}
