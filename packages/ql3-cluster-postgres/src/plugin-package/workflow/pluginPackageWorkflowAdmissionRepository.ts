// PostgreSQL authority for atomic Plugin Package Workflow admission.
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageWorkflowAdministrationMutationError,
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  PluginPackageWorkflowAdministrationMutationConflictError,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import {
  normalizePluginPackageAutomationPublication,
  type PluginPackageAutomationPublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  createPluginPackageWorkflowAdmissionBundle,
  InvalidPluginPackageWorkflowExecutionPlanError,
  normalizePluginPackageWorkflowAdmissionReceipt,
  normalizePluginPackageWorkflowExecutionPlan,
  pluginPackageWorkflowDefinitionDigest,
  PluginPackageWorkflowAdmissionConflictError,
  PluginPackageWorkflowAdmissionNotAllowedError,
  PluginPackageWorkflowAdmissionUnavailableError,
  type PluginPackageWorkflowAdmissionBundle,
  type PluginPackageWorkflowAdmissionReceipt,
  type PluginPackageWorkflowAdmissionRepository,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import {
  configurePostgresDefinitionTransaction,
  postgresRequiredJsonObject,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_RUN_STATUSES = new Set([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function unavailable(
  cause?: unknown,
): PluginPackageWorkflowAdmissionUnavailableError {
  return new PluginPackageWorkflowAdmissionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackageWorkflowExecutionPlanError(
      `${label} is invalid`,
    );
  }
  return value;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageWorkflowAdministrationMutationError ||
    error instanceof
      PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
    error instanceof PluginPackageWorkflowAdministrationMutationConflictError ||
    error instanceof InvalidPluginPackageWorkflowExecutionPlanError ||
    error instanceof PluginPackageWorkflowAdmissionConflictError ||
    error instanceof PluginPackageWorkflowAdmissionNotAllowedError ||
    error instanceof PluginPackageWorkflowAdmissionUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514'].includes(postgresSqlState(error) ?? '')) {
    return new PluginPackageWorkflowAdmissionConflictError(
      'durable Run, plan, StepRun, event, or receipt identity changed',
    );
  }
  return unavailable(error);
}

export interface PostgresPluginPackageWorkflowAdmissionTransactionContext {
  readonly client: PostgresClient;
  readonly replay: boolean;
  readonly plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  readonly receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
}

export type PostgresPluginPackageWorkflowAdmissionTransactionGuard = (
  context: Readonly<PostgresPluginPackageWorkflowAdmissionTransactionContext>,
) => void | Promise<void>;

function json(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => json(entry ?? null)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(record[key])}`)
      .join(',')}}`;
  }
  throw unavailable();
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

function optionalInteger(row: Row, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return integer(row, key);
}

function exactArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseStored(row: Row): Readonly<{
  plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>;
}> {
  try {
    const plan = normalizePluginPackageWorkflowExecutionPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as PluginPackageWorkflowExecutionPlan,
    );
    const receipt = normalizePluginPackageWorkflowAdmissionReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as PluginPackageWorkflowAdmissionReceipt,
    );
    const bundle = createPluginPackageWorkflowAdmissionBundle(plan);
    if (
      plan.planDigest !== text(row, 'planDigest') ||
      plan.planId !== text(row, 'planId') ||
      plan.runId !== text(row, 'runId') ||
      plan.target.projectId !== text(row, 'projectId') ||
      plan.target.packageName !== text(row, 'packageName') ||
      plan.target.installationId !== text(row, 'installationId') ||
      plan.target.lockDigest !== text(row, 'lockDigest') ||
      plan.target.generation !== integer(row, 'generation') ||
      plan.target.generationDigest !== text(row, 'generationDigest') ||
      plan.target.materializedRevisionDigest !==
        text(row, 'materializedRevisionDigest') ||
      plan.target.publicationDigest !== text(row, 'publicationDigest') ||
      plan.target.workflowId !== text(row, 'workflowId') ||
      plan.target.workflowDefinitionDigest !==
        text(row, 'workflowDefinitionDigest') ||
      plan.steps.length !== integer(row, 'stepCount') ||
      receipt.admittedAtMs !== integer(row, 'admittedAtMs') ||
      receipt.finalRunVersion !== integer(row, 'finalRunVersion') ||
      receipt.finalRunEventSequence !== integer(row, 'finalRunEventSequence') ||
      receipt.receiptDigest !== text(row, 'receiptDigest') ||
      json(bundle.receipt) !== json(receipt)
    ) {
      throw unavailable();
    }
    return Object.freeze({ plan, receipt, bundle });
  } catch (error) {
    if (error instanceof PluginPackageWorkflowAdmissionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

async function assertStoredEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): Promise<void> {
  const run = bundle.run;
  const storedRun = await queryable.query<Row>(
    `SELECT project_id AS "projectId", task_id AS "taskId",
            task_revision AS "taskRevision",
            task_snapshot_ref AS "taskSnapshotRef",
            trigger_type AS "triggerType",
            execution_origin AS "executionOrigin",
            execution_owner AS "executionOwner",
            request_id AS "requestId", status, version,
            event_sequence AS "eventSequence", priority,
            idempotency_key AS "idempotencyKey",
            created_at_ms AS "createdAtMs",
            started_at_ms AS "startedAtMs"
     FROM "ql3"."runs" WHERE id = $1`,
    [run.id],
  );
  const runRow = storedRun.rows.length === 1 ? storedRun.rows[0]! : null;
  const storedRunVersion = runRow ? integer(runRow, 'version') : -1;
  const storedEventSequence = runRow ? integer(runRow, 'eventSequence') : -1;
  if (
    !runRow ||
    text(runRow, 'projectId') !== run.projectId ||
    text(runRow, 'taskId') !== run.taskId ||
    text(runRow, 'taskRevision') !== run.taskRevision ||
    optionalText(runRow, 'taskSnapshotRef') !== run.taskSnapshotRef ||
    text(runRow, 'triggerType') !== run.triggerType ||
    text(runRow, 'executionOrigin') !== run.executionOrigin ||
    text(runRow, 'executionOwner') !== run.executionOwner ||
    optionalText(runRow, 'requestId') !== run.requestId ||
    !WORKFLOW_RUN_STATUSES.has(text(runRow, 'status')) ||
    storedRunVersion < run.version ||
    storedEventSequence < run.eventSequence ||
    storedRunVersion !== storedEventSequence ||
    integer(runRow, 'priority') !== run.priority ||
    optionalText(runRow, 'idempotencyKey') !== run.idempotencyKey ||
    integer(runRow, 'createdAtMs') !== run.createdAtMs ||
    optionalInteger(runRow, 'startedAtMs') !== run.startedAtMs
  ) {
    throw unavailable();
  }

  const storedEvents = await queryable.query<Row>(
    `SELECT id, sequence, type, dedupe_key AS "dedupeKey",
            actor_type AS "actorType", actor_id AS "actorId",
            step_run_id AS "stepRunId", payload,
            created_at_ms AS "createdAtMs"
     FROM "ql3"."run_events"
     WHERE run_id = $1 AND sequence <= $2
     ORDER BY sequence`,
    [run.id, bundle.receipt.finalRunEventSequence],
  );
  const expectedEvents = [
    bundle.admissionEvent,
    ...bundle.stepMutations.map(({ event }) => event),
  ];
  if (
    storedEvents.rows.length !== expectedEvents.length ||
    storedEvents.rows.some((row, index) => {
      const event = expectedEvents[index]!;
      return (
        text(row, 'id') !== event.id ||
        integer(row, 'sequence') !== event.sequence ||
        text(row, 'type') !== event.type ||
        optionalText(row, 'dedupeKey') !== event.dedupeKey ||
        text(row, 'actorType') !== event.actorType ||
        optionalText(row, 'actorId') !== event.actorId ||
        optionalText(row, 'stepRunId') !== event.stepRunId ||
        json(row.payload) !== json(event.payload) ||
        integer(row, 'createdAtMs') !== event.createdAtMs
      );
    })
  ) {
    throw unavailable();
  }

  for (const mutation of bundle.stepMutations) {
    const stored = await queryable.query<Row>(
      `SELECT
         admission_step.step_run_id AS "stepRunId",
         admission_step.task_id AS "taskId",
         admission_step.task_definition_ref AS "taskDefinitionRef",
         admission_step.task_definition_digest AS "taskDefinitionDigest",
         admission_step.needs_json AS "needsJson",
         admission_step.initial_status AS "initialStatus",
         admission_step.mutation_id AS "mutationId",
         admission_step.event_id AS "eventId",
         runtime.step_key AS "currentStepKey",
         runtime.kind AS "currentKind",
         runtime.definition_ref AS "currentDefinitionRef",
         runtime.definition_digest AS "currentDefinitionDigest",
         runtime.required AS "currentRequired",
         runtime.status AS "currentStatus",
         runtime.version AS "currentVersion",
         runtime.last_mutation_id AS "currentLastMutationId",
         runtime.step_run_digest AS "currentStepRunDigest",
         runtime.step_run_json AS "currentStepRunJson",
         mutation.mutation_digest AS "mutationDigest",
         mutation.event_sequence AS "eventSequence",
         mutation.run_version AS "runVersion",
         mutation.step_run_digest AS "initialStepRunDigest",
         mutation.step_run_json AS "initialStepRunJson"
       FROM "ql3"."plugin_package_workflow_admission_steps"
         AS admission_step
       JOIN "ql3"."step_runs" AS runtime
         ON runtime.run_id = admission_step.run_id
        AND runtime.id = admission_step.step_run_id
       JOIN "ql3"."step_run_mutations" AS mutation
         ON mutation.mutation_id = admission_step.mutation_id
       WHERE admission_step.plan_digest = $1
         AND admission_step.step_key = $2`,
      [bundle.plan.planDigest, mutation.stepRun.stepKey],
    );
    const row = stored.rows.length === 1 ? stored.rows[0]! : null;
    const planStep = bundle.plan.steps.find(
      ({ stepKey }) => stepKey === mutation.stepRun.stepKey,
    );
    let currentStepRun: Readonly<StepRunRecord> | null = null;
    if (row) {
      try {
        currentStepRun = normalizeStepRunRecord(
          postgresRequiredJsonObject(
            row.currentStepRunJson,
            unavailable,
          ) as unknown as StepRunRecord,
        );
      } catch {
        throw unavailable();
      }
    }
    if (
      !row ||
      !planStep ||
      !currentStepRun ||
      text(row, 'stepRunId') !== mutation.stepRun.id ||
      text(row, 'taskId') !== planStep.taskId ||
      text(row, 'taskDefinitionRef') !== planStep.taskDefinitionRef ||
      text(row, 'taskDefinitionDigest') !== planStep.taskDefinitionDigest ||
      json(row.needsJson) !== json(planStep.needs) ||
      text(row, 'initialStatus') !== planStep.initialStatus ||
      text(row, 'mutationId') !== mutation.mutationId ||
      text(row, 'eventId') !== mutation.event.id ||
      text(row, 'mutationDigest') !== mutation.mutationDigest ||
      integer(row, 'eventSequence') !== mutation.event.sequence ||
      integer(row, 'runVersion') !== mutation.expectedRunVersion + 1 ||
      text(row, 'initialStepRunDigest') !== mutation.stepRun.stepRunDigest ||
      json(row.initialStepRunJson) !== json(mutation.stepRun) ||
      currentStepRun.id !== mutation.stepRun.id ||
      currentStepRun.runId !== mutation.runId ||
      currentStepRun.stepKey !== planStep.stepKey ||
      currentStepRun.kind !== 'task' ||
      currentStepRun.definitionRef !== planStep.taskDefinitionRef ||
      currentStepRun.definitionDigest !== planStep.taskDefinitionDigest ||
      currentStepRun.required !== planStep.required ||
      currentStepRun.version < mutation.stepRun.version ||
      text(row, 'currentStepKey') !== currentStepRun.stepKey ||
      text(row, 'currentKind') !== currentStepRun.kind ||
      text(row, 'currentDefinitionRef') !== currentStepRun.definitionRef ||
      text(row, 'currentDefinitionDigest') !==
        currentStepRun.definitionDigest ||
      row.currentRequired !== currentStepRun.required ||
      text(row, 'currentStatus') !== currentStepRun.status ||
      integer(row, 'currentVersion') !== currentStepRun.version ||
      text(row, 'currentLastMutationId') !== currentStepRun.lastMutationId ||
      text(row, 'currentStepRunDigest') !== currentStepRun.stepRunDigest
    ) {
      throw unavailable();
    }
  }
}

async function findStored(
  queryable: PostgresQueryable,
  column: 'plan_id' | 'run_id',
  value: string,
): Promise<ReturnType<typeof parseStored> | null> {
  const result = await queryable.query<Row>(
    `SELECT
       plan_digest AS "planDigest", plan_id AS "planId",
       run_id AS "runId", project_id AS "projectId",
       package_name AS "packageName",
       installation_id AS "installationId",
       lock_digest AS "lockDigest", generation,
       generation_digest AS "generationDigest",
       materialized_revision_digest AS "materializedRevisionDigest",
       publication_digest AS "publicationDigest",
       workflow_id AS "workflowId",
       workflow_definition_digest AS "workflowDefinitionDigest",
       step_count AS "stepCount", admitted_at_ms AS "admittedAtMs",
       final_run_version AS "finalRunVersion",
       final_run_event_sequence AS "finalRunEventSequence",
       receipt_digest AS "receiptDigest",
       plan_json AS "planJson", receipt_json AS "receiptJson"
     FROM "ql3"."plugin_package_workflow_admissions"
     WHERE ${column} = $1
     LIMIT 2`,
    [value],
  );
  if (result.rows.length > 1) throw unavailable();
  if (!result.rows[0]) return null;
  const stored = parseStored(result.rows[0]);
  await assertStoredEvidence(queryable, stored.bundle);
  return stored;
}

function assertSnapshot(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  row: Row,
): void {
  let publication: Readonly<PluginPackageAutomationPublication>;
  let resources: unknown;
  try {
    publication = normalizePluginPackageAutomationPublication(
      postgresRequiredJsonObject(
        row.publicationJson,
        unavailable,
      ) as unknown as PluginPackageAutomationPublication,
    );
    resources = postgresRequiredJsonObject(
      row.revisionJson,
      unavailable,
    ).resources;
  } catch (error) {
    throw unavailable(error);
  }
  if (!Array.isArray(resources)) throw unavailable();
  const target = plan.target;
  const workflow = publication.definitions.workflows.find(
    ({ id }) => id === target.workflowId,
  );
  if (
    publication.publicationDigest !== target.publicationDigest ||
    publication.target.projectId !== target.projectId ||
    publication.target.packageName !== target.packageName ||
    publication.target.installationId !== target.installationId ||
    publication.target.lockDigest !== target.lockDigest ||
    publication.target.generation !== target.generation ||
    publication.target.generationDigest !== target.generationDigest ||
    publication.target.materializedRevisionDigest !==
      target.materializedRevisionDigest ||
    publication.state !== 'active' ||
    !workflow ||
    !workflow.enabled ||
    pluginPackageWorkflowDefinitionDigest(workflow) !==
      target.workflowDefinitionDigest ||
    workflow.steps.length !== plan.steps.length
  ) {
    throw new PluginPackageWorkflowAdmissionConflictError(
      'the exact Workflow publication drifted',
    );
  }
  for (const step of plan.steps) {
    const workflowStep = workflow.steps.find(({ id }) => id === step.stepKey);
    const matches = resources.filter((resource) => {
      if (!resource || typeof resource !== 'object') return false;
      const candidate = resource as {
        kind?: unknown;
        sourceDigest?: unknown;
        value?: { id?: unknown; enabled?: unknown };
      };
      return (
        candidate.kind === 'task' &&
        candidate.sourceDigest === step.taskDefinitionDigest &&
        candidate.value?.id === step.taskId &&
        candidate.value.enabled === true
      );
    });
    if (
      !workflowStep ||
      workflowStep.task !== step.taskId ||
      !exactArray(workflowStep.needs, step.needs) ||
      step.initialStatus !==
        (workflowStep.needs.length === 0 ? 'ready' : 'pending') ||
      step.taskDefinitionRef !==
        `plugin-package:${target.materializedRevisionDigest}:task:${step.taskId}` ||
      matches.length !== 1
    ) {
      throw new PluginPackageWorkflowAdmissionConflictError(
        'the exact Workflow step or Task evidence drifted',
      );
    }
  }
}

async function insertRun(
  client: PostgresClient,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): Promise<void> {
  const run = bundle.run;
  await client.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, task_snapshot_ref,
       trigger_type, execution_origin, execution_owner, request_id,
       status, version, event_sequence, priority, idempotency_key,
       created_at_ms, started_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16
     )`,
    [
      run.id,
      run.projectId,
      run.taskId,
      run.taskRevision,
      run.taskSnapshotRef ?? null,
      run.triggerType,
      run.executionOrigin,
      run.executionOwner,
      run.requestId ?? null,
      run.status,
      run.version,
      run.eventSequence,
      run.priority,
      run.idempotencyKey ?? null,
      run.createdAtMs,
      run.startedAtMs ?? null,
    ],
  );
}

async function insertEvent(
  client: PostgresClient,
  event: Readonly<PluginPackageWorkflowAdmissionBundle['admissionEvent']>,
  stepRunId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."run_events" (
       id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
       attempt_id, step_run_id, payload, created_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10)`,
    [
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey ?? null,
      event.actorType,
      event.actorId ?? null,
      stepRunId,
      json(event.payload),
      event.createdAtMs,
    ],
  );
}

async function insertStepEvidence(
  client: PostgresClient,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): Promise<void> {
  for (const mutation of bundle.stepMutations) {
    const step = mutation.stepRun;
    await client.query(
      `INSERT INTO "ql3"."step_runs" (
         id, run_id, parent_step_run_id, step_key, kind, definition_ref,
         definition_digest, required, status, version, attempt_count,
         input_ref, output_ref, approval_request_id, ready_at_ms,
         started_at_ms, finished_at_ms, result_code, error_summary,
         created_at_ms, updated_at_ms, last_mutation_id, step_run_digest,
         step_run_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
       )`,
      [
        step.id,
        step.runId,
        step.parentStepRunId,
        step.stepKey,
        step.kind,
        step.definitionRef,
        step.definitionDigest,
        step.required,
        step.status,
        step.version,
        step.attemptCount,
        step.inputRef,
        step.outputRef,
        step.approvalRequestId,
        step.readyAtMs,
        step.startedAtMs,
        step.finishedAtMs,
        step.resultCode,
        step.errorSummary,
        step.createdAtMs,
        step.updatedAtMs,
        step.lastMutationId,
        step.stepRunDigest,
        json(step),
      ],
    );
    await insertEvent(client, mutation.event, step.id);
    await client.query(
      `INSERT INTO "ql3"."step_run_mutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        mutation.mutationId,
        mutation.mutationDigest,
        mutation.runId,
        step.id,
        step.stepRunDigest,
        mutation.event.id,
        mutation.event.sequence,
        mutation.expectedRunVersion + 1,
        json(step),
        bundle.receipt.admittedAtMs,
      ],
    );
  }
}

async function insertAdmission(
  client: PostgresClient,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): Promise<void> {
  const { plan, receipt } = bundle;
  const target = plan.target;
  await client.query(
    `INSERT INTO "ql3"."plugin_package_workflow_admissions" (
       plan_digest, plan_id, run_id, project_id, package_name,
       installation_id, lock_digest, generation, generation_digest,
       materialized_revision_digest, publication_digest, workflow_id,
       workflow_definition_digest, step_count, admitted_at_ms,
       final_run_version, final_run_event_sequence, receipt_digest,
       plan_json, receipt_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19::jsonb, $20::jsonb
     )`,
    [
      plan.planDigest,
      plan.planId,
      plan.runId,
      target.projectId,
      target.packageName,
      target.installationId,
      target.lockDigest,
      target.generation,
      target.generationDigest,
      target.materializedRevisionDigest,
      target.publicationDigest,
      target.workflowId,
      target.workflowDefinitionDigest,
      plan.steps.length,
      receipt.admittedAtMs,
      receipt.finalRunVersion,
      receipt.finalRunEventSequence,
      receipt.receiptDigest,
      json(plan),
      json(receipt),
    ],
  );
  for (const step of plan.steps) {
    const mutation = bundle.stepMutations.find(
      ({ stepRun }) => stepRun.stepKey === step.stepKey,
    );
    if (!mutation) throw unavailable();
    await client.query(
      `INSERT INTO "ql3"."plugin_package_workflow_admission_steps" (
         plan_digest, run_id, step_key, step_run_id, task_id,
         task_definition_ref, task_definition_digest, needs_json,
         initial_status, mutation_id, event_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
       )`,
      [
        plan.planDigest,
        plan.runId,
        step.stepKey,
        step.stepRunId,
        step.taskId,
        step.taskDefinitionRef,
        step.taskDefinitionDigest,
        json(step.needs),
        step.initialStatus,
        mutation.mutationId,
        mutation.event.id,
      ],
    );
  }
}

export class PostgresPluginPackageWorkflowAdmissionRepository
  implements PluginPackageWorkflowAdmissionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async findByPlanId(
    planIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null> {
    const planId = identity(planIdValue, 'planId');
    try {
      return (await findStored(this.pool, 'plan_id', planId))?.receipt ?? null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByRunId(
    runIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null> {
    const runId = identity(runIdValue, 'runId');
    try {
      return (await findStored(this.pool, 'run_id', runId))?.receipt ?? null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findPlanByPlanId(
    planIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowExecutionPlan> | null> {
    const planId = identity(planIdValue, 'planId');
    try {
      return (await findStored(this.pool, 'plan_id', planId))?.plan ?? null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async admit(
    planValue: Readonly<PluginPackageWorkflowExecutionPlan>,
    transactionGuard?: PostgresPluginPackageWorkflowAdmissionTransactionGuard,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  > {
    if (
      transactionGuard !== undefined &&
      typeof transactionGuard !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowExecutionPlanError(
        'transaction guard is invalid',
      );
    }
    const plan = normalizePluginPackageWorkflowExecutionPlan(planValue);
    const bundle = createPluginPackageWorkflowAdmissionBundle(plan);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await configurePostgresDefinitionTransaction(client);
      began = true;
      const existing = await findStored(client, 'plan_id', plan.planId);
      if (existing) {
        if (
          existing.plan.planDigest !== plan.planDigest ||
          json(existing.plan) !== json(plan)
        ) {
          throw new PluginPackageWorkflowAdmissionConflictError(
            'planId is already bound to another plan',
          );
        }
        await transactionGuard?.(
          Object.freeze({
            client,
            replay: true,
            plan: existing.plan,
            receipt: existing.receipt,
          }),
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'existing' as const,
          receipt: existing.receipt,
        });
      }
      await transactionGuard?.(
        Object.freeze({
          client,
          replay: false,
          plan,
          receipt: bundle.receipt,
        }),
      );
      const snapshot = await client.query<Row>(
        `SELECT publication_json AS "publicationJson",
                revision_json AS "revisionJson"
         FROM "ql3"."plugin_package_workflow_admission_snapshot"(
           $1, $2, $3
         )`,
        [
          plan.target.projectId,
          plan.target.packageName,
          plan.target.publicationDigest,
        ],
      );
      if (snapshot.rows.length === 0) {
        throw new PluginPackageWorkflowAdmissionNotAllowedError();
      }
      if (snapshot.rows.length !== 1) throw unavailable();
      assertSnapshot(plan, snapshot.rows[0]!);
      await insertRun(client, bundle);
      await insertEvent(client, bundle.admissionEvent, null);
      await insertStepEvidence(client, bundle);
      await insertAdmission(client, bundle);
      await client.query('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        receipt: bundle.receipt,
      });
    } catch (error) {
      if (client && began) await rollbackPostgresDefinitionTransaction(client);
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }
}
