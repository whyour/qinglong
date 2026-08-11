import type { PostgresQueryable } from '@qinglong/runtime-core';

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
export type Queryable = Pick<PostgresQueryable, 'query'>;

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
export const MAX_TRANSACTION_ATTEMPTS = 3;

export function unavailable(
  cause?: unknown,
): ModelInvocationRepositoryUnavailableError {
  return new ModelInvocationRepositoryUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
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
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
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

export function jsonObject(row: Row, key: string): Record<string, unknown> {
  const value = row[key];
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw unavailable();
    }
  }
  throw unavailable();
}

export function sqlState(error: unknown): string {
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
  const state = sqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ModelInvocationConflictError();
  }
  return unavailable(error);
}
