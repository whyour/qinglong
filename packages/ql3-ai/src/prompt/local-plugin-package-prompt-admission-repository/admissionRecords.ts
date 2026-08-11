import type { DatabaseSync } from 'node:sqlite';

import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

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
  canonicalJson,
  integer,
  nullableText,
  text,
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

export function insertRun(
  client: DatabaseSync,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): void {
  const run = bundle.run;
  client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, task_name,
         task_snapshot_ref, trigger_type, execution_origin, execution_owner,
         triggered_by, request_id, status, version, event_sequence, priority,
         idempotency_key, created_at_ms, started_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertEvent(
  client: DatabaseSync,
  event: Readonly<PluginPackagePromptAdmissionBundle['admissionEvent']>,
  stepRunId: string | null,
): void {
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey ?? null,
      event.actorType,
      event.actorId ?? null,
      stepRunId,
      canonicalJson(event.payload),
      event.createdAtMs,
    );
}

export function insertStepEvidence(
  client: DatabaseSync,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): void {
  const mutation = bundle.stepMutation;
  const step = mutation.stepRun;
  client
    .prepare(
      `INSERT INTO "StepRuns" (
         id, run_id, parent_step_run_id, step_key, kind, definition_ref,
         definition_digest, required, status, version, attempt_count,
         input_ref, output_ref, approval_request_id, ready_at_ms,
         started_at_ms, finished_at_ms, result_code, error_summary,
         created_at_ms, updated_at_ms, last_mutation_id, step_run_digest,
         step_run_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?
       )`,
    )
    .run(
      step.id,
      step.runId,
      step.parentStepRunId,
      step.stepKey,
      step.kind,
      step.definitionRef,
      step.definitionDigest,
      step.required ? 1 : 0,
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
      canonicalJson(step),
    );
  insertEvent(client, mutation.event, step.id);
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      step.id,
      step.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      canonicalJson(step),
      bundle.receipt.admittedAtMs,
    );
}

export function insertAdmission(
  client: DatabaseSync,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): void {
  const { plan, receipt } = bundle;
  const target = plan.target;
  client
    .prepare(
      `INSERT INTO "ModelInvocationPromptAdmissions" (
         request_id, invocation_id, plan_digest, run_id, step_run_id,
         project_id, package_name, installation_id, lock_digest, generation,
         generation_digest, materialized_revision_digest, publication_digest,
         prompt_id, prompt_definition_digest, parameter_digest,
         model_request_digest, admitted_at_ms, receipt_digest, plan_json,
         receipt_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
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
      canonicalJson(plan),
      canonicalJson(receipt),
    );
}

function selectAdmission(
  client: DatabaseSync,
  where: string,
  value: string,
): Row | undefined {
  return client
    .prepare(
      `SELECT
         request_id AS "requestId", invocation_id AS "invocationId",
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
       FROM "ModelInvocationPromptAdmissions"
       WHERE ${where} LIMIT 2`,
    )
    .get(value) as Row | undefined;
}

function assertStoredEvidence(
  client: DatabaseSync,
  bundle: Readonly<PluginPackagePromptAdmissionBundle>,
): void {
  const run = bundle.run;
  const row = client
    .prepare(
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
       FROM "Runs" WHERE id = ?`,
    )
    .get(run.id) as Row | undefined;
  if (
    !row ||
    text(row, 'projectId') !== run.projectId ||
    text(row, 'taskId') !== run.taskId ||
    text(row, 'taskRevision') !== run.taskRevision ||
    nullableText(row, 'taskName') !== run.taskName ||
    nullableText(row, 'taskSnapshotRef') !== run.taskSnapshotRef ||
    text(row, 'triggerType') !== run.triggerType ||
    text(row, 'executionOrigin') !== run.executionOrigin ||
    text(row, 'executionOwner') !== run.executionOwner ||
    nullableText(row, 'triggeredBy') !== run.triggeredBy ||
    nullableText(row, 'requestId') !== run.requestId ||
    !PROMPT_RUN_STATUSES.has(text(row, 'status')) ||
    integer(row, 'version') < run.version ||
    integer(row, 'eventSequence') < run.eventSequence ||
    integer(row, 'version') !== integer(row, 'eventSequence') ||
    integer(row, 'priority') !== run.priority ||
    nullableText(row, 'idempotencyKey') !== run.idempotencyKey ||
    integer(row, 'createdAtMs') !== run.createdAtMs ||
    integer(row, 'startedAtMs') !== run.startedAtMs
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }

  const events = client
    .prepare(
      `SELECT id, sequence, type, dedupe_key AS "dedupeKey",
              actor_type AS "actorType", actor_id AS "actorId",
              step_run_id AS "stepRunId", payload,
              created_at_ms AS "createdAtMs"
       FROM "RunEvents" WHERE run_id = ? AND sequence <= 2
       ORDER BY sequence`,
    )
    .all(run.id) as Row[];
  const expectedEvents = [bundle.admissionEvent, bundle.stepMutation.event];
  if (
    events.length !== expectedEvents.length ||
    events.some((eventRow, index) => {
      const expected = expectedEvents[index]!;
      return (
        text(eventRow, 'id') !== expected.id ||
        integer(eventRow, 'sequence') !== expected.sequence ||
        text(eventRow, 'type') !== expected.type ||
        nullableText(eventRow, 'dedupeKey') !== expected.dedupeKey ||
        text(eventRow, 'actorType') !== expected.actorType ||
        nullableText(eventRow, 'actorId') !== (expected.actorId ?? null) ||
        nullableText(eventRow, 'stepRunId') !== (expected.stepRunId ?? null) ||
        text(eventRow, 'payload') !== canonicalJson(expected.payload) ||
        integer(eventRow, 'createdAtMs') !== expected.createdAtMs
      );
    })
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }

  const mutation = bundle.stepMutation;
  const stepRow = client
    .prepare(
      `SELECT runtime.step_key AS "stepKey", runtime.kind,
              runtime.definition_ref AS "definitionRef",
              runtime.definition_digest AS "definitionDigest",
              runtime.required, runtime.status,
              runtime.version, runtime.last_mutation_id AS "lastMutationId",
              runtime.step_run_digest AS "stepRunDigest",
              runtime.step_run_json AS "stepRunJson",
              mutation.mutation_digest AS "mutationDigest",
              mutation.event_id AS "eventId",
              mutation.event_sequence AS "eventSequence",
              mutation.run_version AS "runVersion",
              mutation.step_run_digest AS "initialStepRunDigest",
              mutation.step_run_json AS "initialStepRunJson"
       FROM "StepRuns" AS runtime
       JOIN "StepRunMutations" AS mutation
         ON mutation.mutation_id = ?
        AND mutation.run_id = runtime.run_id
        AND mutation.step_run_id = runtime.id
       WHERE runtime.run_id = ? AND runtime.id = ?`,
    )
    .get(mutation.mutationId, mutation.runId, mutation.stepRun.id) as
    | Row
    | undefined;
  let current: Readonly<StepRunRecord> | null = null;
  if (stepRow) {
    try {
      current = normalizeStepRunRecord(
        JSON.parse(text(stepRow, 'stepRunJson')) as StepRunRecord,
      );
    } catch {
      throw new PluginPackagePromptAdmissionUnavailableError();
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
    integer(stepRow, 'required') !== 1 ||
    text(stepRow, 'status') !== current.status ||
    integer(stepRow, 'version') !== current.version ||
    text(stepRow, 'lastMutationId') !== current.lastMutationId ||
    text(stepRow, 'stepRunDigest') !== current.stepRunDigest ||
    text(stepRow, 'mutationDigest') !== mutation.mutationDigest ||
    text(stepRow, 'eventId') !== mutation.event.id ||
    integer(stepRow, 'eventSequence') !== mutation.event.sequence ||
    integer(stepRow, 'runVersion') !== mutation.expectedRunVersion + 1 ||
    text(stepRow, 'initialStepRunDigest') !== initial.stepRunDigest ||
    text(stepRow, 'initialStepRunJson') !== canonicalJson(initial)
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
}

function parseAdmission(client: DatabaseSync, row: Row): StoredAdmission {
  try {
    const plan = normalizePluginPackagePromptExecutionPlan(
      JSON.parse(text(row, 'planJson')) as PluginPackagePromptExecutionPlan,
    );
    const receipt = normalizePluginPackagePromptAdmissionReceipt(
      JSON.parse(
        text(row, 'receiptJson'),
      ) as PluginPackagePromptAdmissionReceipt,
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
      canonicalJson(bundle.receipt) !== canonicalJson(receipt)
    ) {
      throw new PluginPackagePromptAdmissionUnavailableError();
    }
    assertStoredEvidence(client, bundle);
    return Object.freeze({ plan, receipt });
  } catch (error) {
    if (error instanceof PluginPackagePromptAdmissionUnavailableError) {
      throw error;
    }
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
}

export function findAdmission(
  client: DatabaseSync,
  where: string,
  value: string,
): StoredAdmission | null {
  const row = selectAdmission(client, where, value);
  return row ? parseAdmission(client, row) : null;
}
