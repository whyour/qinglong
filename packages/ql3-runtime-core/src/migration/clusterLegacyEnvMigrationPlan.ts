import { createHash } from 'node:crypto';

import { parseSecretRef } from '../secret/secretReference';

export const CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA =
  'qinglong/cluster-legacy-env-migration-plan@v1' as const;
export const MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS = 100_000;
export const MAX_CLUSTER_LEGACY_ENV_TASKS = 100_000;
export const MAX_CLUSTER_LEGACY_ENV_TRIGGERS = 500_000;
export const MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BYTES = 64 * 1024;
export const MAX_CLUSTER_LEGACY_ENV_MIGRATION_PLAN_JSON_BYTES = 8 * 1024;

export interface ClusterLegacyEnvMigrationSourceEvidence {
  readonly reconciliationBundleDigest: string;
  readonly decisionDigest: string;
  readonly candidateSetDigest: string;
  readonly sourceRowCount: number;
  readonly activeRowCount: number;
  readonly disabledRowCount: number;
  readonly effectiveBindingCount: number;
}

export interface ClusterLegacyEnvMigrationTarget {
  readonly secretRef: string;
  readonly taskRevisionSetDigest: string;
  readonly triggerRevisionSetDigest: string;
  readonly taskCount: number;
  readonly triggerCount: number;
  readonly totalEffectiveBytes: number;
}

export interface ClusterLegacyEnvMigrationPlanIntent {
  readonly planId: string;
  readonly mutationId: string;
  readonly projectId: string;
  readonly source: Readonly<ClusterLegacyEnvMigrationSourceEvidence>;
  readonly target: Readonly<ClusterLegacyEnvMigrationTarget>;
}

export interface ClusterLegacyEnvMigrationPlan
  extends ClusterLegacyEnvMigrationPlanIntent {
  readonly schema: typeof CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA;
  readonly plannedAtMs: number;
  readonly planDigest: string;
}

export interface ClusterLegacyEnvMigrationPlanRepository {
  publish(intent: Readonly<ClusterLegacyEnvMigrationPlanIntent>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      plan: Readonly<ClusterLegacyEnvMigrationPlan>;
    }>
  >;
  findByPlanId(
    planId: string,
  ): Promise<Readonly<ClusterLegacyEnvMigrationPlan> | null>;
}

export class InvalidClusterLegacyEnvMigrationPlanError extends TypeError {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_PLAN_INVALID';

  constructor(message: string) {
    super(`Cluster Legacy Env migration plan is invalid: ${message}`);
    this.name = 'InvalidClusterLegacyEnvMigrationPlanError';
  }
}

export class ClusterLegacyEnvMigrationPlanConflictError extends Error {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_PLAN_CONFLICT';

  constructor() {
    super('Cluster Legacy Env migration plan conflicts with durable state');
    this.name = 'ClusterLegacyEnvMigrationPlanConflictError';
  }
}

export class ClusterLegacyEnvMigrationPlanUnavailableError extends Error {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Cluster Legacy Env migration plan is unavailable', options);
    this.name = 'ClusterLegacyEnvMigrationPlanUnavailableError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-migration-plan-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidClusterLegacyEnvMigrationPlanError(message);
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

export function assertClusterLegacyEnvMigrationPlanIdentifier(
  value: unknown,
  label: 'mutationId' | 'planId' | 'projectId',
): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function count(value: unknown, label: string, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('plannedAtMs is invalid');
  }
  return value as number;
}

function sourceEvidence(
  value: ClusterLegacyEnvMigrationSourceEvidence,
): Readonly<ClusterLegacyEnvMigrationSourceEvidence> {
  const candidate = record(value, 'source');
  exactKeys(
    candidate,
    [
      'activeRowCount',
      'candidateSetDigest',
      'decisionDigest',
      'disabledRowCount',
      'effectiveBindingCount',
      'reconciliationBundleDigest',
      'sourceRowCount',
    ],
    'source',
  );
  const sourceRowCount = count(
    value.sourceRowCount,
    'sourceRowCount',
    MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS,
  );
  const activeRowCount = count(
    value.activeRowCount,
    'activeRowCount',
    MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS,
  );
  const disabledRowCount = count(
    value.disabledRowCount,
    'disabledRowCount',
    MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS,
  );
  const effectiveBindingCount = count(
    value.effectiveBindingCount,
    'effectiveBindingCount',
    MAX_CLUSTER_LEGACY_ENV_SOURCE_ROWS,
  );
  if (
    sourceRowCount < 1 ||
    sourceRowCount !== activeRowCount + disabledRowCount ||
    activeRowCount < 1 ||
    effectiveBindingCount < 1 ||
    effectiveBindingCount > activeRowCount
  ) {
    return invalid('source row counts are inconsistent');
  }
  return Object.freeze({
    reconciliationBundleDigest: digest(
      value.reconciliationBundleDigest,
      'reconciliationBundleDigest',
    ),
    decisionDigest: digest(value.decisionDigest, 'decisionDigest'),
    candidateSetDigest: digest(value.candidateSetDigest, 'candidateSetDigest'),
    sourceRowCount,
    activeRowCount,
    disabledRowCount,
    effectiveBindingCount,
  });
}

function target(
  value: ClusterLegacyEnvMigrationTarget,
  projectId: string,
): Readonly<ClusterLegacyEnvMigrationTarget> {
  const candidate = record(value, 'target');
  exactKeys(
    candidate,
    [
      'secretRef',
      'taskCount',
      'taskRevisionSetDigest',
      'totalEffectiveBytes',
      'triggerCount',
      'triggerRevisionSetDigest',
    ],
    'target',
  );
  let parsedSecretRef;
  try {
    parsedSecretRef = parseSecretRef(value.secretRef);
  } catch {
    return invalid('secretRef is invalid');
  }
  if (
    parsedSecretRef.projectId !== projectId ||
    parsedSecretRef.version === undefined
  ) {
    return invalid('secretRef must pin a version in the same Project');
  }
  const taskCount = count(
    value.taskCount,
    'taskCount',
    MAX_CLUSTER_LEGACY_ENV_TASKS,
  );
  if (taskCount < 1) return invalid('taskCount is invalid');
  const triggerCount = count(
    value.triggerCount,
    'triggerCount',
    MAX_CLUSTER_LEGACY_ENV_TRIGGERS,
  );
  const totalEffectiveBytes = count(
    value.totalEffectiveBytes,
    'totalEffectiveBytes',
    MAX_CLUSTER_LEGACY_ENV_EFFECTIVE_BYTES,
  );
  if (totalEffectiveBytes < 1) {
    return invalid('totalEffectiveBytes is invalid');
  }
  return Object.freeze({
    secretRef: value.secretRef,
    taskRevisionSetDigest: digest(
      value.taskRevisionSetDigest,
      'taskRevisionSetDigest',
    ),
    triggerRevisionSetDigest: digest(
      value.triggerRevisionSetDigest,
      'triggerRevisionSetDigest',
    ),
    taskCount,
    triggerCount,
    totalEffectiveBytes,
  });
}

export function normalizeClusterLegacyEnvMigrationPlanIntent(
  value: ClusterLegacyEnvMigrationPlanIntent,
): Readonly<ClusterLegacyEnvMigrationPlanIntent> {
  const candidate = record(value, 'plan intent');
  exactKeys(
    candidate,
    ['mutationId', 'planId', 'projectId', 'source', 'target'],
    'plan intent',
  );
  const projectId = assertClusterLegacyEnvMigrationPlanIdentifier(
    value.projectId,
    'projectId',
  );
  return Object.freeze({
    planId: assertClusterLegacyEnvMigrationPlanIdentifier(
      value.planId,
      'planId',
    ),
    mutationId: assertClusterLegacyEnvMigrationPlanIdentifier(
      value.mutationId,
      'mutationId',
    ),
    projectId,
    source: sourceEvidence(value.source),
    target: target(value.target, projectId),
  });
}

function unsignedFields(
  value: Omit<ClusterLegacyEnvMigrationPlan, 'planDigest'>,
): object {
  return {
    schema: value.schema,
    planId: value.planId,
    mutationId: value.mutationId,
    projectId: value.projectId,
    source: value.source,
    target: value.target,
    plannedAtMs: value.plannedAtMs,
  };
}

export function clusterLegacyEnvMigrationPlanDigest(
  value: Omit<ClusterLegacyEnvMigrationPlan, 'planDigest'>,
): string {
  return createHash('sha256')
    .update(PLAN_DIGEST_DOMAIN)
    .update(JSON.stringify(unsignedFields(value)), 'utf8')
    .digest('hex');
}

function bounded(
  value: Readonly<ClusterLegacyEnvMigrationPlan>,
): Readonly<ClusterLegacyEnvMigrationPlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_CLUSTER_LEGACY_ENV_MIGRATION_PLAN_JSON_BYTES
  ) {
    return invalid('encoded plan exceeds the size limit');
  }
  return value;
}

export function createClusterLegacyEnvMigrationPlan(
  intentValue: ClusterLegacyEnvMigrationPlanIntent,
  plannedAtMsValue: number,
): Readonly<ClusterLegacyEnvMigrationPlan> {
  const intent = normalizeClusterLegacyEnvMigrationPlanIntent(intentValue);
  const unsigned = Object.freeze({
    schema: CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA,
    ...intent,
    plannedAtMs: timestamp(plannedAtMsValue),
  });
  return bounded(
    Object.freeze({
      ...unsigned,
      planDigest: clusterLegacyEnvMigrationPlanDigest(unsigned),
    }),
  );
}

export function normalizeClusterLegacyEnvMigrationPlan(
  value: ClusterLegacyEnvMigrationPlan,
): Readonly<ClusterLegacyEnvMigrationPlan> {
  const candidate = record(value, 'plan');
  exactKeys(
    candidate,
    [
      'mutationId',
      'planDigest',
      'planId',
      'plannedAtMs',
      'projectId',
      'schema',
      'source',
      'target',
    ],
    'plan',
  );
  if (value.schema !== CLUSTER_LEGACY_ENV_MIGRATION_PLAN_SCHEMA) {
    return invalid('schema is invalid');
  }
  const expected = createClusterLegacyEnvMigrationPlan(
    {
      planId: value.planId,
      mutationId: value.mutationId,
      projectId: value.projectId,
      source: value.source,
      target: value.target,
    },
    value.plannedAtMs,
  );
  if (
    typeof value.planDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.planDigest) ||
    value.planDigest !== expected.planDigest
  ) {
    return invalid('planDigest does not match plan');
  }
  return expected;
}

export function clusterLegacyEnvMigrationPlanMatchesIntent(
  planValue: ClusterLegacyEnvMigrationPlan,
  intentValue: ClusterLegacyEnvMigrationPlanIntent,
): boolean {
  const plan = normalizeClusterLegacyEnvMigrationPlan(planValue);
  const intent = normalizeClusterLegacyEnvMigrationPlanIntent(intentValue);
  return (
    plan.planId === intent.planId &&
    plan.mutationId === intent.mutationId &&
    plan.projectId === intent.projectId &&
    JSON.stringify(plan.source) === JSON.stringify(intent.source) &&
    JSON.stringify(plan.target) === JSON.stringify(intent.target)
  );
}
