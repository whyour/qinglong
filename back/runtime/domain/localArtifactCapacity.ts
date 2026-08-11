export const MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES = 64 * 1024;
export const MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES = 1024 * 1024 * 1024;
export const MAX_LOCAL_ARTIFACT_MINIMUM_FREE_BYTES = 1024 * 1024 * 1024 * 1024;

export interface LocalArtifactCapacityPolicy {
  maximumAttemptBytes: number;
  minimumFreeBytes: number;
}

export class LocalArtifactCapacityUnavailableError extends Error {
  readonly code = 'LOCAL_ARTIFACT_CAPACITY_UNAVAILABLE';

  constructor() {
    super('Local Artifact capacity is unavailable');
    this.name = 'LocalArtifactCapacityUnavailableError';
  }
}

export class LocalArtifactQuotaExceededError extends Error {
  readonly code = 'LOCAL_ARTIFACT_QUOTA_EXCEEDED';

  constructor() {
    super('Local Artifact reached its byte quota');
    this.name = 'LocalArtifactQuotaExceededError';
  }
}

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

export function normalizeLocalArtifactCapacityPolicy(
  policy: LocalArtifactCapacityPolicy,
): Readonly<LocalArtifactCapacityPolicy> {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Local Artifact capacity policy must be an object');
  }
  assertIntegerBetween(
    'maximumAttemptBytes',
    policy.maximumAttemptBytes,
    MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES,
    MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES,
  );
  assertIntegerBetween(
    'minimumFreeBytes',
    policy.minimumFreeBytes,
    0,
    MAX_LOCAL_ARTIFACT_MINIMUM_FREE_BYTES,
  );
  return Object.freeze({
    maximumAttemptBytes: policy.maximumAttemptBytes,
    minimumFreeBytes: policy.minimumFreeBytes,
  });
}

export function localArtifactCapacityPolicyForProfile(
  profile: 'edge' | 'standalone',
): Readonly<LocalArtifactCapacityPolicy> {
  if (profile === 'edge') {
    return Object.freeze({
      maximumAttemptBytes: 4 * 1024 * 1024,
      minimumFreeBytes: 32 * 1024 * 1024,
    });
  }
  if (profile === 'standalone') {
    return Object.freeze({
      maximumAttemptBytes: 64 * 1024 * 1024,
      minimumFreeBytes: 256 * 1024 * 1024,
    });
  }
  throw new TypeError('Local Artifact capacity profile is invalid');
}
