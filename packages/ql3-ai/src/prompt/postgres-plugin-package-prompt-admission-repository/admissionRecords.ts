import type { PostgresClient, PostgresQueryable } from '@qinglong/runtime-core';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  createPluginPackagePromptAdmissionBundle,
  normalizePluginPackagePromptAdmissionReceipt,
  normalizePluginPackagePromptExecutionPlan,
  PluginPackagePromptAdmissionUnavailableError,
  type PluginPackagePromptAdmissionBundle,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptExecutionPlan,
} from '../pluginPackagePromptExecution';
import {
  boolean,
  integer,
  json,
  jsonObject,
  nullableInteger,
  nullableText,
  text,
  unavailable,
  type AdmissionColumn,
  type Row,
} from './authority';

const PROMPT_RUN_STATUSES = new Set([
  'running',
  'lost',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export type StoredAdmission = Readonly<{
  plan: Readonly<PluginPackagePromptExecutionPlan>;
  receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
}>;

async function admissionRows(
  queryable: PostgresQueryable,
  column: AdmissionColumn,
  value: string,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT request_id AS "requestId",
            invocation_id AS "invocationId",
            plan_digest AS "planDigest", run_id AS "runId",
            step_run_id AS "stepRunId", project_id AS "projectId",
            package_name AS "packageName",
            installation_id AS "installationId", lock_digest AS "lockDigest",
            generation, generation_digest AS "generationDigest",
            materialized_revision_digest AS "materializedRevisionDigest",
            publication_digest AS "publicationDigest",
            prompt_id AS "promptId",
            prompt_definition_digest AS "promptDefinitionDigest",
            parameter_digest AS "parameterDigest",
            model_request_digest AS "modelRequestDigest",
            admitted_at_ms AS "admittedAtMs",
            receipt_digest AS "receiptDigest", plan_json AS "planJson",
            receipt_json AS "receiptJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
     WHERE ${column} = $1 LIMIT 2`,
    [value],
  );
  return result.rows;
}

async function assertStoredEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): Promise<void> {
  const run = bundle.run;
  const storedRun = await queryable.query<Row>(
    `SELECT project_id AS "projectId", task_id AS "taskId",
            task_revision AS "taskRevision", task_name AS "taskName",
            task_snapshot_ref AS "taskSnapshotRef",
            trigger_type AS "triggerType",
            execution_origin AS "executionOrigin",
            execution_owner AS "executionOwner",
            triggered_by AS "triggeredBy", request_id AS "requestId",
            status, version, event_sequence AS "eventSequence", priority,
            idempotency_key AS "idempotencyKey",
            created_at_ms AS "createdAtMs",
            started_at_ms AS "startedAtMs"
     FROM "ql3"."runs" WHERE id = $1`,
    [run.id],
  );
  const row = storedRun.rows.length === 1 ? storedRun.rows[0]! : null;
  if (
    !row ||
    text(row, 'projectId') !== run.projectId ||
    text(row, 'taskId') !== run.taskId ||
    text(row, 'taskRevision') !== run.taskRevision ||
    nullableText(row, 'taskName') !== (run.taskName ?? null) ||
    nullableText(row, 'taskSnapshotRef') !== (run.taskSnapshotRef ?? null) ||
    text(row, 'triggerType') !== run.triggerType ||
    text(row, 'executionOrigin') !== run.executionOrigin ||
    text(row, 'executionOwner') !== run.executionOwner ||
    nullableText(row, 'triggeredBy') !== (run.triggeredBy ?? null) ||
    nullableText(row, 'requestId') !== (run.requestId ?? null) ||
    !PROMPT_RUN_STATUSES.has(text(row, 'status')) ||
    integer(row, 'version') < run.version ||
    integer(row, 'eventSequence') < run.eventSequence ||
    integer(row, 'version') !== integer(row, 'eventSequence') ||
    integer(row, 'priority') !== run.priority ||
    nullableText(row, 'idempotencyKey') !== (run.idempotencyKey ?? null) ||
    integer(row, 'createdAtMs') !== run.createdAtMs ||
    nullableInteger(row, 'startedAtMs') !== (run.startedAtMs ?? null)
  ) {
    throw unavailable();
  }

  const storedEvents = await queryable.query<Row>(
    `SELECT id, sequence, type, dedupe_key AS "dedupeKey",
            actor_type AS "actorType", actor_id AS "actorId",
            step_run_id AS "stepRunId", payload,
            created_at_ms AS "createdAtMs"
     FROM "ql3"."run_events"
     WHERE run_id = $1 AND sequence <= 2 ORDER BY sequence`,
    [run.id],
  );
  const expectedEvents = [bundle.admissionEvent, bundle.stepMutation.event];
  if (
    storedEvents.rows.length !== expectedEvents.length ||
    storedEvents.rows.some((eventRow, index) => {
      const expected = expectedEvents[index]!;
      return (
        text(eventRow, 'id') !== expected.id ||
        integer(eventRow, 'sequence') !== expected.sequence ||
        text(eventRow, 'type') !== expected.type ||
        nullableText(eventRow, 'dedupeKey') !== (expected.dedupeKey ?? null) ||
        text(eventRow, 'actorType') !== expected.actorType ||
        nullableText(eventRow, 'actorId') !== (expected.actorId ?? null) ||
        nullableText(eventRow, 'stepRunId') !== (expected.stepRunId ?? null) ||
        json(eventRow.payload) !== json(expected.payload) ||
        integer(eventRow, 'createdAtMs') !== expected.createdAtMs
      );
    })
  ) {
    throw unavailable();
  }

  const mutation = bundle.stepMutation;
  const stepResult = await queryable.query<Row>(
    `SELECT runtime.step_key AS "stepKey", runtime.kind,
            runtime.definition_ref AS "definitionRef",
            runtime.definition_digest AS "definitionDigest",
            runtime.required, runtime.status, runtime.version,
            runtime.last_mutation_id AS "lastMutationId",
            runtime.step_run_digest AS "stepRunDigest",
            runtime.step_run_json AS "stepRunJson",
            mutation.mutation_digest AS "mutationDigest",
            mutation.event_id AS "eventId",
            mutation.event_sequence AS "eventSequence",
            mutation.run_version AS "runVersion",
            mutation.step_run_digest AS "initialStepRunDigest",
            mutation.step_run_json AS "initialStepRunJson"
     FROM "ql3"."step_runs" AS runtime
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = $1
      AND mutation.run_id = runtime.run_id
      AND mutation.step_run_id = runtime.id
     WHERE runtime.run_id = $2 AND runtime.id = $3`,
    [mutation.mutationId, mutation.runId, mutation.stepRun.id],
  );
  const stepRow = stepResult.rows.length === 1 ? stepResult.rows[0]! : null;
  let current: Readonly<StepRunRecord> | null = null;
  if (stepRow) {
    try {
      current = normalizeStepRunRecord(
        jsonObject(stepRow.stepRunJson) as unknown as StepRunRecord,
      );
    } catch {
      throw unavailable();
    }
  }
  const initial = mutation.stepRun;
  if (
    !stepRow ||
    !current ||
    current.id !== initial.id ||
    current.runId !== initial.runId ||
    current.stepKey !== initial.stepKey ||
    current.kind !== 'model' ||
    current.definitionRef !== initial.definitionRef ||
    current.definitionDigest !== initial.definitionDigest ||
    current.required !== true ||
    current.version < initial.version ||
    text(stepRow, 'stepKey') !== current.stepKey ||
    text(stepRow, 'kind') !== current.kind ||
    text(stepRow, 'definitionRef') !== current.definitionRef ||
    text(stepRow, 'definitionDigest') !== current.definitionDigest ||
    boolean(stepRow, 'required') !== true ||
    text(stepRow, 'status') !== current.status ||
    integer(stepRow, 'version') !== current.version ||
    text(stepRow, 'lastMutationId') !== current.lastMutationId ||
    text(stepRow, 'stepRunDigest') !== current.stepRunDigest ||
    text(stepRow, 'mutationDigest') !== mutation.mutationDigest ||
    text(stepRow, 'eventId') !== mutation.event.id ||
    integer(stepRow, 'eventSequence') !== mutation.event.sequence ||
    integer(stepRow, 'runVersion') !== mutation.expectedRunVersion + 1 ||
    text(stepRow, 'initialStepRunDigest') !== initial.stepRunDigest ||
    json(stepRow.initialStepRunJson) !== json(initial)
  ) {
    throw unavailable();
  }
}

async function parseAdmission(
  queryable: PostgresQueryable,
  row: Row,
): Promise<StoredAdmission> {
  try {
    const plan = normalizePluginPackagePromptExecutionPlan(
      jsonObject(row.planJson) as unknown as PluginPackagePromptExecutionPlan,
    );
    const receipt = normalizePluginPackagePromptAdmissionReceipt(
      jsonObject(
        row.receiptJson,
      ) as unknown as PluginPackagePromptAdmissionReceipt,
    );
    const bundle = createPluginPackagePromptAdmissionBundle(plan);
    const target = plan.target;
    if (
      plan.requestId !== text(row, 'requestId') ||
      plan.invocationId !== text(row, 'invocationId') ||
      plan.planDigest !== text(row, 'planDigest') ||
      plan.runId !== text(row, 'runId') ||
      plan.stepRunId !== text(row, 'stepRunId') ||
      target.projectId !== text(row, 'projectId') ||
      target.packageName !== text(row, 'packageName') ||
      target.installationId !== text(row, 'installationId') ||
      target.lockDigest !== text(row, 'lockDigest') ||
      target.generation !== integer(row, 'generation') ||
      target.generationDigest !== text(row, 'generationDigest') ||
      target.materializedRevisionDigest !==
        text(row, 'materializedRevisionDigest') ||
      target.publicationDigest !== text(row, 'publicationDigest') ||
      target.promptId !== text(row, 'promptId') ||
      target.promptDefinitionDigest !== text(row, 'promptDefinitionDigest') ||
      plan.parameterDigest !== text(row, 'parameterDigest') ||
      plan.modelRequestDigest !== text(row, 'modelRequestDigest') ||
      receipt.admittedAtMs !== integer(row, 'admittedAtMs') ||
      receipt.receiptDigest !== text(row, 'receiptDigest') ||
      json(bundle.receipt) !== json(receipt)
    ) {
      throw unavailable();
    }
    await assertStoredEvidence(queryable, bundle);
    return Object.freeze({ plan, receipt });
  } catch (error) {
    if (error instanceof PluginPackagePromptAdmissionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

export async function findAdmission(
  queryable: PostgresQueryable,
  column: AdmissionColumn,
  value: string,
): Promise<StoredAdmission | null> {
  const rows = await admissionRows(queryable, column, value);
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseAdmission(queryable, rows[0]) : null;
}

export async function insertRun(
  client: PostgresClient,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): Promise<void> {
  const run = bundle.run;
  await client.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, task_name,
       task_snapshot_ref, trigger_type, execution_origin, execution_owner,
       triggered_by, request_id, status, version, event_sequence, priority,
       idempotency_key, created_at_ms, started_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18
     )`,
    [
      run.id,
      run.projectId,
      run.taskId,
      run.taskRevision,
      run.taskName ?? null,
      run.taskSnapshotRef ?? null,
      run.triggerType,
      run.executionOrigin,
      run.executionOwner,
      run.triggeredBy ?? null,
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

export async function insertEvent(
  client: PostgresClient,
  event: Readonly<PluginPackagePromptAdmissionBundle['admissionEvent']>,
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

export async function insertStepEvidence(
  client: PostgresClient,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): Promise<void> {
  const mutation = bundle.stepMutation;
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

export async function insertAdmission(
  client: PostgresClient,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): Promise<void> {
  const { plan, receipt } = bundle;
  const target = plan.target;
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions" (
       request_id, invocation_id, plan_digest, run_id, step_run_id,
       project_id, package_name, installation_id, lock_digest, generation,
       generation_digest, materialized_revision_digest, publication_digest,
       prompt_id, prompt_definition_digest, parameter_digest,
       model_request_digest, admitted_at_ms, receipt_digest, plan_json,
       receipt_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb
     )`,
    [
      plan.requestId,
      plan.invocationId,
      plan.planDigest,
      plan.runId,
      plan.stepRunId,
      target.projectId,
      target.packageName,
      target.installationId,
      target.lockDigest,
      target.generation,
      target.generationDigest,
      target.materializedRevisionDigest,
      target.publicationDigest,
      target.promptId,
      target.promptDefinitionDigest,
      plan.parameterDigest,
      plan.modelRequestDigest,
      receipt.admittedAtMs,
      receipt.receiptDigest,
      json(plan),
      json(receipt),
    ],
  );
}
