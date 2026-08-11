import { createHash } from 'node:crypto';

import { InvalidPluginPackagePromptExecutionPlanError } from './contracts';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function invalid(message: string): never {
  throw new InvalidPluginPackagePromptExecutionPlanError(message);
}

export function dataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: object,
  expected: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...expected, ...optional]);
  if (
    expected.some((key) => !actual.includes(key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('packageName is invalid');
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function positiveInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function nullableTemperature(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 2
  ) {
    return invalid('temperature is invalid');
  }
  return value;
}

export function hash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}
