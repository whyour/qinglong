export const RUN_RETRY_SAFETIES = [
  'unknown',
  'idempotent',
  'deduplicated',
] as const;

export type RunRetrySafety = (typeof RUN_RETRY_SAFETIES)[number];

export const MAX_RUN_ATTEMPTS = 16;
export const MAX_RUN_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface RunRetryPolicyDefinition {
  maxAttempts: number;
  retryOnLost: boolean;
  safety: RunRetrySafety;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface RunRetryPolicyRecord extends RunRetryPolicyDefinition {
  runId: string;
  nextAttemptAtMs?: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export const NO_AUTOMATIC_RUN_RETRY: Readonly<RunRetryPolicyDefinition> = {
  maxAttempts: 1,
  retryOnLost: false,
  safety: 'unknown',
  backoffBaseMs: 0,
  backoffMaxMs: 0,
};

export class InvalidRunRetryPolicyError extends TypeError {
  readonly code = 'INVALID_RUN_RETRY_POLICY';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRunRetryPolicyError';
  }
}

function assertNonNegativeTime(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRunRetryPolicyError(
      `${name} must be a non-negative safe integer`,
    );
  }
}

export function assertRunRetryPolicyDefinition(
  policy: RunRetryPolicyDefinition,
): void {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > MAX_RUN_ATTEMPTS
  ) {
    throw new InvalidRunRetryPolicyError(
      `maxAttempts must be between 1 and ${MAX_RUN_ATTEMPTS}`,
    );
  }
  if (typeof policy.retryOnLost !== 'boolean') {
    throw new InvalidRunRetryPolicyError('retryOnLost must be boolean');
  }
  if (!RUN_RETRY_SAFETIES.includes(policy.safety)) {
    throw new InvalidRunRetryPolicyError('safety is not supported');
  }
  assertNonNegativeTime('backoffBaseMs', policy.backoffBaseMs);
  assertNonNegativeTime('backoffMaxMs', policy.backoffMaxMs);
  if (
    policy.backoffBaseMs > MAX_RUN_RETRY_BACKOFF_MS ||
    policy.backoffMaxMs > MAX_RUN_RETRY_BACKOFF_MS
  ) {
    throw new InvalidRunRetryPolicyError(
      `retry backoff cannot exceed ${MAX_RUN_RETRY_BACKOFF_MS}ms`,
    );
  }
  if (policy.backoffMaxMs < policy.backoffBaseMs) {
    throw new InvalidRunRetryPolicyError(
      'backoffMaxMs cannot be smaller than backoffBaseMs',
    );
  }
}

export function assertAdmittedRunRetryPolicy(
  policy: RunRetryPolicyDefinition,
): void {
  assertRunRetryPolicyDefinition(policy);
  if (
    policy.retryOnLost &&
    policy.maxAttempts > 1 &&
    policy.safety === 'unknown'
  ) {
    throw new InvalidRunRetryPolicyError(
      'automatic lost retry requires idempotent or deduplicated safety',
    );
  }
}

export function assertRunRetryPolicyRecord(policy: RunRetryPolicyRecord): void {
  assertRunRetryPolicyDefinition(policy);
  if (!policy.runId) {
    throw new InvalidRunRetryPolicyError('runId is required');
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 0) {
    throw new InvalidRunRetryPolicyError(
      'version must be a non-negative safe integer',
    );
  }
  assertNonNegativeTime('createdAtMs', policy.createdAtMs);
  assertNonNegativeTime('updatedAtMs', policy.updatedAtMs);
  if (policy.updatedAtMs < policy.createdAtMs) {
    throw new InvalidRunRetryPolicyError(
      'updatedAtMs cannot be earlier than createdAtMs',
    );
  }
  if (policy.nextAttemptAtMs !== undefined) {
    assertNonNegativeTime('nextAttemptAtMs', policy.nextAttemptAtMs);
  }
}

export function runRetryDelayMs(
  policy: RunRetryPolicyDefinition,
  lostAttempt: number,
): number {
  assertRunRetryPolicyDefinition(policy);
  if (!Number.isSafeInteger(lostAttempt) || lostAttempt < 1) {
    throw new InvalidRunRetryPolicyError(
      'lostAttempt must be a positive safe integer',
    );
  }
  if (policy.backoffBaseMs === 0) return 0;
  const exponent = Math.min(lostAttempt - 1, MAX_RUN_ATTEMPTS - 1);
  return Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** exponent);
}
