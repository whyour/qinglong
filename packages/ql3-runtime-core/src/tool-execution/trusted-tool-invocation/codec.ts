import { createHash } from 'node:crypto';

import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../../security/security';
import { semver } from '../../versioning/pinnedSemver';
import {
  InvalidTrustedToolInvocationError,
  MAX_TRUSTED_TOOL_HANDLER_AUTHORITIES,
  TRUSTED_TOOL_DEPLOYMENT_PROFILES,
  TRUSTED_TOOL_HANDLER_AUTHORITIES,
  type TrustedToolContractIdentity,
  type TrustedToolHandlerAuthority,
} from './contracts';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTRACT_ID_PATTERN =
  /^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){1,7}$/;
export const WARNING_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_ORDER = new Map(
  TRUSTED_TOOL_DEPLOYMENT_PROFILES.map((profile, index) => [profile, index]),
);
export const BINDING_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-handler-binding-digest@v1\0',
  'utf8',
);
export const ACTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-invocation-action-digest@v1\0',
  'utf8',
);
export const PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-invocation-plan-digest@v1\0',
  'utf8',
);
export const ADMISSION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-admission-digest@v1\0',
  'utf8',
);
const CONTRACT_IDENTITY_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-contract-identity-digest@v1\0',
  'utf8',
);

export function invalid(message: string): never {
  throw new InvalidTrustedToolInvocationError(message);
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
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
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

export function boundedText(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function sameFence(
  left: Readonly<SecurityPolicyFence>,
  right: Readonly<SecurityPolicyFence>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

export function normalizeFence(
  value: SecurityPolicyFence,
): Readonly<SecurityPolicyFence> {
  const record = dataRecord(value, 'policy fence');
  exactKeys(record, ['bindingVersion', 'projectVersion'], [], 'policy fence');
  if (
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    (value.bindingVersion !== null &&
      (!Number.isSafeInteger(value.bindingVersion) || value.bindingVersion < 1))
  ) {
    return invalid('policy fence is invalid');
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function normalizeToolIdentity(
  value: Readonly<{ name: string; version: string }>,
  label: string,
): Readonly<{ name: string; version: string }> {
  const record = dataRecord(value, label);
  exactKeys(record, ['name', 'version'], [], label);
  const name = boundedText(value.name, 255, `${label} name`);
  const version = boundedText(value.version, 128, `${label} version`);
  if (!CONTRACT_ID_PATTERN.test(name) || semver().valid(version) !== version) {
    return invalid(`${label} is invalid`);
  }
  return Object.freeze({ name, version });
}

export function normalizeContractIdentity(
  value: TrustedToolContractIdentity,
  label: string,
): Readonly<TrustedToolContractIdentity> {
  const record = dataRecord(value, label);
  exactKeys(record, ['id', 'version'], [], label);
  const id = boundedText(value.id, 255, `${label} id`);
  const version = boundedText(value.version, 128, `${label} version`);
  if (!CONTRACT_ID_PATTERN.test(id) || semver().valid(version) !== version) {
    return invalid(`${label} is invalid`);
  }
  return Object.freeze({ id, version });
}

export function trustedToolContractIdentityDigest(
  value: TrustedToolContractIdentity,
): string {
  return hash(
    CONTRACT_IDENTITY_DIGEST_DOMAIN,
    normalizeContractIdentity(value, 'Tool contract identity'),
  );
}

export function normalizeProfile(value: unknown): DeploymentProfile {
  if (
    typeof value !== 'string' ||
    !TRUSTED_TOOL_DEPLOYMENT_PROFILES.includes(value as DeploymentProfile)
  ) {
    return invalid('deployment profile is invalid');
  }
  return value as DeploymentProfile;
}

export function normalizeProfiles(
  value: readonly DeploymentProfile[],
): readonly DeploymentProfile[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > TRUSTED_TOOL_DEPLOYMENT_PROFILES.length
  ) {
    return invalid('handler profiles are invalid');
  }
  const profiles = value.map(normalizeProfile);
  if (new Set(profiles).size !== profiles.length) {
    return invalid('handler profiles are duplicated');
  }
  return Object.freeze(
    profiles.sort(
      (left, right) =>
        (PROFILE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (PROFILE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

export function normalizeAuthorities(
  value: readonly TrustedToolHandlerAuthority[],
): readonly TrustedToolHandlerAuthority[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_TRUSTED_TOOL_HANDLER_AUTHORITIES
  ) {
    return invalid('handler authorities are invalid');
  }
  const authorities = value.map((authority) => {
    if (
      typeof authority !== 'string' ||
      !TRUSTED_TOOL_HANDLER_AUTHORITIES.includes(
        authority as TrustedToolHandlerAuthority,
      )
    ) {
      return invalid('handler authority is invalid');
    }
    return authority as TrustedToolHandlerAuthority;
  });
  if (new Set(authorities).size !== authorities.length) {
    return invalid('handler authorities are duplicated');
  }
  return Object.freeze(authorities.sort());
}
