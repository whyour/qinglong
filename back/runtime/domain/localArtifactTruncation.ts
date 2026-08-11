import { assertCompletionReceiptId } from './completionReceipt';
import {
  MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES,
  MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES,
} from './localArtifactCapacity';
import { assertLocalExecutionArtifactId } from './localExecutionArtifact';

export const LOCAL_ARTIFACT_TRUNCATION_SCHEMA_VERSION = 1;
export const MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES = 1024;

export interface LocalArtifactTruncationFact {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  logArtifactId: string;
  maximumBytes: number;
  quotaReached: boolean;
  observedAtMs: number;
}

const FACT_KEYS = [
  'attemptId',
  'logArtifactId',
  'maximumBytes',
  'observedAtMs',
  'quotaReached',
  'runId',
  'schemaVersion',
] as const;

function assertExactKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== FACT_KEYS.length ||
    keys.some((key, index) => key !== FACT_KEYS[index])
  ) {
    throw new TypeError('Local Artifact truncation fact shape is invalid');
  }
}

export function normalizeLocalArtifactTruncationFact(
  value: LocalArtifactTruncationFact,
): Readonly<LocalArtifactTruncationFact> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Local Artifact truncation fact must be an object');
  }
  assertExactKeys(value as unknown as Record<string, unknown>);
  if (value.schemaVersion !== LOCAL_ARTIFACT_TRUNCATION_SCHEMA_VERSION) {
    throw new TypeError('Local Artifact truncation schema version is invalid');
  }
  assertCompletionReceiptId(value.runId, 'runId');
  assertCompletionReceiptId(value.attemptId, 'attemptId');
  assertLocalExecutionArtifactId(value.logArtifactId);
  if (
    !Number.isSafeInteger(value.maximumBytes) ||
    value.maximumBytes < MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES ||
    value.maximumBytes > MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES
  ) {
    throw new TypeError('Local Artifact truncation maximumBytes is invalid');
  }
  if (typeof value.quotaReached !== 'boolean') {
    throw new TypeError('Local Artifact truncation quotaReached is invalid');
  }
  if (!Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) {
    throw new TypeError('Local Artifact truncation observedAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: LOCAL_ARTIFACT_TRUNCATION_SCHEMA_VERSION,
    runId: value.runId,
    attemptId: value.attemptId,
    logArtifactId: value.logArtifactId,
    maximumBytes: value.maximumBytes,
    quotaReached: value.quotaReached,
    observedAtMs: value.observedAtMs,
  });
}

export function encodeLocalArtifactTruncationFact(
  value: LocalArtifactTruncationFact,
): string {
  const fact = normalizeLocalArtifactTruncationFact(value);
  const encoded = JSON.stringify(fact);
  if (Buffer.byteLength(encoded) > MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES) {
    throw new TypeError('Local Artifact truncation fact is too large');
  }
  return encoded;
}

export function decodeLocalArtifactTruncationFact(
  value: Buffer | string,
): Readonly<LocalArtifactTruncationFact> {
  const encoded = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (
    Buffer.byteLength(encoded) < 1 ||
    Buffer.byteLength(encoded) > MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES
  ) {
    throw new TypeError('Local Artifact truncation fact size is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new TypeError('Local Artifact truncation fact JSON is invalid');
  }
  const fact = normalizeLocalArtifactTruncationFact(
    parsed as LocalArtifactTruncationFact,
  );
  if (encodeLocalArtifactTruncationFact(fact) !== encoded) {
    throw new TypeError('Local Artifact truncation fact is not canonical');
  }
  return fact;
}
