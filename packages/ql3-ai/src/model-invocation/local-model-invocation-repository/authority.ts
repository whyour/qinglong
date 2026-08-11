import type { DatabaseSync } from 'node:sqlite';

import { assertLocalModelInvocationFeatureActive } from '../../feature-activation/localModelInvocationFeatureActivation';
import {
  PluginPackagePromptOutputArtifactConflictError,
  PluginPackagePromptOutputArtifactUnavailableError,
} from '../../prompt-output/pluginPackagePromptOutputArtifact';
import { ModelInvocationUsageSummaryLimitExceededError } from '../../usage/usageLedger';
import { ModelInvocationProjectQuotaExceededError } from '../../usage/usageQuota';
import {
  MAX_MODEL_INVOCATION_RECOVERY_PAGE_SIZE,
  ModelInvocationConflictError,
  ModelInvocationRepositoryUnavailableError,
} from '../modelInvocation';

export type Row = Record<string, unknown>;

export interface LocalModelInvocationOperationAuthority {
  readonly client: DatabaseSync;
  enqueue<T>(
    work: () => Promise<T>,
    rejection: (reason: 'closed' | 'busy') => Error,
  ): Promise<T>;
}

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export function unavailable(
  cause?: unknown,
): ModelInvocationRepositoryUnavailableError {
  return new ModelInvocationRepositoryUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

export function assertLocalFeatureActive(client: DatabaseSync): void {
  try {
    assertLocalModelInvocationFeatureActive(client);
  } catch (error) {
    throw unavailable(error);
  }
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
}

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

export function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

export function recoveryLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MODEL_INVOCATION_RECOVERY_PAGE_SIZE
  ) {
    throw unavailable();
  }
  return value;
}

export function sqliteCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : '';
}

export function mapStorageError(error: unknown): Error {
  if (
    error instanceof ModelInvocationConflictError ||
    error instanceof ModelInvocationRepositoryUnavailableError ||
    error instanceof ModelInvocationUsageSummaryLimitExceededError ||
    error instanceof ModelInvocationProjectQuotaExceededError ||
    error instanceof PluginPackagePromptOutputArtifactConflictError ||
    error instanceof PluginPackagePromptOutputArtifactUnavailableError
  ) {
    return error;
  }
  const code = sqliteCode(error);
  if (code.startsWith('ERR_SQLITE_CONSTRAINT')) {
    return new ModelInvocationConflictError();
  }
  return unavailable(error);
}

export class PrivateLocalAuthority
  implements LocalModelInvocationOperationAuthority
{
  readonly client: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  enqueue<T>(
    work: () => Promise<T>,
    rejection: (reason: 'closed' | 'busy') => Error,
  ): Promise<T> {
    if (this.#pending >= 64) return Promise.reject(rejection('busy'));
    this.#pending += 1;
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#pending -= 1;
    });
  }
}

export function isAuthority(
  value: LocalModelInvocationOperationAuthority | DatabaseSync,
): value is LocalModelInvocationOperationAuthority {
  return (
    !!value &&
    typeof value === 'object' &&
    'client' in value &&
    'enqueue' in value &&
    typeof value.enqueue === 'function'
  );
}

export function enqueueLocalModelInvocation<T>(
  authority: LocalModelInvocationOperationAuthority,
  work: () => T,
): Promise<T> {
  return authority.enqueue(async () => {
    try {
      return work();
    } catch (error) {
      throw mapStorageError(error);
    }
  }, unavailable);
}
