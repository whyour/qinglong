import {
  normalizeLocalArtifactRetentionCursor,
  type LocalArtifactRetentionCursor,
} from './localArtifactRetention';

export interface LocalArtifactRetentionCheckpoint {
  version: number;
  cursor?: LocalArtifactRetentionCursor;
}

export function normalizeLocalArtifactRetentionCheckpoint(
  value: LocalArtifactRetentionCheckpoint,
): Readonly<LocalArtifactRetentionCheckpoint> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      'Local Artifact retention checkpoint must be an object',
    );
  }
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    value.version >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      'Local Artifact retention checkpoint version is invalid',
    );
  }
  const cursor = value.cursor
    ? normalizeLocalArtifactRetentionCursor(value.cursor)
    : undefined;
  return Object.freeze({
    version: value.version,
    ...(cursor ? { cursor } : {}),
  });
}
