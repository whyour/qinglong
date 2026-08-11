import { createHash } from 'node:crypto';

import type {
  PluginPackagePlanOperation,
  PluginPackageRisk,
} from '../../pluginPackage';

import {
  InvalidPluginPackageLockError,
  InvalidPluginPackageInstallError,
} from './contracts';

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const OCI_LOCATOR_PATTERN =
  /^oci:\/\/([^/?#]+)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:([0-9a-f]{64})$/;
export const OCI_REGISTRY_PATTERN =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/;
export const OFFLINE_LOCATOR_PATTERN = /^offline:sha256:([0-9a-f]{64})$/;
export const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
export const PLAN_RISKS: readonly PluginPackageRisk[] = ['low', 'medium', 'high'];
export const PLAN_OPERATIONS: readonly PluginPackagePlanOperation[] = [
  'install',
  'reinstall',
  'upgrade',
  'rollback',
];
export const PLAN_FINDING_CODES = new Set([
  'architecture_unsupported',
  'deployment_profile_unsupported',
  'disk_insufficient',
  'memory_below_recommendation',
  'qinglong_version_unsupported',
  'runtime_missing',
  'runtime_version_unsupported',
]);

export function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new ErrorType(`${label} shape is invalid`);
  }
}

export function lockObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageLockError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function installObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageInstallError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function identifier(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value;
}

export function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value;
}

export function digest(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value;
}

export function timestamp(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value as number;
}

export function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value as number;
}

export function nonNegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
  ErrorType:
    | typeof InvalidPluginPackageLockError
    | typeof InvalidPluginPackageInstallError,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value as number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidPluginPackageLockError(
        'digest input contains an invalid number',
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = lockObject(value, 'digest input');
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
