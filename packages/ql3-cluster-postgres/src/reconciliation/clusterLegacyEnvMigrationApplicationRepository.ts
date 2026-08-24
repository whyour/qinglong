import { createHash } from 'node:crypto';

import {
  ClusterLegacyEnvMigrationApplicationConflictError,
  ClusterLegacyEnvMigrationApplicationUnavailableError,
  InvalidClusterLegacyEnvMigrationApplicationError,
  assertClusterLegacyEnvMigrationApplicationIdentifier,
  clusterLegacyEnvMigrationApplicationReceiptMatchesIntent,
  createClusterLegacyEnvMigrationApplicationReceipt,
  createClusterLegacyEnvMigrationTaskMutationSetDigester,
  createClusterLegacyEnvMigrationTriggerMutationSetDigester,
  normalizeClusterLegacyEnvMigrationApplicationIntent,
  normalizeClusterLegacyEnvMigrationApplicationReceipt,
  type ClusterLegacyEnvMigrationApplicationIntent,
  type ClusterLegacyEnvMigrationApplicationReceipt,
  type ClusterLegacyEnvMigrationApplicationRepository,
  type ClusterLegacyEnvMigrationMutationStreams,
  type ClusterLegacyEnvMigrationTaskMutation,
  type ClusterLegacyEnvMigrationTriggerMutation,
} from '@qinglong/runtime-core/cluster-legacy-env-migration-application';
import {
  normalizeClusterLegacyEnvMigrationPlan,
  type ClusterLegacyEnvMigrationPlan,
} from '@qinglong/runtime-core/cluster-legacy-env-migration-plan';
import {
  compileClusterCommandTaskDefinition,
  type ClusterTaskExecutionRevision,
} from '@qinglong/runtime-core/cluster-execution-revision';
import {
  createTaskDefinitionRecord,
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
  type TaskDefinitionSpec,
} from '@qinglong/runtime-core/task-definition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import {
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
  normalizeTriggerRecord,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const APPLICATION_BATCH_SIZE = 128;
const TASK_ITEM_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-migration-application-task-item@v1\0',
  'utf8',
);
const TRIGGER_ITEM_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-legacy-env-migration-application-trigger-item@v1\0',
  'utf8',
);

const TASK_SELECT_FIELDS = `
  head.project_id AS "projectId",
  head.task_id AS "taskId",
  revision.revision,
  revision.mutation_id AS "mutationId",
  revision.name,
  revision.description,
  revision.kind,
  revision.spec_json AS "specJson",
  revision.labels_json AS "labelsJson",
  revision.enabled,
  revision.content_digest AS "contentDigest",
  head.created_at_ms AS "createdAtMs",
  revision.created_at_ms AS "updatedAtMs"`;

const TRIGGER_SELECT_FIELDS = `
  head.project_id AS "projectId",
  head.trigger_id AS "triggerId",
  revision.revision,
  revision.mutation_id AS "mutationId",
  revision.task_id AS "taskId",
  revision.task_revision AS "taskRevision",
  revision.task_content_digest AS "taskContentDigest",
  revision.spec_json AS "specJson",
  revision.enabled,
  revision.content_digest AS "contentDigest",
  head.created_at_ms AS "createdAtMs",
  revision.created_at_ms AS "updatedAtMs"`;

export interface PostgresClusterLegacyEnvMigrationApplicationTransactionContext {
  readonly intent: Readonly<ClusterLegacyEnvMigrationApplicationIntent>;
  readonly replay: Readonly<ClusterLegacyEnvMigrationApplicationReceipt> | null;
  readonly receipt: Readonly<ClusterLegacyEnvMigrationApplicationReceipt>;
}

export type PostgresClusterLegacyEnvMigrationApplicationTransactionHook = (
  client: PostgresClient,
  context: Readonly<PostgresClusterLegacyEnvMigrationApplicationTransactionContext>,
) => Promise<void>;

interface AppliedTask {
  readonly source: Readonly<ClusterLegacyEnvMigrationTaskMutation>;
  readonly definition: Readonly<TaskDefinitionRecord>;
  readonly execution: Readonly<ClusterTaskExecutionRevision> | null;
  readonly itemDigest: string;
}

interface AppliedTrigger {
  readonly source: Readonly<ClusterLegacyEnvMigrationTriggerMutation>;
  readonly trigger: Readonly<TriggerRecord>;
  readonly itemDigest: string;
}

function conflict(): ClusterLegacyEnvMigrationApplicationConflictError {
  return new ClusterLegacyEnvMigrationApplicationConflictError();
}

function unavailable(): ClusterLegacyEnvMigrationApplicationUnavailableError {
  return new ClusterLegacyEnvMigrationApplicationUnavailableError();
}

function invalid(
  message: string,
): InvalidClusterLegacyEnvMigrationApplicationError {
  return new InvalidClusterLegacyEnvMigrationApplicationError(message);
}

function contentDigest(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function taskItemDigest(
  applicationId: string,
  source: ClusterLegacyEnvMigrationTaskMutation,
  definition: TaskDefinitionRecord,
  execution: ClusterTaskExecutionRevision | null,
): string {
  return contentDigest(TASK_ITEM_DIGEST_DOMAIN, {
    applicationId,
    ordinal: source.ordinal,
    projectId: definition.projectId,
    taskId: definition.taskId,
    previousRevision: source.previousRevision,
    previousContentDigest: source.previousContentDigest,
    mutationId: source.mutationId,
    revision: definition.revision,
    contentDigest: definition.contentDigest,
    executionContentDigest: execution?.contentDigest ?? null,
  });
}

function triggerItemDigest(
  applicationId: string,
  source: ClusterLegacyEnvMigrationTriggerMutation,
  trigger: TriggerRecord,
): string {
  return contentDigest(TRIGGER_ITEM_DIGEST_DOMAIN, {
    applicationId,
    ordinal: source.ordinal,
    projectId: trigger.projectId,
    triggerId: trigger.triggerId,
    taskId: trigger.taskId,
    previousRevision: source.previousRevision,
    previousContentDigest: source.previousContentDigest,
    previousTaskRevision: source.previousTaskRevision,
    previousTaskContentDigest: source.previousTaskContentDigest,
    mutationId: source.mutationId,
    revision: trigger.revision,
    contentDigest: trigger.contentDigest,
    taskRevision: trigger.taskRevision,
    taskContentDigest: trigger.taskContentDigest,
  });
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    const description = row.description;
    if (description !== null && typeof description !== 'string') {
      throw unavailable();
    }
    return normalizeTaskDefinitionRecord({
      projectId: postgresRequiredString(row.projectId, unavailable),
      taskId: postgresRequiredString(row.taskId, unavailable),
      revision: postgresRequiredInteger(row.revision, unavailable),
      mutationId: postgresRequiredString(row.mutationId, unavailable),
      name: postgresRequiredString(row.name, unavailable),
      ...(description === null ? {} : { description }),
      kind: postgresRequiredString(
        row.kind,
        unavailable,
      ) as TaskDefinitionRecord['kind'],
      spec: postgresRequiredJsonObject(
        row.specJson,
        unavailable,
      ) as unknown as TaskDefinitionRecord['spec'],
      labels: postgresRequiredJsonObject(
        row.labelsJson,
        unavailable,
      ) as TaskDefinitionRecord['labels'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: postgresRequiredString(row.contentDigest, unavailable),
      createdAtMs: postgresRequiredInteger(row.createdAtMs, unavailable),
      updatedAtMs: postgresRequiredInteger(row.updatedAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof ClusterLegacyEnvMigrationApplicationUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function triggerRecord(row: Row): Readonly<TriggerRecord> {
  try {
    return normalizeTriggerRecord({
      projectId: postgresRequiredString(row.projectId, unavailable),
      triggerId: postgresRequiredString(row.triggerId, unavailable),
      revision: postgresRequiredInteger(row.revision, unavailable),
      mutationId: postgresRequiredString(row.mutationId, unavailable),
      taskId: postgresRequiredString(row.taskId, unavailable),
      taskRevision: postgresRequiredInteger(row.taskRevision, unavailable),
      taskContentDigest: postgresRequiredString(
        row.taskContentDigest,
        unavailable,
      ),
      spec: postgresRequiredJsonObject(
        row.specJson,
        unavailable,
      ) as unknown as TriggerRecord['spec'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: postgresRequiredString(row.contentDigest, unavailable),
      createdAtMs: postgresRequiredInteger(row.createdAtMs, unavailable),
      updatedAtMs: postgresRequiredInteger(row.updatedAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof ClusterLegacyEnvMigrationApplicationUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function planFromRow(row: Row): Readonly<ClusterLegacyEnvMigrationPlan> {
  try {
    return normalizeClusterLegacyEnvMigrationPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as ClusterLegacyEnvMigrationPlan,
    );
  } catch (error) {
    if (error instanceof ClusterLegacyEnvMigrationApplicationUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function receiptFromRow(
  row: Row,
): Readonly<ClusterLegacyEnvMigrationApplicationReceipt> {
  try {
    return normalizeClusterLegacyEnvMigrationApplicationReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as ClusterLegacyEnvMigrationApplicationReceipt,
    );
  } catch (error) {
    if (error instanceof ClusterLegacyEnvMigrationApplicationUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

async function findReceipt(
  queryable: Queryable,
  column: 'application_id' | 'mutation_id',
  value: string,
): Promise<Readonly<ClusterLegacyEnvMigrationApplicationReceipt> | null> {
  const result = await queryable.query<Row>(
    `SELECT receipt_json AS "receiptJson"
       FROM "ql3"."cluster_legacy_env_migration_application_receipts"
      WHERE ${column} = $1
      LIMIT 2`,
    [value],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  const receipt = receiptFromRow(result.rows[0]!);
  if (
    (column === 'application_id' && receipt.applicationId !== value) ||
    (column === 'mutation_id' && receipt.mutationId !== value)
  ) {
    throw unavailable();
  }
  return receipt;
}

async function loadPlan(
  client: PostgresClient,
  intent: ClusterLegacyEnvMigrationApplicationIntent,
): Promise<Readonly<ClusterLegacyEnvMigrationPlan>> {
  const result = await client.query<Row>(
    `SELECT plan_json AS "planJson"
       FROM "ql3"."cluster_legacy_env_migration_plans"
      WHERE plan_id = $1`,
    [intent.planId],
  );
  if (result.rows.length !== 1) throw conflict();
  const plan = planFromRow(result.rows[0]!);
  if (
    plan.planId !== intent.planId ||
    plan.projectId !== intent.projectId ||
    plan.planDigest !== intent.planDigest
  ) {
    throw conflict();
  }
  return plan;
}

function normalizeStreams(
  value: Readonly<ClusterLegacyEnvMigrationMutationStreams>,
): Readonly<ClusterLegacyEnvMigrationMutationStreams> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalid('mutation streams are invalid');
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const taskMutations = descriptors.taskMutations;
  const triggerMutations = descriptors.triggerMutations;
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.length !== 2 ||
    !keys.includes('taskMutations') ||
    !keys.includes('triggerMutations') ||
    taskMutations?.enumerable !== true ||
    taskMutations.get !== undefined ||
    taskMutations.set !== undefined ||
    typeof taskMutations.value !== 'function' ||
    triggerMutations?.enumerable !== true ||
    triggerMutations.get !== undefined ||
    triggerMutations.set !== undefined ||
    typeof triggerMutations.value !== 'function'
  ) {
    throw invalid('mutation stream shape is invalid');
  }
  return Object.freeze({
    taskMutations: taskMutations.value,
    triggerMutations: triggerMutations.value,
  });
}

async function* mutationStream<T>(
  factory: () => Iterable<T> | AsyncIterable<T>,
  label: string,
): AsyncIterable<T> {
  let source: Iterable<T> | AsyncIterable<T>;
  try {
    source = factory();
  } catch {
    throw invalid(`${label} factory failed`);
  }
  if (!source || typeof source !== 'object') {
    throw invalid(`${label} must be iterable`);
  }
  const asyncFactory = (source as AsyncIterable<T>)[Symbol.asyncIterator];
  const syncFactory = (source as Iterable<T>)[Symbol.iterator];
  let iterator: AsyncIterator<T> | Iterator<T>;
  try {
    iterator =
      typeof asyncFactory === 'function'
        ? asyncFactory.call(source)
        : typeof syncFactory === 'function'
        ? syncFactory.call(source)
        : (() => {
            throw invalid(`${label} must be iterable`);
          })();
  } catch (error) {
    if (error instanceof InvalidClusterLegacyEnvMigrationApplicationError) {
      throw error;
    }
    throw invalid(`${label} iterator is invalid`);
  }
  while (true) {
    let step: IteratorResult<T>;
    try {
      step = await iterator.next();
    } catch {
      throw invalid(`${label} iteration failed`);
    }
    if (!step || typeof step !== 'object' || typeof step.done !== 'boolean') {
      throw invalid(`${label} iterator result is invalid`);
    }
    if (step.done) return;
    yield step.value;
  }
}

function clusterExecutionPlanJson(
  revision: ClusterTaskExecutionRevision,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    command: revision.command,
    environment: revision.environment,
    ...(revision.environmentBundleRef === undefined
      ? {}
      : { environmentBundleRef: revision.environmentBundleRef }),
    ...(revision.workingDirectory === undefined
      ? {}
      : { workingDirectory: revision.workingDirectory }),
    ...(revision.timeoutMs === undefined
      ? {}
      : { timeoutMs: revision.timeoutMs }),
    ...(revision.placement === undefined
      ? {}
      : { placement: revision.placement }),
  });
}

function requireRowCount(
  value: number | null | undefined,
  expected: number,
): void {
  if (value !== expected) throw conflict();
}

function indexRowsByStringId(
  rows: readonly Row[],
  field: 'taskId' | 'triggerId',
): ReadonlyMap<string, Row> {
  const indexed = new Map<string, Row>();
  for (const row of rows) {
    const id = postgresRequiredString(row[field], unavailable);
    if (indexed.has(id)) throw unavailable();
    indexed.set(id, row);
  }
  return indexed;
}

async function insertTaskBatch(
  client: PostgresClient,
  applicationId: string,
  projectId: string,
  environmentBundleRef: string,
  committedAtMs: number,
  batch: readonly ClusterLegacyEnvMigrationTaskMutation[],
): Promise<void> {
  const ids = batch.map((item) => item.taskId);
  const loaded = await client.query<Row>(
    `SELECT ${TASK_SELECT_FIELDS},
            EXISTS (
              SELECT 1
                FROM "ql3"."plugin_package_task_ownerships" AS ownership
               WHERE ownership.project_id = head.project_id
                 AND ownership.task_id = head.task_id
            ) AS "pluginOwned"
       FROM "ql3"."task_definitions" AS head
       JOIN "ql3"."task_definition_revisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
      WHERE head.project_id = $1 AND head.task_id = ANY($2::varchar[])
      FOR UPDATE OF head`,
    [projectId, ids],
  );
  if (loaded.rows.length !== batch.length) throw conflict();
  const rowsByTaskId = indexRowsByStringId(loaded.rows, 'taskId');

  const semanticRegistry = createBuiltInTaskSpecSemanticRegistry();
  const applied: AppliedTask[] = [];
  for (const source of batch) {
    const row = rowsByTaskId.get(source.taskId);
    if (row === undefined) throw conflict();
    const current = taskRecord(row);
    if (
      current.projectId !== projectId ||
      current.taskId !== source.taskId ||
      current.revision !== source.previousRevision ||
      current.contentDigest !== source.previousContentDigest ||
      row.pluginOwned !== false ||
      current.kind !== 'command' ||
      current.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA ||
      Object.hasOwn(current.spec.config, 'environmentBundleRef') ||
      committedAtMs < current.updatedAtMs
    ) {
      throw conflict();
    }
    let definition: Readonly<TaskDefinitionRecord>;
    let execution: Readonly<ClusterTaskExecutionRevision> | null;
    try {
      const spec = semanticRegistry.normalize({
        projectId,
        taskId: current.taskId,
        kind: 'command',
        spec: {
          schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
          config: {
            ...current.spec.config,
            environmentBundleRef,
          },
        } as TaskDefinitionSpec,
      });
      definition = createTaskDefinitionRecord(
        {
          projectId,
          taskId: current.taskId,
          expectedRevision: current.revision,
          mutationId: source.mutationId,
          name: current.name,
          ...(current.description === undefined
            ? {}
            : { description: current.description }),
          kind: current.kind,
          spec,
          labels: current.labels,
          enabled: current.enabled,
          occurredAtMs: committedAtMs,
        },
        current.createdAtMs,
      );
      execution = definition.enabled
        ? compileClusterCommandTaskDefinition(definition, semanticRegistry)
        : null;
    } catch {
      throw conflict();
    }
    applied.push({
      source,
      definition,
      execution,
      itemDigest: taskItemDigest(applicationId, source, definition, execution),
    });
  }

  const revisions = applied.map(({ definition }) => ({
    project_id: definition.projectId,
    task_id: definition.taskId,
    revision: definition.revision,
    mutation_id: definition.mutationId,
    name: definition.name,
    description: definition.description ?? null,
    kind: definition.kind,
    spec_json: definition.spec,
    labels_json: definition.labels,
    enabled: definition.enabled,
    content_digest: definition.contentDigest,
    created_at_ms: definition.updatedAtMs,
  }));
  const revisionInsert = await client.query(
    `INSERT INTO "ql3"."task_definition_revisions" (
       project_id, task_id, revision, mutation_id, name, description, kind,
       spec_json, labels_json, enabled, content_digest, created_at_ms
     )
     SELECT project_id, task_id, revision, mutation_id, name, description,
            kind, spec_json, labels_json, enabled, content_digest, created_at_ms
       FROM jsonb_to_recordset($1::jsonb) AS data(
         project_id varchar(128), task_id varchar(128), revision integer,
         mutation_id uuid, name varchar(255), description varchar(4096),
         kind varchar(16), spec_json jsonb, labels_json jsonb, enabled boolean,
         content_digest char(64), created_at_ms bigint
       )`,
    [JSON.stringify(revisions)],
  );
  requireRowCount(revisionInsert.rowCount, applied.length);

  const executions = applied
    .map(({ execution }) => execution)
    .filter(
      (value): value is Readonly<ClusterTaskExecutionRevision> =>
        value !== null,
    )
    .map((execution) => ({
      project_id: execution.projectId,
      task_id: execution.taskId,
      source_revision: execution.sourceRevision,
      task_revision: execution.taskRevision,
      source_content_digest: execution.sourceContentDigest,
      executor_type: execution.executorType,
      plan_schema: execution.planSchema,
      plan_json: clusterExecutionPlanJson(execution),
      content_digest: execution.contentDigest,
      created_at_ms: execution.createdAtMs,
    }));
  if (executions.length > 0) {
    const executionInsert = await client.query(
      `INSERT INTO "ql3"."task_execution_revisions" (
         project_id, task_id, source_revision, task_revision,
         source_content_digest, executor_type, plan_schema, plan_json,
         content_digest, created_at_ms
       )
       SELECT project_id, task_id, source_revision, task_revision,
              source_content_digest, executor_type, plan_schema, plan_json,
              content_digest, created_at_ms
         FROM jsonb_to_recordset($1::jsonb) AS data(
           project_id varchar(128), task_id varchar(128), source_revision integer,
           task_revision varchar(96), source_content_digest char(64),
           executor_type varchar(32), plan_schema varchar(64), plan_json jsonb,
           content_digest char(64), created_at_ms bigint
         )`,
      [JSON.stringify(executions)],
    );
    requireRowCount(executionInsert.rowCount, executions.length);
  }

  const heads = applied.map(({ source, definition }) => ({
    task_id: definition.taskId,
    previous_revision: source.previousRevision,
    revision: definition.revision,
    updated_at_ms: definition.updatedAtMs,
  }));
  const headUpdate = await client.query(
    `UPDATE "ql3"."task_definitions" AS head
        SET current_revision = data.revision,
            updated_at_ms = data.updated_at_ms
       FROM jsonb_to_recordset($1::jsonb) AS data(
         task_id varchar(128), previous_revision integer,
         revision integer, updated_at_ms bigint
       )
      WHERE head.project_id = $2
        AND head.task_id = data.task_id
        AND head.current_revision = data.previous_revision`,
    [JSON.stringify(heads), projectId],
  );
  requireRowCount(headUpdate.rowCount, applied.length);

  const ledger = applied.map(
    ({ source, definition, execution, itemDigest }) => ({
      application_id: applicationId,
      ordinal: source.ordinal,
      project_id: projectId,
      task_id: source.taskId,
      previous_revision: source.previousRevision,
      previous_content_digest: source.previousContentDigest,
      mutation_id: source.mutationId,
      revision: definition.revision,
      content_digest: definition.contentDigest,
      execution_content_digest: execution?.contentDigest ?? null,
      item_digest: itemDigest,
    }),
  );
  const ledgerInsert = await client.query(
    `INSERT INTO "ql3"."cluster_legacy_env_migration_application_tasks" (
       application_id, ordinal, project_id, task_id, previous_revision,
       previous_content_digest, mutation_id, revision, content_digest,
       execution_content_digest, item_digest
     )
     SELECT application_id, ordinal, project_id, task_id, previous_revision,
            previous_content_digest, mutation_id, revision, content_digest,
            execution_content_digest, item_digest
       FROM jsonb_to_recordset($1::jsonb) AS data(
         application_id varchar(128), ordinal integer, project_id varchar(128),
         task_id varchar(128), previous_revision integer,
         previous_content_digest char(64), mutation_id uuid, revision integer,
         content_digest char(64), execution_content_digest char(64),
         item_digest char(64)
       )`,
    [JSON.stringify(ledger)],
  );
  requireRowCount(ledgerInsert.rowCount, applied.length);
}

async function insertTriggerBatch(
  client: PostgresClient,
  applicationId: string,
  projectId: string,
  committedAtMs: number,
  batch: readonly ClusterLegacyEnvMigrationTriggerMutation[],
): Promise<void> {
  const ids = batch.map((item) => item.triggerId);
  const loaded = await client.query<Row>(
    `SELECT ${TRIGGER_SELECT_FIELDS},
            schedule.trigger_revision AS "scheduleRevision",
            migrated.revision AS "migratedTaskRevision",
            migrated.content_digest AS "migratedTaskContentDigest"
       FROM "ql3"."triggers" AS head
       JOIN "ql3"."trigger_revisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.trigger_id = head.trigger_id
        AND revision.revision = head.current_revision
       JOIN "ql3"."trigger_schedules" AS schedule
         ON schedule.project_id = head.project_id
        AND schedule.trigger_id = head.trigger_id
       JOIN "ql3"."cluster_legacy_env_migration_application_tasks" AS migrated
         ON migrated.application_id = $3
        AND migrated.project_id = head.project_id
        AND migrated.task_id = revision.task_id
      WHERE head.project_id = $1 AND head.trigger_id = ANY($2::varchar[])
      FOR UPDATE OF head, schedule`,
    [projectId, ids, applicationId],
  );
  if (loaded.rows.length !== batch.length) throw conflict();
  const rowsByTriggerId = indexRowsByStringId(loaded.rows, 'triggerId');

  const semanticRegistry = createBuiltInTriggerSpecSemanticRegistry();
  const applied: AppliedTrigger[] = [];
  for (const source of batch) {
    const row = rowsByTriggerId.get(source.triggerId);
    if (row === undefined) throw conflict();
    const current = triggerRecord(row);
    const migratedTaskRevision = postgresRequiredInteger(
      row.migratedTaskRevision,
      unavailable,
    );
    const migratedTaskContentDigest = postgresRequiredString(
      row.migratedTaskContentDigest,
      unavailable,
    );
    if (
      current.projectId !== projectId ||
      current.triggerId !== source.triggerId ||
      current.taskId !== source.taskId ||
      current.revision !== source.previousRevision ||
      current.contentDigest !== source.previousContentDigest ||
      current.taskRevision !== source.previousTaskRevision ||
      current.taskContentDigest !== source.previousTaskContentDigest ||
      postgresRequiredInteger(row.scheduleRevision, unavailable) !==
        current.revision ||
      committedAtMs < current.updatedAtMs
    ) {
      throw conflict();
    }
    let trigger: Readonly<TriggerRecord>;
    try {
      const spec = semanticRegistry.normalize({
        projectId,
        triggerId: current.triggerId,
        taskId: current.taskId,
        taskRevision: migratedTaskRevision,
        spec: current.spec,
      });
      trigger = createTriggerRecord(
        {
          projectId,
          triggerId: current.triggerId,
          expectedRevision: current.revision,
          mutationId: source.mutationId,
          taskId: current.taskId,
          taskRevision: migratedTaskRevision,
          taskContentDigest: migratedTaskContentDigest,
          spec,
          enabled: current.enabled,
          occurredAtMs: committedAtMs,
        },
        current.createdAtMs,
      );
    } catch {
      throw conflict();
    }
    applied.push({
      source,
      trigger,
      itemDigest: triggerItemDigest(applicationId, source, trigger),
    });
  }

  const revisions = applied.map(({ trigger }) => ({
    project_id: trigger.projectId,
    trigger_id: trigger.triggerId,
    revision: trigger.revision,
    mutation_id: trigger.mutationId,
    task_id: trigger.taskId,
    task_revision: trigger.taskRevision,
    task_content_digest: trigger.taskContentDigest,
    spec_json: trigger.spec,
    enabled: trigger.enabled,
    content_digest: trigger.contentDigest,
    created_at_ms: trigger.updatedAtMs,
  }));
  const revisionInsert = await client.query(
    `INSERT INTO "ql3"."trigger_revisions" (
       project_id, trigger_id, revision, mutation_id, task_id, task_revision,
       task_content_digest, spec_json, enabled, content_digest, created_at_ms
     )
     SELECT project_id, trigger_id, revision, mutation_id, task_id,
            task_revision, task_content_digest, spec_json, enabled,
            content_digest, created_at_ms
       FROM jsonb_to_recordset($1::jsonb) AS data(
         project_id varchar(128), trigger_id varchar(128), revision integer,
         mutation_id uuid, task_id varchar(128), task_revision integer,
         task_content_digest char(64), spec_json jsonb, enabled boolean,
         content_digest char(64), created_at_ms bigint
       )`,
    [JSON.stringify(revisions)],
  );
  requireRowCount(revisionInsert.rowCount, applied.length);

  const schedules = applied.map(({ source, trigger }) => ({
    trigger_id: trigger.triggerId,
    previous_revision: source.previousRevision,
    revision: trigger.revision,
    updated_at_ms: trigger.updatedAtMs,
  }));
  const scheduleUpdate = await client.query(
    `UPDATE "ql3"."trigger_schedules" AS schedule
        SET trigger_revision = data.revision,
            next_fire_at_ms = NULL,
            last_scheduled_at_ms = NULL,
            state_version = schedule.state_version + 1,
            claim_owner = NULL,
            claim_token = NULL,
            claim_version = schedule.claim_version + 1,
            claim_expires_at_ms = NULL,
            updated_at_ms = data.updated_at_ms
       FROM jsonb_to_recordset($1::jsonb) AS data(
         trigger_id varchar(128), previous_revision integer,
         revision integer, updated_at_ms bigint
       )
      WHERE schedule.project_id = $2
        AND schedule.trigger_id = data.trigger_id
        AND schedule.trigger_revision = data.previous_revision`,
    [JSON.stringify(schedules), projectId],
  );
  requireRowCount(scheduleUpdate.rowCount, applied.length);

  const heads = applied.map(({ source, trigger }) => ({
    trigger_id: trigger.triggerId,
    task_id: trigger.taskId,
    previous_revision: source.previousRevision,
    revision: trigger.revision,
    updated_at_ms: trigger.updatedAtMs,
  }));
  const headUpdate = await client.query(
    `UPDATE "ql3"."triggers" AS head
        SET current_revision = data.revision,
            updated_at_ms = data.updated_at_ms
       FROM jsonb_to_recordset($1::jsonb) AS data(
         trigger_id varchar(128), task_id varchar(128),
         previous_revision integer, revision integer, updated_at_ms bigint
       )
      WHERE head.project_id = $2
        AND head.trigger_id = data.trigger_id
        AND head.task_id = data.task_id
        AND head.current_revision = data.previous_revision`,
    [JSON.stringify(heads), projectId],
  );
  requireRowCount(headUpdate.rowCount, applied.length);

  const ledger = applied.map(({ source, trigger, itemDigest }) => ({
    application_id: applicationId,
    ordinal: source.ordinal,
    project_id: projectId,
    trigger_id: source.triggerId,
    task_id: source.taskId,
    previous_revision: source.previousRevision,
    previous_content_digest: source.previousContentDigest,
    previous_task_revision: source.previousTaskRevision,
    previous_task_content_digest: source.previousTaskContentDigest,
    mutation_id: source.mutationId,
    revision: trigger.revision,
    content_digest: trigger.contentDigest,
    task_revision: trigger.taskRevision,
    task_content_digest: trigger.taskContentDigest,
    item_digest: itemDigest,
  }));
  const ledgerInsert = await client.query(
    `INSERT INTO "ql3"."cluster_legacy_env_migration_application_triggers" (
       application_id, ordinal, project_id, trigger_id, task_id,
       previous_revision, previous_content_digest, previous_task_revision,
       previous_task_content_digest, mutation_id, revision, content_digest,
       task_revision, task_content_digest, item_digest
     )
     SELECT application_id, ordinal, project_id, trigger_id, task_id,
            previous_revision, previous_content_digest, previous_task_revision,
            previous_task_content_digest, mutation_id, revision, content_digest,
            task_revision, task_content_digest, item_digest
       FROM jsonb_to_recordset($1::jsonb) AS data(
         application_id varchar(128), ordinal integer, project_id varchar(128),
         trigger_id varchar(128), task_id varchar(128),
         previous_revision integer, previous_content_digest char(64),
         previous_task_revision integer, previous_task_content_digest char(64),
         mutation_id uuid, revision integer, content_digest char(64),
         task_revision integer, task_content_digest char(64), item_digest char(64)
       )`,
    [JSON.stringify(ledger)],
  );
  requireRowCount(ledgerInsert.rowCount, applied.length);
}

async function assertReplayCurrent(
  client: PostgresClient,
  receipt: ClusterLegacyEnvMigrationApplicationReceipt,
): Promise<void> {
  const tasks = await client.query<Row>(
    `SELECT count(*) AS "totalCount",
            count(*) FILTER (WHERE
              head.current_revision = ledger.revision AND
              revision.mutation_id = ledger.mutation_id AND
              revision.content_digest = ledger.content_digest AND
              ((ledger.execution_content_digest IS NULL AND execution.project_id IS NULL) OR
               (ledger.execution_content_digest IS NOT NULL AND
                execution.content_digest = ledger.execution_content_digest))
            ) AS "validCount",
            min(ledger.ordinal) AS "minimumOrdinal",
            max(ledger.ordinal) AS "maximumOrdinal"
       FROM "ql3"."cluster_legacy_env_migration_application_tasks" AS ledger
       LEFT JOIN "ql3"."task_definitions" AS head
         ON head.project_id = ledger.project_id AND head.task_id = ledger.task_id
       LEFT JOIN "ql3"."task_definition_revisions" AS revision
         ON revision.project_id = ledger.project_id
        AND revision.task_id = ledger.task_id
        AND revision.revision = ledger.revision
       LEFT JOIN "ql3"."task_execution_revisions" AS execution
         ON execution.project_id = ledger.project_id
        AND execution.task_id = ledger.task_id
        AND execution.source_revision = ledger.revision
        AND execution.executor_type = 'remote_worker'
      WHERE ledger.application_id = $1`,
    [receipt.applicationId],
  );
  if (tasks.rows.length !== 1) throw unavailable();
  const taskRow = tasks.rows[0]!;
  if (
    postgresRequiredInteger(taskRow.totalCount, unavailable) !==
      receipt.taskCount ||
    postgresRequiredInteger(taskRow.validCount, unavailable) !==
      receipt.taskCount ||
    postgresRequiredInteger(taskRow.minimumOrdinal, unavailable) !== 0 ||
    postgresRequiredInteger(taskRow.maximumOrdinal, unavailable) !==
      receipt.taskCount - 1
  ) {
    throw conflict();
  }

  const triggers = await client.query<Row>(
    `SELECT count(*) AS "totalCount",
            count(*) FILTER (WHERE
              head.current_revision = ledger.revision AND
              revision.mutation_id = ledger.mutation_id AND
              revision.content_digest = ledger.content_digest AND
              revision.task_revision = ledger.task_revision AND
              revision.task_content_digest = ledger.task_content_digest AND
              schedule.trigger_revision = ledger.revision
            ) AS "validCount",
            min(ledger.ordinal) AS "minimumOrdinal",
            max(ledger.ordinal) AS "maximumOrdinal"
       FROM "ql3"."cluster_legacy_env_migration_application_triggers" AS ledger
       LEFT JOIN "ql3"."triggers" AS head
         ON head.project_id = ledger.project_id
        AND head.trigger_id = ledger.trigger_id
       LEFT JOIN "ql3"."trigger_revisions" AS revision
         ON revision.project_id = ledger.project_id
        AND revision.trigger_id = ledger.trigger_id
        AND revision.revision = ledger.revision
       LEFT JOIN "ql3"."trigger_schedules" AS schedule
         ON schedule.project_id = ledger.project_id
        AND schedule.trigger_id = ledger.trigger_id
      WHERE ledger.application_id = $1`,
    [receipt.applicationId],
  );
  if (triggers.rows.length !== 1) throw unavailable();
  const triggerRow = triggers.rows[0]!;
  const triggerTotal = postgresRequiredInteger(
    triggerRow.totalCount,
    unavailable,
  );
  const triggerValid = postgresRequiredInteger(
    triggerRow.validCount,
    unavailable,
  );
  if (
    triggerTotal !== receipt.triggerCount ||
    triggerValid !== receipt.triggerCount ||
    (receipt.triggerCount === 0
      ? triggerRow.minimumOrdinal !== null || triggerRow.maximumOrdinal !== null
      : postgresRequiredInteger(triggerRow.minimumOrdinal, unavailable) !== 0 ||
        postgresRequiredInteger(triggerRow.maximumOrdinal, unavailable) !==
          receipt.triggerCount - 1)
  ) {
    throw conflict();
  }
}

function mappedError(error: unknown): Error {
  if (
    error instanceof InvalidClusterLegacyEnvMigrationApplicationError ||
    error instanceof ClusterLegacyEnvMigrationApplicationConflictError ||
    error instanceof ClusterLegacyEnvMigrationApplicationUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return conflict();
  }
  return unavailable();
}

/**
 * Automation-manager-only, bounded-memory application authority. Task and
 * Trigger heads, schedules, execution revisions and immutable receipts commit
 * in one Project-serialized PostgreSQL transaction.
 */
export class PostgresClusterLegacyEnvMigrationApplicationRepository
  implements ClusterLegacyEnvMigrationApplicationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Cluster Legacy Env migration application pool is invalid',
      );
    }
  }

  async findByApplicationId(
    applicationIdValue: string,
  ): Promise<Readonly<ClusterLegacyEnvMigrationApplicationReceipt> | null> {
    const applicationId = assertClusterLegacyEnvMigrationApplicationIdentifier(
      applicationIdValue,
      'applicationId',
    );
    try {
      return await findReceipt(this.pool, 'application_id', applicationId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async apply(
    intentValue: Readonly<ClusterLegacyEnvMigrationApplicationIntent>,
    streamsValue: Readonly<ClusterLegacyEnvMigrationMutationStreams>,
    transactionHook?: PostgresClusterLegacyEnvMigrationApplicationTransactionHook,
  ): Promise<
    Readonly<{
      status: 'applied' | 'existing';
      receipt: Readonly<ClusterLegacyEnvMigrationApplicationReceipt>;
    }>
  > {
    if (
      transactionHook !== undefined &&
      typeof transactionHook !== 'function'
    ) {
      throw invalid('transaction hook is invalid');
    }
    const intent =
      normalizeClusterLegacyEnvMigrationApplicationIntent(intentValue);
    const streams = normalizeStreams(streamsValue);

    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw unavailable();
      }
      let began = false;
      let transactionHookError: unknown;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [
            `qinglong/cluster-legacy-env-migration-application@v1:${intent.projectId}`,
          ],
        );

        const replay = await findReceipt(
          client,
          'mutation_id',
          intent.mutationId,
        );
        if (replay) {
          if (
            !clusterLegacyEnvMigrationApplicationReceiptMatchesIntent(
              replay,
              intent,
            )
          ) {
            throw conflict();
          }
          await assertReplayCurrent(client, replay);
          if (transactionHook) {
            try {
              const hookResult = await transactionHook(
                client,
                Object.freeze({ intent, replay, receipt: replay }),
              );
              if (hookResult !== undefined) {
                throw invalid('transaction hook must not return a value');
              }
            } catch (error) {
              transactionHookError = error;
              throw error;
            }
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', receipt: replay });
        }

        const occupied = await findReceipt(
          client,
          'application_id',
          intent.applicationId,
        );
        if (occupied) throw conflict();
        const project = await client.query<{ status: unknown }>(
          `SELECT status FROM "ql3"."projects" WHERE id = $1`,
          [intent.projectId],
        );
        if (project.rows.length !== 1 || project.rows[0]?.status !== 'active') {
          throw conflict();
        }
        const plan = await loadPlan(client, intent);
        const clock = await client.query<{ committedAtMs: unknown }>(
          `SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint AS "committedAtMs"`,
        );
        if (clock.rows.length !== 1) throw unavailable();
        const committedAtMs = postgresRequiredInteger(
          clock.rows[0]?.committedAtMs,
          unavailable,
        );
        const receipt = createClusterLegacyEnvMigrationApplicationReceipt({
          applicationId: intent.applicationId,
          mutationId: intent.mutationId,
          projectId: intent.projectId,
          planId: intent.planId,
          planDigest: intent.planDigest,
          environmentBundleRef: plan.target.secretRef,
          taskRevisionSetDigest: plan.target.taskRevisionSetDigest,
          triggerRevisionSetDigest: plan.target.triggerRevisionSetDigest,
          taskMutationSetDigest: intent.taskMutationSetDigest,
          triggerMutationSetDigest: intent.triggerMutationSetDigest,
          taskCount: plan.target.taskCount,
          triggerCount: plan.target.triggerCount,
          committedAtMs,
        });
        await client.query(
          `INSERT INTO "ql3"."cluster_legacy_env_migration_application_receipts" (
             application_id, mutation_id, project_id, plan_id, plan_digest,
             environment_bundle_ref, task_revision_set_digest,
             trigger_revision_set_digest, task_mutation_set_digest,
             trigger_mutation_set_digest, task_count, trigger_count,
             committed_at_ms, receipt_digest, receipt_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15::jsonb
           )`,
          [
            receipt.applicationId,
            receipt.mutationId,
            receipt.projectId,
            receipt.planId,
            receipt.planDigest,
            receipt.environmentBundleRef,
            receipt.taskRevisionSetDigest,
            receipt.triggerRevisionSetDigest,
            receipt.taskMutationSetDigest,
            receipt.triggerMutationSetDigest,
            receipt.taskCount,
            receipt.triggerCount,
            receipt.committedAtMs,
            receipt.receiptDigest,
            JSON.stringify(receipt),
          ],
        );

        const taskDigester =
          createClusterLegacyEnvMigrationTaskMutationSetDigester();
        let taskBatch: ClusterLegacyEnvMigrationTaskMutation[] = [];
        for await (const raw of mutationStream(
          streams.taskMutations,
          'Task mutation stream',
        )) {
          taskBatch.push(taskDigester.update(raw));
          if (taskBatch.length === APPLICATION_BATCH_SIZE) {
            await insertTaskBatch(
              client,
              receipt.applicationId,
              receipt.projectId,
              receipt.environmentBundleRef,
              receipt.committedAtMs,
              taskBatch,
            );
            taskBatch = [];
          }
        }
        if (taskBatch.length > 0) {
          await insertTaskBatch(
            client,
            receipt.applicationId,
            receipt.projectId,
            receipt.environmentBundleRef,
            receipt.committedAtMs,
            taskBatch,
          );
        }
        const taskSet = taskDigester.finish();
        if (
          taskSet.count !== receipt.taskCount ||
          taskSet.revisionSetDigest !== receipt.taskRevisionSetDigest ||
          taskSet.mutationSetDigest !== receipt.taskMutationSetDigest
        ) {
          throw conflict();
        }

        const triggerDigester =
          createClusterLegacyEnvMigrationTriggerMutationSetDigester();
        let triggerBatch: ClusterLegacyEnvMigrationTriggerMutation[] = [];
        for await (const raw of mutationStream(
          streams.triggerMutations,
          'Trigger mutation stream',
        )) {
          triggerBatch.push(triggerDigester.update(raw));
          if (triggerBatch.length === APPLICATION_BATCH_SIZE) {
            await insertTriggerBatch(
              client,
              receipt.applicationId,
              receipt.projectId,
              receipt.committedAtMs,
              triggerBatch,
            );
            triggerBatch = [];
          }
        }
        if (triggerBatch.length > 0) {
          await insertTriggerBatch(
            client,
            receipt.applicationId,
            receipt.projectId,
            receipt.committedAtMs,
            triggerBatch,
          );
        }
        const triggerSet = triggerDigester.finish();
        if (
          triggerSet.count !== receipt.triggerCount ||
          triggerSet.revisionSetDigest !== receipt.triggerRevisionSetDigest ||
          triggerSet.mutationSetDigest !== receipt.triggerMutationSetDigest
        ) {
          throw conflict();
        }

        if (transactionHook) {
          try {
            const hookResult = await transactionHook(
              client,
              Object.freeze({ intent, replay: null, receipt }),
            );
            if (hookResult !== undefined) {
              throw invalid('transaction hook must not return a value');
            }
          } catch (error) {
            transactionHookError = error;
            throw error;
          }
        }
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'applied', receipt });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (error === transactionHookError && error instanceof Error) {
          throw error;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
