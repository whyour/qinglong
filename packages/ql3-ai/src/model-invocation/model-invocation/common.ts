import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  MAX_MODEL_INVOCATION_RECORD_JSON_BYTES,
  MODEL_INVOCATION_MUTATION_PHASES,
  InvalidModelInvocationError,
  type ModelInvocationMutationPhase,
} from './contracts';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const START_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-start-digest@v1\0',
  'utf8',
);
export const START_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-start-command-digest@v1\0',
  'utf8',
);
export const COMPLETION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-completion-digest@v1\0',
  'utf8',
);
export const COMPLETION_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-completion-command-digest@v1\0',
  'utf8',
);
const MUTATION_IDENTITY_DOMAIN = Buffer.from(
  'qinglong/model-invocation-mutation-identity@v1\0',
  'utf8',
);

export function invalid(message: string): never {
  throw new InvalidModelInvocationError(message);
}

export function dataRecord(value: unknown, label: string): Record<string, unknown> {
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

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function requestDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return invalid('request digest is invalid');
  }
  return value;
}

export function createModelInvocationMutationIdentity(
  invocationIdValue: string,
  phaseValue: ModelInvocationMutationPhase,
): Readonly<{
  mutationId: string;
  eventId: string;
  dedupeKey: string;
}> {
  const invocationId = identifier(invocationIdValue, 'invocation id');
  if (!MODEL_INVOCATION_MUTATION_PHASES.includes(phaseValue)) {
    invalid('mutation phase is invalid');
  }
  const identityDigest = createHash('sha256')
    .update(MUTATION_IDENTITY_DOMAIN)
    .update(phaseValue, 'utf8')
    .update('\0', 'utf8')
    .update(invocationId, 'utf8')
    .digest('hex');
  const eventHex =
    identityDigest.slice(0, 12) +
    '8' +
    identityDigest.slice(13, 16) +
    '8' +
    identityDigest.slice(17, 32);
  return Object.freeze({
    mutationId: `ql3mi.${phaseValue}.mutation.${identityDigest}`,
    eventId: `${eventHex.slice(0, 8)}-${eventHex.slice(8, 12)}-${eventHex.slice(
      12,
      16,
    )}-${eventHex.slice(16, 20)}-${eventHex.slice(20, 32)}`,
    dedupeKey: `ql3mi.${phaseValue}.dedupe.${identityDigest}`,
  });
}

export function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function assertJsonBudget(value: unknown, label: string): void {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_MODEL_INVOCATION_RECORD_JSON_BYTES
  ) {
    invalid(`${label} exceeds its JSON budget`);
  }
}
