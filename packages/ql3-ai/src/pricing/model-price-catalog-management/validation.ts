import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  normalizeSecurityPrincipal,
  type SecurityAuthenticationAssurance,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import {
  InvalidModelPriceCatalogManagementValueError,
  MAX_MODEL_PRICE_CATALOG_PRINCIPAL_AGE_MS,
  ModelPriceCatalogManagementAuthenticationError,
  ModelPriceCatalogManagementUnavailableError,
  type ModelPriceCatalogManagementDecisionMode,
  type ModelPriceCatalogManagementOperation,
} from './contracts';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const STRONG_ASSURANCES = new Set<SecurityAuthenticationAssurance>([
  'multi_factor',
  'hardware',
  'local_console',
]);

export function invalid(message: string): never {
  throw new InvalidModelPriceCatalogManagementValueError(message);
}

export function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function requestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    return invalid('request id is invalid');
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function nullableIdentity(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : identity(value, label);
}

export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export function operation(
  value: unknown,
): ModelPriceCatalogManagementOperation {
  if (
    value !== 'publish' &&
    value !== 'activate' &&
    value !== 'deactivate' &&
    value !== 'revoke'
  ) {
    return invalid('operation is invalid');
  }
  return value;
}

export function decisionMode(
  value: unknown,
): ModelPriceCatalogManagementDecisionMode {
  if (value !== 'human_confirmation' && value !== 'separation_of_duty') {
    return invalid('decision mode is invalid');
  }
  return value;
}

export function normalizeReasons(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    value.some(
      (reason) => typeof reason !== 'string' || !REASON_PATTERN.test(reason),
    )
  ) {
    return invalid('policy reasons are invalid');
  }
  return Object.freeze([...value]);
}

export function normalizedPrincipal(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new ModelPriceCatalogManagementAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_ASSURANCES.has(principal.assurance) ||
    nowMs - principal.authenticatedAtMs >
      MAX_MODEL_PRICE_CATALOG_PRINCIPAL_AGE_MS
  ) {
    throw new ModelPriceCatalogManagementAuthenticationError();
  }
  return principal;
}

export function normalizeStoredPrincipal(
  value: SecurityPrincipal,
): Readonly<SecurityPrincipal> {
  const candidate = record(value, 'principal');
  exactKeys(
    candidate,
    [
      'subject',
      'authenticationId',
      'authenticatedAtMs',
      'expiresAtMs',
      'assurance',
    ],
    'principal',
  );
  const subject = record(value.subject, 'principal subject');
  exactKeys(subject, ['type', 'id'], 'principal subject');
  if (
    value.subject.type !== 'user' ||
    !STRONG_ASSURANCES.has(value.assurance) ||
    typeof value.authenticationId !== 'string' ||
    !IDENTITY_PATTERN.test(value.authenticationId)
  ) {
    return invalid('principal identity is invalid');
  }
  const authenticatedAtMs = integer(
    value.authenticatedAtMs,
    'principal authenticatedAtMs',
  );
  const expiresAtMs = integer(value.expiresAtMs, 'principal expiresAtMs');
  if (expiresAtMs <= authenticatedAtMs) {
    return invalid('principal lifetime is invalid');
  }
  return Object.freeze({
    subject: Object.freeze({
      type: 'user' as const,
      id: identity(value.subject.id, 'principal User id'),
    }),
    authenticationId: value.authenticationId,
    authenticatedAtMs,
    expiresAtMs,
    assurance: value.assurance,
  });
}

export function validateOperationRevision(
  operationValue: ModelPriceCatalogManagementOperation,
  revision: string | null,
): void {
  if (
    (operationValue === 'deactivate' && revision !== null) ||
    (operationValue !== 'deactivate' && revision === null)
  ) {
    invalid('operation price revision is invalid');
  }
}

export function exactRequest(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  const candidate = record(value, label);
  exactKeys(candidate, expected, label);
}

export function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ModelPriceCatalogManagementUnavailableError();
  }
  return value;
}

export function unavailable(
  error: unknown,
): ModelPriceCatalogManagementUnavailableError {
  return new ModelPriceCatalogManagementUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}
