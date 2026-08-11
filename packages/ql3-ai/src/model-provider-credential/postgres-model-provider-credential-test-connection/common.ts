import type { PostgresClient } from '@qinglong/runtime-core';

import { InvalidModelProviderCredentialTestConnectionError } from '../modelProviderCredentialTestConnection';
import {
  ModelProviderCredentialTestPlanUnavailableError,
  type PostgresModelProviderCredentialTestPlanOptions,
} from './contracts';

export type Row = Record<string, unknown>;

const DEFAULT_QUOTA_WINDOW_MS = 60_000;
const DEFAULT_QUOTA_LIMIT = 5;
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelProviderCredentialTestConnectionError();
  }
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidModelProviderCredentialTestConnectionError();
  }
  return candidate;
}

export function options(
  value: PostgresModelProviderCredentialTestPlanOptions | undefined,
): Readonly<{ quotaWindowMs: number; quotaLimit: number }> {
  if (value !== undefined) exact(value, ['quotaLimit', 'quotaWindowMs']);
  const quotaWindowMs = value?.quotaWindowMs ?? DEFAULT_QUOTA_WINDOW_MS;
  const quotaLimit = value?.quotaLimit ?? DEFAULT_QUOTA_LIMIT;
  if (
    !Number.isSafeInteger(quotaWindowMs) ||
    quotaWindowMs < 1_000 ||
    quotaWindowMs > 5 * 60_000 ||
    !Number.isSafeInteger(quotaLimit) ||
    quotaLimit < 1 ||
    quotaLimit > 32
  ) {
    throw new TypeError(
      'PostgreSQL model provider credential test plan options are invalid',
    );
  }
  return Object.freeze({ quotaWindowMs, quotaLimit });
}

export function integer(value: unknown, minimum = 0): number {
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < minimum) {
    throw new ModelProviderCredentialTestPlanUnavailableError();
  }
  return normalized as number;
}

export function text(value: unknown, pattern: RegExp = IDENTIFIER_PATTERN): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ModelProviderCredentialTestPlanUnavailableError();
  }
  return value;
}

export async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export function sqlState(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}
