import { createHash } from 'node:crypto';

import {
  normalizePluginPackageLifecycleImpact,
  type PluginPackageLifecycleImpact,
} from './pluginPackageLifecycle';
import type { SecuritySubject } from '../../security/security';

export const PLUGIN_PACKAGE_LIFECYCLE_PLAN_SCHEMA =
  'qinglong/plugin-package-lifecycle-plan@v1' as const;
export const MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_LIFETIME_MS = 15 * 60 * 1000;
export const MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_BYTES = 96 * 1024;

export interface PluginPackageLifecyclePlan {
  readonly schema: typeof PLUGIN_PACKAGE_LIFECYCLE_PLAN_SCHEMA;
  readonly actionRef: string;
  readonly impact: Readonly<PluginPackageLifecycleImpact>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
  readonly planDigest: string;
}

export interface CreatePluginPackageLifecyclePlanInput {
  readonly actionRef: string;
  readonly impact: PluginPackageLifecycleImpact;
  readonly requestedBy: SecuritySubject;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
}

export interface CreatePluginPackageLifecyclePlanResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<PluginPackageLifecyclePlan>;
}

export interface PluginPackageLifecyclePlanRepository {
  create(
    plan: Readonly<PluginPackageLifecyclePlan>,
  ): Promise<Readonly<CreatePluginPackageLifecyclePlanResult>>;
  findByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageLifecyclePlan> | null>;
}

export class InvalidPluginPackageLifecyclePlanError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_PLAN_INVALID';

  constructor(message: string) {
    super(`Plugin Package lifecycle plan is invalid: ${message}`);
    this.name = 'InvalidPluginPackageLifecyclePlanError';
  }
}

export class PluginPackageLifecyclePlanConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_PLAN_CONFLICT';

  constructor(message: string) {
    super(
      `Plugin Package lifecycle plan conflicts with durable state: ${message}`,
    );
    this.name = 'PluginPackageLifecyclePlanConflictError';
  }
}

export class PluginPackageLifecyclePlanUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package lifecycle plan is unavailable', options);
    this.name = 'PluginPackageLifecyclePlanUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-plan-digest@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackageLifecyclePlanError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
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

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.length !== canonical.length ||
    keys
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    return invalid('actionRef is invalid');
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function userSubject(value: SecuritySubject): Readonly<SecuritySubject> {
  const candidate = record(value, 'requestedBy');
  exactKeys(candidate, ['id', 'type'], 'requestedBy');
  if (
    value.type !== 'user' ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    Buffer.byteLength(value.id, 'utf8') > 255 ||
    SUBJECT_CONTROL_PATTERN.test(value.id)
  ) {
    return invalid('requestedBy must be a User subject');
  }
  return Object.freeze({ type: 'user', id: value.id });
}

function fields(
  value: Omit<PluginPackageLifecyclePlan, 'planDigest'>,
): object {
  return {
    schema: value.schema,
    actionRef: value.actionRef,
    impact: value.impact,
    requestedBy: value.requestedBy,
    plannedAtMs: value.plannedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
}

export function pluginPackageLifecyclePlanDigest(
  value: Omit<PluginPackageLifecyclePlan, 'planDigest'>,
): string {
  return createHash('sha256')
    .update(PLAN_DIGEST_DOMAIN)
    .update(JSON.stringify(fields(value)))
    .digest('hex');
}

function normalizedWithoutDigest(
  value: Omit<PluginPackageLifecyclePlan, 'planDigest'>,
): Omit<PluginPackageLifecyclePlan, 'planDigest'> {
  if (value.schema !== PLUGIN_PACKAGE_LIFECYCLE_PLAN_SCHEMA) {
    return invalid('schema is invalid');
  }
  const plannedAtMs = timestamp(value.plannedAtMs, 'plannedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiresAtMs');
  if (
    expiresAtMs <= plannedAtMs ||
    expiresAtMs - plannedAtMs >
      MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_LIFETIME_MS
  ) {
    return invalid('lifetime is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_LIFECYCLE_PLAN_SCHEMA,
    actionRef: actionRef(value.actionRef),
    impact: normalizePluginPackageLifecycleImpact(value.impact),
    requestedBy: userSubject(value.requestedBy),
    plannedAtMs,
    expiresAtMs,
  });
}

function boundedPlan(
  value: Readonly<PluginPackageLifecyclePlan>,
): Readonly<PluginPackageLifecyclePlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_BYTES
  ) {
    return invalid('encoded plan exceeds the size limit');
  }
  return value;
}

export function createPluginPackageLifecyclePlan(
  input: CreatePluginPackageLifecyclePlanInput,
): Readonly<PluginPackageLifecyclePlan> {
  const value = record(input, 'lifecycle plan input');
  exactKeys(
    value,
    ['actionRef', 'expiresAtMs', 'impact', 'plannedAtMs', 'requestedBy'],
    'lifecycle plan input',
  );
  const unsigned = normalizedWithoutDigest({
    schema: PLUGIN_PACKAGE_LIFECYCLE_PLAN_SCHEMA,
    actionRef: input.actionRef,
    impact: input.impact,
    requestedBy: input.requestedBy,
    plannedAtMs: input.plannedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
  return boundedPlan(
    Object.freeze({
      ...unsigned,
      planDigest: pluginPackageLifecyclePlanDigest(unsigned),
    }),
  );
}

export function normalizePluginPackageLifecyclePlan(
  value: PluginPackageLifecyclePlan,
): Readonly<PluginPackageLifecyclePlan> {
  const candidate = record(value, 'lifecycle plan');
  exactKeys(
    candidate,
    [
      'actionRef',
      'expiresAtMs',
      'impact',
      'planDigest',
      'plannedAtMs',
      'requestedBy',
      'schema',
    ],
    'lifecycle plan',
  );
  const unsigned = normalizedWithoutDigest(value);
  const planDigest = pluginPackageLifecyclePlanDigest(unsigned);
  if (
    typeof value.planDigest !== 'string' ||
    !PLAN_DIGEST_PATTERN.test(value.planDigest) ||
    value.planDigest !== planDigest
  ) {
    return invalid('planDigest does not match lifecycle plan');
  }
  return boundedPlan(Object.freeze({ ...unsigned, planDigest }));
}
