import { createHash } from 'node:crypto';

import type { ApprovedActionBinding } from '../../approved-action/approvedAction';
import type { SecuritySubject } from '../../security/security';
import {
  normalizePluginPackageSecretBindingTransitionPlan,
  type PluginPackageSecretBindingTransitionPlan,
} from './transitionPlan';

export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_SCHEMA =
  'qinglong/plugin-package-secret-binding-transition-approval-plan@v1' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE =
  'plugin_package.secret_binding.transition' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PERMISSION =
  'secret.manage' as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_LIFETIME_MS =
  15 * 60 * 1000;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_JSON_BYTES =
  224 * 1024;

export interface PluginPackageSecretBindingTransitionApprovalPlan {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_SCHEMA;
  readonly actionRef: string;
  readonly transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
  readonly approvalPlanDigest: string;
}

export interface CreatePluginPackageSecretBindingTransitionApprovalPlanInput {
  readonly actionRef: string;
  readonly transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>;
  readonly requestedBy: SecuritySubject;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
}

export interface CreatePluginPackageSecretBindingTransitionApprovalPlanResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>;
}

export interface PluginPackageSecretBindingTransitionApprovalPlanRepository {
  create(
    plan: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>,
  ): Promise<
    Readonly<CreatePluginPackageSecretBindingTransitionApprovalPlanResult>
  >;
  findByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionApprovalPlan> | null>;
}

export class InvalidPluginPackageSecretBindingTransitionApprovalPlanError extends TypeError {
  readonly code =
    'PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package Secret binding transition approval plan is invalid: ${message}`,
    );
    this.name =
      'InvalidPluginPackageSecretBindingTransitionApprovalPlanError';
  }
}

export class PluginPackageSecretBindingTransitionApprovalPlanConflictError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_CONFLICT';

  constructor(message: string) {
    super(
      `Plugin Package Secret binding transition approval plan conflicts with durable state: ${message}`,
    );
    this.name =
      'PluginPackageSecretBindingTransitionApprovalPlanConflictError';
  }
}

export class PluginPackageSecretBindingTransitionApprovalPlanUnavailableError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Plugin Package Secret binding transition approval plan is unavailable',
      options,
    );
    this.name =
      'PluginPackageSecretBindingTransitionApprovalPlanUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const APPROVAL_PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-transition-approval-plan-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageSecretBindingTransitionApprovalPlanError(
    message,
  );
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

function unsigned(
  value: Omit<
    PluginPackageSecretBindingTransitionApprovalPlan,
    'approvalPlanDigest'
  >,
): Omit<
  PluginPackageSecretBindingTransitionApprovalPlan,
  'approvalPlanDigest'
> {
  if (
    value.schema !==
    PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_SCHEMA
  ) {
    return invalid('schema is invalid');
  }
  const transitionPlan =
    normalizePluginPackageSecretBindingTransitionPlan(value.transitionPlan);
  const plannedAtMs = timestamp(value.plannedAtMs, 'plannedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiresAtMs');
  if (
    expiresAtMs <= plannedAtMs ||
    expiresAtMs - plannedAtMs >
      MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_LIFETIME_MS ||
    (transitionPlan.nextBindingPlan !== null &&
      transitionPlan.nextBindingPlan.plannedAtMs !== plannedAtMs)
  ) {
    return invalid('lifetime is invalid');
  }
  return Object.freeze({
    schema:
      PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_SCHEMA,
    actionRef: actionRef(value.actionRef),
    transitionPlan,
    requestedBy: requestedBy(value.requestedBy),
    plannedAtMs,
    expiresAtMs,
  });
}

function approvalPlanDigest(
  value: Omit<
    PluginPackageSecretBindingTransitionApprovalPlan,
    'approvalPlanDigest'
  >,
): string {
  return createHash('sha256')
    .update(APPROVAL_PLAN_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function bounded(
  value: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>,
): Readonly<PluginPackageSecretBindingTransitionApprovalPlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_JSON_BYTES
  ) {
    return invalid('encoded plan exceeds the size limit');
  }
  return value;
}

export function createPluginPackageSecretBindingTransitionApprovalPlan(
  input: CreatePluginPackageSecretBindingTransitionApprovalPlanInput,
): Readonly<PluginPackageSecretBindingTransitionApprovalPlan> {
  const candidate = record(input, 'approval plan input');
  exactKeys(
    candidate,
    [
      'actionRef',
      'expiresAtMs',
      'plannedAtMs',
      'requestedBy',
      'transitionPlan',
    ],
    'approval plan input',
  );
  const normalized = unsigned({
    schema:
      PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_SCHEMA,
    actionRef: input.actionRef,
    transitionPlan: input.transitionPlan,
    requestedBy: input.requestedBy,
    plannedAtMs: input.plannedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
  return bounded(
    Object.freeze({
      ...normalized,
      approvalPlanDigest: approvalPlanDigest(normalized),
    }),
  );
}

export function normalizePluginPackageSecretBindingTransitionApprovalPlan(
  value: PluginPackageSecretBindingTransitionApprovalPlan,
): Readonly<PluginPackageSecretBindingTransitionApprovalPlan> {
  const candidate = record(value, 'approval plan');
  exactKeys(
    candidate,
    [
      'actionRef',
      'approvalPlanDigest',
      'expiresAtMs',
      'plannedAtMs',
      'requestedBy',
      'schema',
      'transitionPlan',
    ],
    'approval plan',
  );
  const normalized = unsigned(value);
  const digest = approvalPlanDigest(normalized);
  if (
    typeof value.approvalPlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.approvalPlanDigest) ||
    value.approvalPlanDigest !== digest
  ) {
    return invalid('approvalPlanDigest does not match approval plan');
  }
  return bounded(Object.freeze({ ...normalized, approvalPlanDigest: digest }));
}

export function pluginPackageSecretBindingTransitionApprovedAction(
  value: PluginPackageSecretBindingTransitionApprovalPlan,
): Readonly<ApprovedActionBinding> {
  const plan = normalizePluginPackageSecretBindingTransitionApprovalPlan(value);
  return Object.freeze({
    permission: PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PERMISSION,
    actionType: PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE,
    actionRef: plan.actionRef,
    actionDigest: plan.approvalPlanDigest,
    previewDigest: plan.transitionPlan.transitionDigest,
  });
}
