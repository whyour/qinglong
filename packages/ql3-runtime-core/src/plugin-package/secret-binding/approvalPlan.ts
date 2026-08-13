import { createHash } from 'node:crypto';

import {
  createPluginPackageSecretBindingFromEntries,
  type PluginPackageSecretBinding,
} from './binding';
import {
  normalizePluginPackageSecretBindingPlan,
  type PluginPackageSecretBindingPlan,
} from './plan';
import type { ApprovedActionBinding } from '../../approved-action/approvedAction';
import type { SecuritySubject } from '../../security/security';

export const PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA =
  'qinglong/plugin-package-secret-binding-approval-plan@v1' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE =
  'plugin_package.secret_binding.bind' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_PERMISSION =
  'secret.manage' as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_LIFETIME_MS =
  15 * 60 * 1000;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_JSON_BYTES =
  96 * 1024;

export interface PluginPackageSecretBindingApprovalPlan {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA;
  readonly actionRef: string;
  readonly bindingPlan: Readonly<PluginPackageSecretBindingPlan>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly expiresAtMs: number;
  readonly approvalPlanDigest: string;
}

export interface CreatePluginPackageSecretBindingApprovalPlanInput {
  readonly actionRef: string;
  readonly bindingPlan: Readonly<PluginPackageSecretBindingPlan>;
  readonly requestedBy: SecuritySubject;
  readonly expiresAtMs: number;
}

export interface CreatePluginPackageSecretBindingApprovalPlanResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<PluginPackageSecretBindingApprovalPlan>;
}

export interface PluginPackageSecretBindingApprovalPlanRepository {
  create(
    plan: Readonly<PluginPackageSecretBindingApprovalPlan>,
  ): Promise<Readonly<CreatePluginPackageSecretBindingApprovalPlanResult>>;
  findByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageSecretBindingApprovalPlan> | null>;
}

export class InvalidPluginPackageSecretBindingApprovalPlanError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_INVALID';

  constructor(message: string) {
    super(`Plugin Package Secret binding approval plan is invalid: ${message}`);
    this.name = 'InvalidPluginPackageSecretBindingApprovalPlanError';
  }
}

export class PluginPackageSecretBindingApprovalPlanConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_CONFLICT';

  constructor(message: string) {
    super(
      `Plugin Package Secret binding approval plan conflicts with durable state: ${message}`,
    );
    this.name = 'PluginPackageSecretBindingApprovalPlanConflictError';
  }
}

export class PluginPackageSecretBindingApprovalPlanUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Plugin Package Secret binding approval plan is unavailable',
      options,
    );
    this.name = 'PluginPackageSecretBindingApprovalPlanUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const APPROVAL_PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-approval-plan-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageSecretBindingApprovalPlanError(message);
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

function requestedBy(value: SecuritySubject): Readonly<SecuritySubject> {
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
  value: Omit<PluginPackageSecretBindingApprovalPlan, 'approvalPlanDigest'>,
): object {
  return {
    schema: value.schema,
    actionRef: value.actionRef,
    bindingPlan: value.bindingPlan,
    requestedBy: value.requestedBy,
    expiresAtMs: value.expiresAtMs,
  };
}

export function pluginPackageSecretBindingApprovalPlanDigest(
  value: Omit<PluginPackageSecretBindingApprovalPlan, 'approvalPlanDigest'>,
): string {
  return createHash('sha256')
    .update(APPROVAL_PLAN_DIGEST_DOMAIN)
    .update(JSON.stringify(fields(value)), 'utf8')
    .digest('hex');
}

function normalizedWithoutDigest(
  value: Omit<PluginPackageSecretBindingApprovalPlan, 'approvalPlanDigest'>,
): Omit<PluginPackageSecretBindingApprovalPlan, 'approvalPlanDigest'> {
  if (value.schema !== PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA) {
    return invalid('schema is invalid');
  }
  record(value.bindingPlan, 'bindingPlan');
  const bindingPlan = normalizePluginPackageSecretBindingPlan(
    value.bindingPlan,
  );
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiresAtMs');
  if (
    expiresAtMs <= bindingPlan.plannedAtMs ||
    expiresAtMs - bindingPlan.plannedAtMs >
      MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_LIFETIME_MS
  ) {
    return invalid('lifetime is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA,
    actionRef: actionRef(value.actionRef),
    bindingPlan,
    requestedBy: requestedBy(value.requestedBy),
    expiresAtMs,
  });
}

function boundedPlan(
  value: Readonly<PluginPackageSecretBindingApprovalPlan>,
): Readonly<PluginPackageSecretBindingApprovalPlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_JSON_BYTES
  ) {
    return invalid('encoded plan exceeds the size limit');
  }
  return value;
}

export function createPluginPackageSecretBindingApprovalPlan(
  input: CreatePluginPackageSecretBindingApprovalPlanInput,
): Readonly<PluginPackageSecretBindingApprovalPlan> {
  const candidate = record(input, 'approval plan input');
  exactKeys(
    candidate,
    ['actionRef', 'bindingPlan', 'expiresAtMs', 'requestedBy'],
    'approval plan input',
  );
  const unsigned = normalizedWithoutDigest({
    schema: PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA,
    actionRef: input.actionRef,
    bindingPlan: input.bindingPlan,
    requestedBy: input.requestedBy,
    expiresAtMs: input.expiresAtMs,
  });
  return boundedPlan(
    Object.freeze({
      ...unsigned,
      approvalPlanDigest:
        pluginPackageSecretBindingApprovalPlanDigest(unsigned),
    }),
  );
}

export function normalizePluginPackageSecretBindingApprovalPlan(
  value: PluginPackageSecretBindingApprovalPlan,
): Readonly<PluginPackageSecretBindingApprovalPlan> {
  const candidate = record(value, 'approval plan');
  exactKeys(
    candidate,
    [
      'actionRef',
      'approvalPlanDigest',
      'bindingPlan',
      'expiresAtMs',
      'requestedBy',
      'schema',
    ],
    'approval plan',
  );
  const unsigned = normalizedWithoutDigest(value);
  const approvalPlanDigest =
    pluginPackageSecretBindingApprovalPlanDigest(unsigned);
  if (
    typeof value.approvalPlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.approvalPlanDigest) ||
    value.approvalPlanDigest !== approvalPlanDigest
  ) {
    return invalid('approvalPlanDigest does not match approval plan');
  }
  return boundedPlan(Object.freeze({ ...unsigned, approvalPlanDigest }));
}

export function pluginPackageSecretBindingApprovedAction(
  value: PluginPackageSecretBindingApprovalPlan,
): Readonly<ApprovedActionBinding> {
  const plan = normalizePluginPackageSecretBindingApprovalPlan(value);
  return Object.freeze({
    permission: PLUGIN_PACKAGE_SECRET_BINDING_PERMISSION,
    actionType: PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE,
    actionRef: plan.actionRef,
    actionDigest: plan.approvalPlanDigest,
    previewDigest: plan.bindingPlan.planDigest,
  });
}

export function createPluginPackageSecretBindingFromApprovalPlan(
  planValue: PluginPackageSecretBindingApprovalPlan,
  boundAtMsValue: number,
): Readonly<PluginPackageSecretBinding> {
  const plan = normalizePluginPackageSecretBindingApprovalPlan(planValue);
  const boundAtMs = timestamp(boundAtMsValue, 'boundAtMs');
  if (
    boundAtMs < plan.bindingPlan.plannedAtMs ||
    boundAtMs > plan.expiresAtMs
  ) {
    return invalid('boundAtMs is outside the approved lifetime');
  }
  return createPluginPackageSecretBindingFromEntries({
    target: plan.bindingPlan.target,
    entries: plan.bindingPlan.entries,
    authority: Object.freeze({
      kind: 'approved-action-execution',
      evidenceDigest: plan.approvalPlanDigest,
    }),
    boundAtMs,
  });
}
