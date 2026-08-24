import { createHash, type Hash } from 'node:crypto';

import {
  MAX_CLUSTER_LEGACY_ENV_TASKS,
  MAX_CLUSTER_LEGACY_ENV_TRIGGERS,
} from './clusterLegacyEnvMigrationPlan';
import { parseSecretRef } from '../secret/secretReference';

export const CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA =
  'qinglong/cluster-legacy-env-migration-application-receipt@v1' as const;
export const MAX_CLUSTER_LEGACY_ENV_MIGRATION_RECEIPT_JSON_BYTES = 8 * 1024;

export interface ClusterLegacyEnvMigrationTaskMutation {
  readonly ordinal: number;
  readonly taskId: string;
  readonly previousRevision: number;
  readonly previousContentDigest: string;
  readonly mutationId: string;
}

export interface ClusterLegacyEnvMigrationTriggerMutation {
  readonly ordinal: number;
  readonly triggerId: string;
  readonly taskId: string;
  readonly previousRevision: number;
  readonly previousContentDigest: string;
  readonly previousTaskRevision: number;
  readonly previousTaskContentDigest: string;
  readonly mutationId: string;
}

export interface ClusterLegacyEnvMigrationApplicationIntent {
  readonly applicationId: string;
  readonly mutationId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly taskMutationSetDigest: string;
  readonly triggerMutationSetDigest: string;
}

export interface ClusterLegacyEnvMigrationApplicationReceipt
  extends ClusterLegacyEnvMigrationApplicationIntent {
  readonly schema: typeof CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA;
  readonly environmentBundleRef: string;
  readonly taskRevisionSetDigest: string;
  readonly triggerRevisionSetDigest: string;
  readonly taskCount: number;
  readonly triggerCount: number;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

export interface ClusterLegacyEnvMigrationMutationStreams {
  readonly taskMutations: () =>
    | Iterable<ClusterLegacyEnvMigrationTaskMutation>
    | AsyncIterable<ClusterLegacyEnvMigrationTaskMutation>;
  readonly triggerMutations: () =>
    | Iterable<ClusterLegacyEnvMigrationTriggerMutation>
    | AsyncIterable<ClusterLegacyEnvMigrationTriggerMutation>;
}

export interface ClusterLegacyEnvMigrationApplicationRepository {
  apply(
    intent: Readonly<ClusterLegacyEnvMigrationApplicationIntent>,
    streams: Readonly<ClusterLegacyEnvMigrationMutationStreams>,
  ): Promise<
    Readonly<{
      status: 'applied' | 'existing';
      receipt: Readonly<ClusterLegacyEnvMigrationApplicationReceipt>;
    }>
  >;
  findByApplicationId(
    applicationId: string,
  ): Promise<Readonly<ClusterLegacyEnvMigrationApplicationReceipt> | null>;
}

export interface ClusterLegacyEnvMigrationTaskMutationSetDigestResult {
  readonly count: number;
  readonly revisionSetDigest: string;
  readonly mutationSetDigest: string;
}

export interface ClusterLegacyEnvMigrationTriggerMutationSetDigestResult {
  readonly count: number;
  readonly revisionSetDigest: string;
  readonly mutationSetDigest: string;
}

export class InvalidClusterLegacyEnvMigrationApplicationError extends TypeError {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_INVALID';

  constructor(message: string) {
    super(`Cluster Legacy Env migration application is invalid: ${message}`);
    this.name = 'InvalidClusterLegacyEnvMigrationApplicationError';
  }
}

export class ClusterLegacyEnvMigrationApplicationConflictError extends Error {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_CONFLICT';

  constructor() {
    super(
      'Cluster Legacy Env migration application conflicts with durable state',
    );
    this.name = 'ClusterLegacyEnvMigrationApplicationConflictError';
  }
}

export class ClusterLegacyEnvMigrationApplicationUnavailableError extends Error {
  readonly code = 'CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Cluster Legacy Env migration application is unavailable', options);
    this.name = 'ClusterLegacyEnvMigrationApplicationUnavailableError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MUTATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TASK_REVISION_SET_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-task-revision-set@v1\0',
  'utf8',
);
const TASK_MUTATION_SET_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-task-mutation-set@v1\0',
  'utf8',
);
const TRIGGER_REVISION_SET_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-trigger-revision-set@v1\0',
  'utf8',
);
const TRIGGER_MUTATION_SET_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-trigger-mutation-set@v1\0',
  'utf8',
);
const RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-migration-application-receipt-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidClusterLegacyEnvMigrationApplicationError(message);
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

export function assertClusterLegacyEnvMigrationApplicationIdentifier(
  value: unknown,
  label: 'applicationId' | 'planId' | 'projectId',
): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function entityIdentifier(
  value: unknown,
  label: 'taskId' | 'triggerId',
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function mutationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MUTATION_ID_PATTERN.test(value)) {
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

function revision(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function ordinal(value: unknown, label: string, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('committedAtMs is invalid');
  }
  return value as number;
}

export function normalizeClusterLegacyEnvMigrationTaskMutation(
  value: ClusterLegacyEnvMigrationTaskMutation,
): Readonly<ClusterLegacyEnvMigrationTaskMutation> {
  const candidate = record(value, 'Task mutation');
  exactKeys(
    candidate,
    [
      'mutationId',
      'ordinal',
      'previousContentDigest',
      'previousRevision',
      'taskId',
    ],
    'Task mutation',
  );
  return Object.freeze({
    ordinal: ordinal(
      value.ordinal,
      'Task mutation ordinal',
      MAX_CLUSTER_LEGACY_ENV_TASKS,
    ),
    taskId: entityIdentifier(value.taskId, 'taskId'),
    previousRevision: revision(value.previousRevision, 'previousRevision'),
    previousContentDigest: digest(
      value.previousContentDigest,
      'previousContentDigest',
    ),
    mutationId: mutationId(value.mutationId, 'Task mutationId'),
  });
}

export function normalizeClusterLegacyEnvMigrationTriggerMutation(
  value: ClusterLegacyEnvMigrationTriggerMutation,
): Readonly<ClusterLegacyEnvMigrationTriggerMutation> {
  const candidate = record(value, 'Trigger mutation');
  exactKeys(
    candidate,
    [
      'mutationId',
      'ordinal',
      'previousContentDigest',
      'previousRevision',
      'previousTaskContentDigest',
      'previousTaskRevision',
      'taskId',
      'triggerId',
    ],
    'Trigger mutation',
  );
  return Object.freeze({
    ordinal: ordinal(
      value.ordinal,
      'Trigger mutation ordinal',
      MAX_CLUSTER_LEGACY_ENV_TRIGGERS,
    ),
    triggerId: entityIdentifier(value.triggerId, 'triggerId'),
    taskId: entityIdentifier(value.taskId, 'taskId'),
    previousRevision: revision(value.previousRevision, 'previousRevision'),
    previousContentDigest: digest(
      value.previousContentDigest,
      'previousContentDigest',
    ),
    previousTaskRevision: revision(
      value.previousTaskRevision,
      'previousTaskRevision',
    ),
    previousTaskContentDigest: digest(
      value.previousTaskContentDigest,
      'previousTaskContentDigest',
    ),
    mutationId: mutationId(value.mutationId, 'Trigger mutationId'),
  });
}

export function normalizeClusterLegacyEnvMigrationApplicationIntent(
  value: ClusterLegacyEnvMigrationApplicationIntent,
): Readonly<ClusterLegacyEnvMigrationApplicationIntent> {
  const candidate = record(value, 'application intent');
  exactKeys(
    candidate,
    [
      'applicationId',
      'mutationId',
      'planDigest',
      'planId',
      'projectId',
      'taskMutationSetDigest',
      'triggerMutationSetDigest',
    ],
    'application intent',
  );
  return Object.freeze({
    applicationId: assertClusterLegacyEnvMigrationApplicationIdentifier(
      value.applicationId,
      'applicationId',
    ),
    mutationId: mutationId(value.mutationId, 'mutationId'),
    projectId: assertClusterLegacyEnvMigrationApplicationIdentifier(
      value.projectId,
      'projectId',
    ),
    planId: assertClusterLegacyEnvMigrationApplicationIdentifier(
      value.planId,
      'planId',
    ),
    planDigest: digest(value.planDigest, 'planDigest'),
    taskMutationSetDigest: digest(
      value.taskMutationSetDigest,
      'taskMutationSetDigest',
    ),
    triggerMutationSetDigest: digest(
      value.triggerMutationSetDigest,
      'triggerMutationSetDigest',
    ),
  });
}

function updateHash(hash: Hash, value: object): void {
  hash.update(JSON.stringify(value), 'utf8').update('\n', 'utf8');
}

function finalizeHash(hash: Hash, count: number): string {
  updateHash(hash, { count });
  return hash.digest('hex');
}

export function createClusterLegacyEnvMigrationTaskMutationSetDigester(): Readonly<{
  update(
    value: ClusterLegacyEnvMigrationTaskMutation,
  ): Readonly<ClusterLegacyEnvMigrationTaskMutation>;
  finish(): Readonly<ClusterLegacyEnvMigrationTaskMutationSetDigestResult>;
}> {
  const revisionHash = createHash('sha256').update(TASK_REVISION_SET_DOMAIN);
  const mutationHash = createHash('sha256').update(TASK_MUTATION_SET_DOMAIN);
  let count = 0;
  let previousId: string | undefined;
  let finished = false;
  return Object.freeze({
    update(value: ClusterLegacyEnvMigrationTaskMutation) {
      if (finished) return invalid('Task mutation digester is finished');
      const item = normalizeClusterLegacyEnvMigrationTaskMutation(value);
      if (
        item.ordinal !== count ||
        (previousId !== undefined && item.taskId <= previousId)
      ) {
        return invalid(
          'Task mutations must be contiguous and ordered by taskId',
        );
      }
      updateHash(revisionHash, {
        ordinal: item.ordinal,
        taskId: item.taskId,
        revision: item.previousRevision,
        contentDigest: item.previousContentDigest,
      });
      updateHash(mutationHash, item);
      previousId = item.taskId;
      count += 1;
      return item;
    },
    finish() {
      if (finished) return invalid('Task mutation digester is finished');
      finished = true;
      return Object.freeze({
        count,
        revisionSetDigest: finalizeHash(revisionHash, count),
        mutationSetDigest: finalizeHash(mutationHash, count),
      });
    },
  });
}

export function createClusterLegacyEnvMigrationTriggerMutationSetDigester(): Readonly<{
  update(
    value: ClusterLegacyEnvMigrationTriggerMutation,
  ): Readonly<ClusterLegacyEnvMigrationTriggerMutation>;
  finish(): Readonly<ClusterLegacyEnvMigrationTriggerMutationSetDigestResult>;
}> {
  const revisionHash = createHash('sha256').update(TRIGGER_REVISION_SET_DOMAIN);
  const mutationHash = createHash('sha256').update(TRIGGER_MUTATION_SET_DOMAIN);
  let count = 0;
  let previousId: string | undefined;
  let finished = false;
  return Object.freeze({
    update(value: ClusterLegacyEnvMigrationTriggerMutation) {
      if (finished) return invalid('Trigger mutation digester is finished');
      const item = normalizeClusterLegacyEnvMigrationTriggerMutation(value);
      if (
        item.ordinal !== count ||
        (previousId !== undefined && item.triggerId <= previousId)
      ) {
        return invalid(
          'Trigger mutations must be contiguous and ordered by triggerId',
        );
      }
      updateHash(revisionHash, {
        ordinal: item.ordinal,
        triggerId: item.triggerId,
        taskId: item.taskId,
        revision: item.previousRevision,
        contentDigest: item.previousContentDigest,
        taskRevision: item.previousTaskRevision,
        taskContentDigest: item.previousTaskContentDigest,
      });
      updateHash(mutationHash, item);
      previousId = item.triggerId;
      count += 1;
      return item;
    },
    finish() {
      if (finished) return invalid('Trigger mutation digester is finished');
      finished = true;
      return Object.freeze({
        count,
        revisionSetDigest: finalizeHash(revisionHash, count),
        mutationSetDigest: finalizeHash(mutationHash, count),
      });
    },
  });
}

function unsignedReceipt(
  value: Omit<ClusterLegacyEnvMigrationApplicationReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    applicationId: value.applicationId,
    mutationId: value.mutationId,
    projectId: value.projectId,
    planId: value.planId,
    planDigest: value.planDigest,
    environmentBundleRef: value.environmentBundleRef,
    taskRevisionSetDigest: value.taskRevisionSetDigest,
    triggerRevisionSetDigest: value.triggerRevisionSetDigest,
    taskMutationSetDigest: value.taskMutationSetDigest,
    triggerMutationSetDigest: value.triggerMutationSetDigest,
    taskCount: value.taskCount,
    triggerCount: value.triggerCount,
    committedAtMs: value.committedAtMs,
  };
}

export function clusterLegacyEnvMigrationApplicationReceiptDigest(
  value: Omit<ClusterLegacyEnvMigrationApplicationReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(unsignedReceipt(value)), 'utf8')
    .digest('hex');
}

export function createClusterLegacyEnvMigrationApplicationReceipt(
  value: Omit<
    ClusterLegacyEnvMigrationApplicationReceipt,
    'schema' | 'receiptDigest'
  >,
): Readonly<ClusterLegacyEnvMigrationApplicationReceipt> {
  const candidate = record(value, 'application receipt input');
  exactKeys(
    candidate,
    [
      'applicationId',
      'committedAtMs',
      'environmentBundleRef',
      'mutationId',
      'planDigest',
      'planId',
      'projectId',
      'taskCount',
      'taskMutationSetDigest',
      'taskRevisionSetDigest',
      'triggerCount',
      'triggerMutationSetDigest',
      'triggerRevisionSetDigest',
    ],
    'application receipt input',
  );
  const intent = normalizeClusterLegacyEnvMigrationApplicationIntent({
    applicationId: value.applicationId,
    mutationId: value.mutationId,
    projectId: value.projectId,
    planId: value.planId,
    planDigest: value.planDigest,
    taskMutationSetDigest: value.taskMutationSetDigest,
    triggerMutationSetDigest: value.triggerMutationSetDigest,
  });
  let environmentBundleReference;
  try {
    environmentBundleReference = parseSecretRef(value.environmentBundleRef);
  } catch {
    return invalid('environmentBundleRef is invalid');
  }
  if (
    !Number.isSafeInteger(value.taskCount) ||
    value.taskCount < 1 ||
    value.taskCount > MAX_CLUSTER_LEGACY_ENV_TASKS ||
    !Number.isSafeInteger(value.triggerCount) ||
    value.triggerCount < 0 ||
    value.triggerCount > MAX_CLUSTER_LEGACY_ENV_TRIGGERS ||
    environmentBundleReference.projectId !== intent.projectId ||
    environmentBundleReference.version === undefined
  ) {
    return invalid('receipt target is invalid');
  }
  const unsigned = Object.freeze({
    schema: CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA,
    ...intent,
    environmentBundleRef: value.environmentBundleRef,
    taskRevisionSetDigest: digest(
      value.taskRevisionSetDigest,
      'taskRevisionSetDigest',
    ),
    triggerRevisionSetDigest: digest(
      value.triggerRevisionSetDigest,
      'triggerRevisionSetDigest',
    ),
    taskCount: value.taskCount,
    triggerCount: value.triggerCount,
    committedAtMs: timestamp(value.committedAtMs),
  });
  const receipt = Object.freeze({
    ...unsigned,
    receiptDigest: clusterLegacyEnvMigrationApplicationReceiptDigest(unsigned),
  });
  if (
    Buffer.byteLength(JSON.stringify(receipt), 'utf8') >
    MAX_CLUSTER_LEGACY_ENV_MIGRATION_RECEIPT_JSON_BYTES
  ) {
    return invalid('encoded receipt exceeds the size limit');
  }
  return receipt;
}

export function normalizeClusterLegacyEnvMigrationApplicationReceipt(
  value: ClusterLegacyEnvMigrationApplicationReceipt,
): Readonly<ClusterLegacyEnvMigrationApplicationReceipt> {
  const candidate = record(value, 'application receipt');
  exactKeys(
    candidate,
    [
      'applicationId',
      'committedAtMs',
      'environmentBundleRef',
      'mutationId',
      'planDigest',
      'planId',
      'projectId',
      'receiptDigest',
      'schema',
      'taskCount',
      'taskMutationSetDigest',
      'taskRevisionSetDigest',
      'triggerCount',
      'triggerMutationSetDigest',
      'triggerRevisionSetDigest',
    ],
    'application receipt',
  );
  if (
    value.schema !== CLUSTER_LEGACY_ENV_MIGRATION_APPLICATION_RECEIPT_SCHEMA
  ) {
    return invalid('receipt schema is invalid');
  }
  const expected = createClusterLegacyEnvMigrationApplicationReceipt({
    applicationId: value.applicationId,
    mutationId: value.mutationId,
    projectId: value.projectId,
    planId: value.planId,
    planDigest: value.planDigest,
    environmentBundleRef: value.environmentBundleRef,
    taskRevisionSetDigest: value.taskRevisionSetDigest,
    triggerRevisionSetDigest: value.triggerRevisionSetDigest,
    taskMutationSetDigest: value.taskMutationSetDigest,
    triggerMutationSetDigest: value.triggerMutationSetDigest,
    taskCount: value.taskCount,
    triggerCount: value.triggerCount,
    committedAtMs: value.committedAtMs,
  });
  if (value.receiptDigest !== expected.receiptDigest) {
    return invalid('receiptDigest does not match receipt');
  }
  return expected;
}

export function clusterLegacyEnvMigrationApplicationReceiptMatchesIntent(
  receiptValue: ClusterLegacyEnvMigrationApplicationReceipt,
  intentValue: ClusterLegacyEnvMigrationApplicationIntent,
): boolean {
  const receipt =
    normalizeClusterLegacyEnvMigrationApplicationReceipt(receiptValue);
  const intent =
    normalizeClusterLegacyEnvMigrationApplicationIntent(intentValue);
  return (
    receipt.applicationId === intent.applicationId &&
    receipt.mutationId === intent.mutationId &&
    receipt.projectId === intent.projectId &&
    receipt.planId === intent.planId &&
    receipt.planDigest === intent.planDigest &&
    receipt.taskMutationSetDigest === intent.taskMutationSetDigest &&
    receipt.triggerMutationSetDigest === intent.triggerMutationSetDigest
  );
}
