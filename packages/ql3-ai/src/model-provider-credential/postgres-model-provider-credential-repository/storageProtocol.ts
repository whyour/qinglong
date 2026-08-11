import { createHash } from 'node:crypto';

import type {
  PostgresClient,
  PostgresQueryable,
} from '@qinglong/runtime-core';

import {
  ModelProviderCredentialCatalogUnavailableError,
  ModelProviderCredentialTransitionConflictError,
  normalizeModelProviderCredentialTransition,
  type ModelProviderCredentialTransition,
} from '../modelProviderCredentialCatalog';
import {
  MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_OPERATIONS,
  digestModelProviderCredentialBinding,
  normalizeModelProviderCredentialBinding,
  type ModelProviderCredentialAuditRecord,
  type ModelProviderCredentialBinding,
  type ModelProviderCredentialBindingLookup,
} from '../providerCredential';

export type Row = Record<string, unknown>;
export type Queryable = Pick<PostgresQueryable, 'query'>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function unavailable(
  cause?: unknown,
): ModelProviderCredentialCatalogUnavailableError {
  return new ModelProviderCredentialCatalogUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

export function sqlState(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

export function mapStorageError(error: unknown): Error {
  if (
    error instanceof ModelProviderCredentialTransitionConflictError ||
    error instanceof ModelProviderCredentialCatalogUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(sqlState(error))) {
    return new ModelProviderCredentialTransitionConflictError();
  }
  return unavailable(error);
}

export function identity(
  value: unknown,
  pattern: RegExp = IDENTITY_PATTERN,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw unavailable();
  return value;
}

export function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

export function jsonObject(value: unknown): Record<string, unknown> {
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
      const parsed: unknown = JSON.parse(value);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.getPrototypeOf(parsed) === Object.prototype
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Mapped to the stable unavailable error below.
    }
  }
  throw unavailable();
}

export function bindingFromRow(
  row: Row,
): Readonly<ModelProviderCredentialBinding> {
  let binding: Readonly<ModelProviderCredentialBinding>;
  try {
    binding = normalizeModelProviderCredentialBinding(
      jsonObject(row.bindingJson) as unknown as ModelProviderCredentialBinding,
    );
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    binding.projectId !== identity(row.projectId) ||
    binding.provider !== identity(row.provider, PROVIDER_PATTERN) ||
    binding.revision !== identity(row.revision) ||
    binding.secretRef !==
      identity(row.secretRef, /^qlsecret:v1:[^\0\r\n]{1,500}$/) ||
    binding.scheme !== row.scheme ||
    digestModelProviderCredentialBinding(binding) !== row.bindingDigest
  ) {
    throw unavailable();
  }
  return binding;
}

export function transitionFromRow(
  row: Row,
): Readonly<ModelProviderCredentialTransition> {
  let transition: Readonly<ModelProviderCredentialTransition>;
  try {
    transition = normalizeModelProviderCredentialTransition(
      jsonObject(
        row.transitionJson,
      ) as unknown as ModelProviderCredentialTransition,
    );
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    transition.projectId !== identity(row.projectId) ||
    transition.provider !== identity(row.provider, PROVIDER_PATTERN) ||
    transition.generation !== integer(row.generation) ||
    transition.mutationId !== identity(row.mutationId) ||
    transition.commandDigest !== row.commandDigest ||
    transition.transitionDigest !== row.transitionDigest
  ) {
    throw unavailable();
  }
  return transition;
}

export async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export function normalizeLookup(
  value: Readonly<ModelProviderCredentialBindingLookup>,
): Readonly<ModelProviderCredentialBindingLookup> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== 'projectId\0provider'
  ) {
    throw unavailable();
  }
  return Object.freeze({
    projectId: identity(value.projectId),
    provider: identity(value.provider, PROVIDER_PATTERN),
  });
}

export function normalizeAuditRecord(
  value: Readonly<ModelProviderCredentialAuditRecord>,
): Readonly<ModelProviderCredentialAuditRecord> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'bindingDigest',
        'bindingRevision',
        'occurredAtMs',
        'operation',
        'projectId',
        'provider',
        'requestId',
        'schema',
      ]
        .sort()
        .join('\0') ||
    value.schema !== MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA ||
    !MODEL_PROVIDER_CREDENTIAL_OPERATIONS.includes(value.operation) ||
    typeof value.bindingDigest !== 'string' ||
    !SHA256_PATTERN.test(value.bindingDigest)
  ) {
    throw unavailable();
  }
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
    operation: value.operation,
    projectId: identity(value.projectId),
    provider: identity(value.provider, PROVIDER_PATTERN),
    requestId: identity(value.requestId),
    bindingRevision: identity(value.bindingRevision),
    bindingDigest: value.bindingDigest,
    occurredAtMs: integer(value.occurredAtMs),
  });
}

export function auditDigest(
  record: Readonly<ModelProviderCredentialAuditRecord>,
): string {
  return createHash('sha256')
    .update('qinglong/model-provider-credential-audit@v1', 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(record), 'utf8')
    .digest('hex');
}
