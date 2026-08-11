import { createHash } from 'node:crypto';

import {
  normalizeWorkerCredentialId,
  normalizeWorkerCredentialMutationId,
} from './workerCredential';
import type { SecuritySubject } from '../security/security';

export const WORKER_CREDENTIAL_MANAGEMENT_PLAN_SCHEMA =
  'qinglong/worker-credential-management-plan@v1' as const;
export const WORKER_CREDENTIAL_MANAGEMENT_ACTIONS = [
  'issue',
  'rotate',
] as const;
export const MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS =
  15 * 60 * 1000;
export const MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_BYTES = 16 * 1024;

export type WorkerCredentialManagementAction =
  (typeof WORKER_CREDENTIAL_MANAGEMENT_ACTIONS)[number];

export interface WorkerCredentialManagementTarget {
  readonly deliveryId: string;
  readonly workerId: string;
  readonly credentialId: string;
  readonly previousCredentialId: string | null;
  readonly credentialNotBeforeAtMs: number;
  readonly credentialExpiresAtMs: number;
  readonly deploymentTargetDigest: string;
  readonly deploymentGeneration: string;
}

export interface WorkerCredentialManagementPlan {
  readonly schema: typeof WORKER_CREDENTIAL_MANAGEMENT_PLAN_SCHEMA;
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly action: WorkerCredentialManagementAction;
  readonly target: Readonly<WorkerCredentialManagementTarget>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
  readonly planDigest: string;
  readonly previewDigest: string;
}

export interface CreateWorkerCredentialManagementPlanInput {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly action: WorkerCredentialManagementAction;
  readonly target: WorkerCredentialManagementTarget;
  readonly requestedBy: SecuritySubject;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
}

export interface CreateWorkerCredentialManagementPlanResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<WorkerCredentialManagementPlan>;
}

export interface WorkerCredentialManagementPlanRepository {
  create(
    plan: Readonly<WorkerCredentialManagementPlan>,
  ): Promise<Readonly<CreateWorkerCredentialManagementPlanResult>>;
  findByActionRef(
    actionRef: string,
  ): Promise<Readonly<WorkerCredentialManagementPlan> | null>;
}

export class InvalidWorkerCredentialManagementPlanError extends TypeError {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_PLAN_INVALID';

  constructor(message: string) {
    super(`Worker credential management plan is invalid: ${message}`);
    this.name = 'InvalidWorkerCredentialManagementPlanError';
  }
}

export class WorkerCredentialManagementPlanConflictError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_PLAN_CONFLICT';

  constructor(message: string) {
    super(
      `Worker credential management plan conflicts with durable state: ${message}`,
    );
    this.name = 'WorkerCredentialManagementPlanConflictError';
  }
}

export class WorkerCredentialManagementPlanUnavailableError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Worker credential management plan is unavailable', options);
    this.name = 'WorkerCredentialManagementPlanUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_DIGEST_DOMAIN =
  'qinglong/worker-credential-management-plan-digest@v1\0';
const PREVIEW_DIGEST_DOMAIN =
  'qinglong/worker-credential-management-preview-digest@v1\0';
const MAX_CREDENTIAL_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function invalid(message: string): never {
  throw new InvalidWorkerCredentialManagementPlanError(message);
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

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function identifier(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function credentialId(value: unknown, label: string): string {
  try {
    return normalizeWorkerCredentialId(value as string);
  } catch {
    return invalid(`${label} is invalid`);
  }
}

function deliveryId(value: unknown): string {
  try {
    return normalizeWorkerCredentialMutationId(value as string);
  } catch {
    return invalid('deliveryId is invalid');
  }
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

function target(
  value: WorkerCredentialManagementTarget,
  action: WorkerCredentialManagementAction,
  plannedAtMs: number,
): Readonly<WorkerCredentialManagementTarget> {
  const candidate = record(value, 'target');
  exactKeys(
    candidate,
    [
      'credentialExpiresAtMs',
      'credentialId',
      'credentialNotBeforeAtMs',
      'deliveryId',
      'deploymentGeneration',
      'deploymentTargetDigest',
      'previousCredentialId',
      'workerId',
    ],
    'target',
  );
  const normalizedCredentialId = credentialId(
    value.credentialId,
    'credentialId',
  );
  const previousCredentialId =
    value.previousCredentialId === null
      ? null
      : credentialId(value.previousCredentialId, 'previousCredentialId');
  const credentialNotBeforeAtMs = timestamp(
    value.credentialNotBeforeAtMs,
    'credentialNotBeforeAtMs',
  );
  const credentialExpiresAtMs = timestamp(
    value.credentialExpiresAtMs,
    'credentialExpiresAtMs',
  );
  if (
    (action === 'issue' && previousCredentialId !== null) ||
    (action === 'rotate' && previousCredentialId === null) ||
    previousCredentialId === normalizedCredentialId
  ) {
    return invalid('action and previousCredentialId do not agree');
  }
  if (
    credentialNotBeforeAtMs < plannedAtMs ||
    credentialExpiresAtMs <= credentialNotBeforeAtMs ||
    credentialExpiresAtMs - credentialNotBeforeAtMs >
      MAX_CREDENTIAL_LIFETIME_MS
  ) {
    return invalid('credential lifetime is invalid');
  }
  if (
    typeof value.deploymentTargetDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.deploymentTargetDigest)
  ) {
    return invalid('deploymentTargetDigest is invalid');
  }
  return Object.freeze({
    deliveryId: deliveryId(value.deliveryId),
    workerId: identifier(value.workerId, WORKER_ID_PATTERN, 'workerId'),
    credentialId: normalizedCredentialId,
    previousCredentialId,
    credentialNotBeforeAtMs,
    credentialExpiresAtMs,
    deploymentTargetDigest: value.deploymentTargetDigest,
    deploymentGeneration: identifier(
      value.deploymentGeneration,
      GENERATION_PATTERN,
      'deploymentGeneration',
    ),
  });
}

type UnsignedPlan = Omit<
  WorkerCredentialManagementPlan,
  'planDigest' | 'previewDigest'
>;

function planFields(value: UnsignedPlan): object {
  return {
    schema: value.schema,
    actionRef: value.actionRef,
    authorityProjectId: value.authorityProjectId,
    action: value.action,
    target: value.target,
    requestedBy: value.requestedBy,
    plannedAtMs: value.plannedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
}

function previewFields(value: UnsignedPlan): object {
  return {
    schema: value.schema,
    authorityProjectId: value.authorityProjectId,
    action: value.action,
    target: value.target,
  };
}

function digest(domain: string, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function workerCredentialManagementPlanDigest(
  value: UnsignedPlan,
): string {
  return digest(PLAN_DIGEST_DOMAIN, planFields(value));
}

export function workerCredentialManagementPreviewDigest(
  value: UnsignedPlan,
): string {
  return digest(PREVIEW_DIGEST_DOMAIN, previewFields(value));
}

function normalizeUnsigned(value: UnsignedPlan): UnsignedPlan {
  if (value.schema !== WORKER_CREDENTIAL_MANAGEMENT_PLAN_SCHEMA) {
    return invalid('schema is invalid');
  }
  if (!WORKER_CREDENTIAL_MANAGEMENT_ACTIONS.includes(value.action)) {
    return invalid('action is invalid');
  }
  const plannedAtMs = timestamp(value.plannedAtMs, 'plannedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiresAtMs');
  if (
    expiresAtMs <= plannedAtMs ||
    expiresAtMs - plannedAtMs >
      MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS
  ) {
    return invalid('plan lifetime is invalid');
  }
  return Object.freeze({
    schema: WORKER_CREDENTIAL_MANAGEMENT_PLAN_SCHEMA,
    actionRef: identifier(value.actionRef, ACTION_REF_PATTERN, 'actionRef'),
    authorityProjectId: identifier(
      value.authorityProjectId,
      PROJECT_ID_PATTERN,
      'authorityProjectId',
    ),
    action: value.action,
    target: target(value.target, value.action, plannedAtMs),
    requestedBy: userSubject(value.requestedBy),
    plannedAtMs,
    expiresAtMs,
  });
}

function boundedPlan(
  value: Readonly<WorkerCredentialManagementPlan>,
): Readonly<WorkerCredentialManagementPlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_BYTES
  ) {
    return invalid('encoded plan exceeds the size limit');
  }
  return value;
}

export function createWorkerCredentialManagementPlan(
  input: CreateWorkerCredentialManagementPlanInput,
): Readonly<WorkerCredentialManagementPlan> {
  const value = record(input, 'plan input');
  exactKeys(
    value,
    [
      'action',
      'actionRef',
      'authorityProjectId',
      'expiresAtMs',
      'plannedAtMs',
      'requestedBy',
      'target',
    ],
    'plan input',
  );
  const unsigned = normalizeUnsigned({
    schema: WORKER_CREDENTIAL_MANAGEMENT_PLAN_SCHEMA,
    actionRef: input.actionRef,
    authorityProjectId: input.authorityProjectId,
    action: input.action,
    target: input.target,
    requestedBy: input.requestedBy,
    plannedAtMs: input.plannedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
  return boundedPlan(Object.freeze({
    ...unsigned,
    planDigest: workerCredentialManagementPlanDigest(unsigned),
    previewDigest: workerCredentialManagementPreviewDigest(unsigned),
  }));
}

export function normalizeWorkerCredentialManagementPlan(
  value: WorkerCredentialManagementPlan,
): Readonly<WorkerCredentialManagementPlan> {
  const candidate = record(value, 'plan');
  exactKeys(
    candidate,
    [
      'action',
      'actionRef',
      'authorityProjectId',
      'expiresAtMs',
      'planDigest',
      'plannedAtMs',
      'previewDigest',
      'requestedBy',
      'schema',
      'target',
    ],
    'plan',
  );
  const unsigned = normalizeUnsigned({
    schema: value.schema,
    actionRef: value.actionRef,
    authorityProjectId: value.authorityProjectId,
    action: value.action,
    target: value.target,
    requestedBy: value.requestedBy,
    plannedAtMs: value.plannedAtMs,
    expiresAtMs: value.expiresAtMs,
  });
  if (
    typeof value.planDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.planDigest) ||
    value.planDigest !== workerCredentialManagementPlanDigest(unsigned) ||
    typeof value.previewDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.previewDigest) ||
    value.previewDigest !== workerCredentialManagementPreviewDigest(unsigned)
  ) {
    return invalid('digest is invalid');
  }
  return boundedPlan(Object.freeze({
    ...unsigned,
    planDigest: value.planDigest,
    previewDigest: value.previewDigest,
  }));
}
