import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import { isDeepStrictEqual } from 'node:util';
import {
  normalizeStepRunRecord,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../../migration/modelInvocationMigration';
import {
  CopilotFailureDiagnosisAdmissionConflictError,
  CopilotFailureDiagnosisAdmissionNotAllowedError,
  CopilotFailureDiagnosisAdmissionUnavailableError,
  type CopilotFailureDiagnosisAdmissionBundle,
  type CopilotFailureDiagnosisAdmissionReceipt,
  type CopilotFailureDiagnosisAdmissionRepository,
  type CopilotFailureDiagnosisExecutionPlan,
} from './contracts';
import {
  createCopilotFailureDiagnosisAdmissionBundle,
  normalizeCopilotFailureDiagnosisAdmissionReceipt,
} from './durableEvidence';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from './plan';
import { identity } from './validation';

const ADMISSION_TABLE = 'copilot_failure_diagnosis_admissions';
const SOURCE_SNAPSHOT_FUNCTION =
  'copilot_failure_diagnosis_admission_source_snapshot';
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;
const DIAGNOSIS_RUN_STATUSES = new Set([
  'running',
  'lost',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

type Row = Readonly<Record<string, unknown>>;

export interface PostgresCopilotFailureDiagnosisAdmissionMutationGuard {
  confirm(
    input: Readonly<{
      client: PostgresClient;
      plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
      replay: boolean;
    }>,
  ): void | Promise<void>;
}

function unavailable(
  cause?: unknown,
): CopilotFailureDiagnosisAdmissionUnavailableError {
  return new CopilotFailureDiagnosisAdmissionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof CopilotFailureDiagnosisAdmissionConflictError ||
    error instanceof CopilotFailureDiagnosisAdmissionNotAllowedError ||
    error instanceof CopilotFailureDiagnosisAdmissionUnavailableError
  ) {
    return error;
  }
  if (sqlState(error) === '23505') {
    return new CopilotFailureDiagnosisAdmissionConflictError(
      'a durable diagnosis identity is already bound',
    );
  }
  return unavailable(error);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw unavailable();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return text(row, key);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

function boolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw unavailable();
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw unavailable(cause);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unavailable();
  }
  return parsed as Record<string, unknown>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function storedJsonEquals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5s',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['2s']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['5s'],
  );
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transaction failure.
  }
}

async function transaction<T>(
  pool: PostgresPool,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    let client: PostgresClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      throw unavailable(cause);
    }
    let began = false;
    try {
      await begin(client);
      began = true;
      const result = await work(client);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) await rollback(client);
      if (
        RETRYABLE_SQL_STATES.has(sqlState(error) ?? '') &&
        attempt + 1 < MAX_TRANSACTION_ATTEMPTS
      ) {
        continue;
      }
      throw mapStorageError(error);
    } finally {
      client.release();
    }
  }
  throw unavailable();
}

async function assertRunEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  const result = await queryable.query<Row>(
    `SELECT project_id AS "projectId", task_id AS "taskId",
            task_revision AS "taskRevision", task_name AS "taskName",
            task_snapshot_ref AS "taskSnapshotRef",
            parent_run_id AS "parentRunId", trigger_type AS "triggerType",
            execution_origin AS "executionOrigin",
            execution_owner AS "executionOwner",
            triggered_by AS "triggeredBy", request_id AS "requestId",
            status, version, event_sequence AS "eventSequence", priority,
            idempotency_key AS "idempotencyKey",
            created_at_ms AS "createdAtMs",
            started_at_ms AS "startedAtMs"
     FROM "ql3"."runs" WHERE id = $1`,
    [bundle.run.id],
  );
  const row = result.rows.length === 1 ? result.rows[0]! : null;
  const run = bundle.run;
  if (
    !row ||
    text(row, 'projectId') !== run.projectId ||
    text(row, 'taskId') !== run.taskId ||
    text(row, 'taskRevision') !== run.taskRevision ||
    nullableText(row, 'taskName') !== (run.taskName ?? null) ||
    nullableText(row, 'taskSnapshotRef') !== (run.taskSnapshotRef ?? null) ||
    nullableText(row, 'parentRunId') !== (run.parentRunId ?? null) ||
    text(row, 'triggerType') !== run.triggerType ||
    text(row, 'executionOrigin') !== run.executionOrigin ||
    text(row, 'executionOwner') !== run.executionOwner ||
    nullableText(row, 'triggeredBy') !== (run.triggeredBy ?? null) ||
    nullableText(row, 'requestId') !== (run.requestId ?? null) ||
    !DIAGNOSIS_RUN_STATUSES.has(text(row, 'status')) ||
    integer(row, 'version') < run.version ||
    integer(row, 'eventSequence') < run.eventSequence ||
    integer(row, 'version') !== integer(row, 'eventSequence') ||
    integer(row, 'priority') !== run.priority ||
    nullableText(row, 'idempotencyKey') !== (run.idempotencyKey ?? null) ||
    integer(row, 'createdAtMs') !== run.createdAtMs ||
    integer(row, 'startedAtMs') !== run.startedAtMs
  ) {
    throw unavailable();
  }
}

async function assertEventEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  const result = await queryable.query<Row>(
    `SELECT id, sequence, type, dedupe_key AS "dedupeKey",
            actor_type AS "actorType", actor_id AS "actorId",
            step_run_id AS "stepRunId", payload,
            created_at_ms AS "createdAtMs"
     FROM "ql3"."run_events"
     WHERE run_id = $1 AND sequence <= 3 ORDER BY sequence`,
    [bundle.run.id],
  );
  const expected = [
    bundle.admissionEvent,
    bundle.toolStepMutation.event,
    bundle.modelStepMutation.event,
  ];
  if (
    result.rows.length !== expected.length ||
    result.rows.some((row, index) => {
      const event = expected[index]!;
      return (
        text(row, 'id') !== event.id ||
        integer(row, 'sequence') !== event.sequence ||
        text(row, 'type') !== event.type ||
        nullableText(row, 'dedupeKey') !== (event.dedupeKey ?? null) ||
        text(row, 'actorType') !== event.actorType ||
        nullableText(row, 'actorId') !== (event.actorId ?? null) ||
        nullableText(row, 'stepRunId') !== (event.stepRunId ?? null) ||
        !storedJsonEquals(row.payload, event.payload) ||
        integer(row, 'createdAtMs') !== event.createdAtMs
      );
    })
  ) {
    throw unavailable();
  }
}

function assertStepRow(row: Row, mutation: Readonly<StepRunMutation>): void {
  let current: Readonly<StepRunRecord>;
  try {
    current = normalizeStepRunRecord(
      jsonObject(row.stepRunJson) as unknown as StepRunRecord,
    );
  } catch (cause) {
    throw unavailable(cause);
  }
  const initial = mutation.stepRun;
  if (
    current.id !== initial.id ||
    current.runId !== initial.runId ||
    current.parentStepRunId !== initial.parentStepRunId ||
    current.stepKey !== initial.stepKey ||
    current.kind !== initial.kind ||
    current.definitionRef !== initial.definitionRef ||
    current.definitionDigest !== initial.definitionDigest ||
    current.required !== true ||
    current.inputRef !== initial.inputRef ||
    current.createdAtMs !== initial.createdAtMs ||
    current.version < initial.version ||
    text(row, 'stepKey') !== current.stepKey ||
    text(row, 'kind') !== current.kind ||
    nullableText(row, 'parentStepRunId') !== current.parentStepRunId ||
    text(row, 'definitionRef') !== current.definitionRef ||
    text(row, 'definitionDigest') !== current.definitionDigest ||
    boolean(row, 'required') !== true ||
    text(row, 'status') !== current.status ||
    integer(row, 'version') !== current.version ||
    text(row, 'lastMutationId') !== current.lastMutationId ||
    text(row, 'stepRunDigest') !== current.stepRunDigest ||
    text(row, 'mutationId') !== mutation.mutationId ||
    text(row, 'mutationDigest') !== mutation.mutationDigest ||
    text(row, 'eventId') !== mutation.event.id ||
    integer(row, 'eventSequence') !== mutation.event.sequence ||
    integer(row, 'runVersion') !== mutation.expectedRunVersion + 1 ||
    text(row, 'initialStepRunDigest') !== initial.stepRunDigest ||
    !storedJsonEquals(row.initialStepRunJson, initial)
  ) {
    throw unavailable();
  }
}

async function assertStepEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  const tool = bundle.toolStepMutation;
  const model = bundle.modelStepMutation;
  const result = await queryable.query<Row>(
    `SELECT runtime.id, runtime.parent_step_run_id AS "parentStepRunId",
            runtime.step_key AS "stepKey", runtime.kind,
            runtime.definition_ref AS "definitionRef",
            runtime.definition_digest AS "definitionDigest",
            runtime.required, runtime.status, runtime.version,
            runtime.last_mutation_id AS "lastMutationId",
            runtime.step_run_digest AS "stepRunDigest",
            runtime.step_run_json AS "stepRunJson",
            mutation.mutation_id AS "mutationId",
            mutation.mutation_digest AS "mutationDigest",
            mutation.event_id AS "eventId",
            mutation.event_sequence AS "eventSequence",
            mutation.run_version AS "runVersion",
            mutation.step_run_digest AS "initialStepRunDigest",
            mutation.step_run_json AS "initialStepRunJson"
     FROM "ql3"."step_runs" AS runtime
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.run_id = runtime.run_id
      AND mutation.step_run_id = runtime.id
      AND mutation.mutation_id = CASE
        WHEN runtime.id = $2 THEN $4 ELSE $5 END
     WHERE runtime.run_id = $1 AND runtime.id IN ($2, $3)
     ORDER BY runtime.id`,
    [
      bundle.run.id,
      tool.stepRun.id,
      model.stepRun.id,
      tool.mutationId,
      model.mutationId,
    ],
  );
  if (result.rows.length !== 2) throw unavailable();
  const rows = new Map(result.rows.map((row) => [text(row, 'id'), row]));
  const toolRow = rows.get(tool.stepRun.id);
  const modelRow = rows.get(model.stepRun.id);
  if (!toolRow || !modelRow) throw unavailable();
  assertStepRow(toolRow, tool);
  assertStepRow(modelRow, model);
}

async function assertStoredEvidence(
  queryable: PostgresQueryable,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  await assertRunEvidence(queryable, bundle);
  await assertEventEvidence(queryable, bundle);
  await assertStepEvidence(queryable, bundle);
}

type StoredAdmission = Readonly<{
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
}>;

async function findStored(
  queryable: PostgresQueryable,
  requestId: string,
): Promise<StoredAdmission | null> {
  const result = await queryable.query<Row>(
    `SELECT request_id AS "requestId", plan_digest AS "planDigest",
            run_id AS "runId", project_id AS "projectId",
            source_run_id AS "sourceRunId",
            source_run_version AS "sourceRunVersion",
            source_run_status AS "sourceRunStatus",
            source_attempt_id AS "sourceAttemptId",
            source_attempt_status AS "sourceAttemptStatus",
            source_log_artifact_id AS "sourceLogArtifactId",
            tool_plan_digest AS "toolPlanDigest",
            tool_action_digest AS "toolActionDigest",
            tool_step_run_id AS "toolStepRunId",
            model_intent_digest AS "modelIntentDigest",
            model_step_run_id AS "modelStepRunId",
            admitted_at_ms AS "admittedAtMs",
            receipt_digest AS "receiptDigest",
            plan_json AS "planJson", receipt_json AS "receiptJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}"
     WHERE request_id = $1 LIMIT 2`,
    [requestId],
  );
  if (result.rows.length > 1) throw unavailable();
  const row = result.rows[0];
  if (!row) return null;
  try {
    const plan = normalizeCopilotFailureDiagnosisExecutionPlan(
      jsonObject(
        row.planJson,
      ) as unknown as CopilotFailureDiagnosisExecutionPlan,
    );
    const receipt = normalizeCopilotFailureDiagnosisAdmissionReceipt(
      jsonObject(
        row.receiptJson,
      ) as unknown as CopilotFailureDiagnosisAdmissionReceipt,
    );
    const bundle = createCopilotFailureDiagnosisAdmissionBundle(plan);
    if (
      text(row, 'requestId') !== plan.requestId ||
      text(row, 'planDigest') !== plan.planDigest ||
      text(row, 'runId') !== plan.runId ||
      text(row, 'projectId') !== plan.projectId ||
      text(row, 'sourceRunId') !== plan.source.runId ||
      integer(row, 'sourceRunVersion') !== plan.source.runVersion ||
      text(row, 'sourceRunStatus') !== plan.source.runStatus ||
      text(row, 'sourceAttemptId') !== plan.source.attemptId ||
      text(row, 'sourceAttemptStatus') !== plan.source.attemptStatus ||
      text(row, 'sourceLogArtifactId') !== plan.source.logArtifactId ||
      text(row, 'toolPlanDigest') !== plan.tool.planDigest ||
      text(row, 'toolActionDigest') !== plan.tool.actionDigest ||
      text(row, 'toolStepRunId') !== plan.toolStepRunId ||
      text(row, 'modelIntentDigest') !== plan.model.intentDigest ||
      text(row, 'modelStepRunId') !== plan.modelStepRunId ||
      integer(row, 'admittedAtMs') !== receipt.admittedAtMs ||
      text(row, 'receiptDigest') !== receipt.receiptDigest ||
      !storedJsonEquals(bundle.receipt, receipt)
    ) {
      throw unavailable();
    }
    await assertStoredEvidence(queryable, bundle);
    return Object.freeze({ plan, receipt });
  } catch (error) {
    if (error instanceof CopilotFailureDiagnosisAdmissionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

async function assertSourceSnapshot(
  client: PostgresClient,
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
): Promise<void> {
  const result = await client.query<Row>(
    `SELECT run_id AS "runId", run_version AS "runVersion",
            run_status AS "runStatus", attempt_id AS "attemptId",
            attempt_status AS "attemptStatus",
            attempt_finished_at_ms AS "attemptFinishedAtMs",
            log_artifact_id AS "logArtifactId"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${SOURCE_SNAPSHOT_FUNCTION}"(
       $1, $2, $3, $4, $5, $6, $7
     )`,
    [
      plan.projectId,
      plan.requestedBySubject.type,
      plan.requestedBySubject.id,
      plan.policyFence.projectVersion,
      plan.policyFence.bindingVersion,
      plan.source.runId,
      plan.source.attemptId,
    ],
  );
  const row = result.rows.length === 1 ? result.rows[0]! : null;
  if (!row) throw new CopilotFailureDiagnosisAdmissionNotAllowedError();
  const source = plan.source;
  if (
    text(row, 'runId') !== source.runId ||
    integer(row, 'runVersion') !== source.runVersion ||
    text(row, 'runStatus') !== source.runStatus ||
    text(row, 'attemptId') !== source.attemptId ||
    text(row, 'attemptStatus') !== source.attemptStatus ||
    integer(row, 'attemptFinishedAtMs') !== source.attemptFinishedAtMs ||
    text(row, 'logArtifactId') !== source.logArtifactId
  ) {
    throw new CopilotFailureDiagnosisAdmissionConflictError(
      'source Run or final Attempt changed',
    );
  }
}

async function insertRun(
  client: PostgresClient,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  const run = bundle.run;
  await client.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, task_name,
       task_snapshot_ref, parent_run_id, trigger_type, execution_origin,
       execution_owner, triggered_by, request_id, status, version,
       event_sequence, priority, idempotency_key, created_at_ms, started_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19
     )`,
    [
      run.id,
      run.projectId,
      run.taskId,
      run.taskRevision,
      run.taskName ?? null,
      run.taskSnapshotRef ?? null,
      run.parentRunId ?? null,
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

async function insertEvent(
  client: PostgresClient,
  event: Readonly<CopilotFailureDiagnosisAdmissionBundle['admissionEvent']>,
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
      event.stepRunId ?? null,
      json(event.payload),
      event.createdAtMs,
    ],
  );
}

async function insertStepEvidence(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
  admittedAtMs: number,
): Promise<void> {
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
  await insertEvent(client, mutation.event);
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
      admittedAtMs,
    ],
  );
}

async function insertAdmission(
  client: PostgresClient,
  bundle: Readonly<CopilotFailureDiagnosisAdmissionBundle>,
): Promise<void> {
  const { plan, receipt } = bundle;
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}" (
       request_id, plan_digest, run_id, project_id,
       source_run_id, source_run_version, source_run_status,
       source_attempt_id, source_attempt_status, source_log_artifact_id,
       tool_plan_digest, tool_action_digest, tool_step_run_id,
       model_intent_digest, model_step_run_id, admitted_at_ms,
       receipt_digest, plan_json, receipt_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18::jsonb, $19::jsonb
     )`,
    [
      plan.requestId,
      plan.planDigest,
      plan.runId,
      plan.projectId,
      plan.source.runId,
      plan.source.runVersion,
      plan.source.runStatus,
      plan.source.attemptId,
      plan.source.attemptStatus,
      plan.source.logArtifactId,
      plan.tool.planDigest,
      plan.tool.actionDigest,
      plan.toolStepRunId,
      plan.model.intentDigest,
      plan.modelStepRunId,
      receipt.admittedAtMs,
      receipt.receiptDigest,
      json(plan),
      json(receipt),
    ],
  );
}

export class PostgresCopilotFailureDiagnosisAdmissionRepository
  implements CopilotFailureDiagnosisAdmissionRepository
{
  readonly #pool: PostgresPool;
  readonly #mutationGuard:
    | PostgresCopilotFailureDiagnosisAdmissionMutationGuard
    | undefined;

  constructor(
    pool: PostgresPool,
    mutationGuard?: PostgresCopilotFailureDiagnosisAdmissionMutationGuard,
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      (mutationGuard !== undefined &&
        (!mutationGuard || typeof mutationGuard.confirm !== 'function'))
    ) {
      throw unavailable();
    }
    this.#pool = pool;
    this.#mutationGuard = mutationGuard;
  }

  async findByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<CopilotFailureDiagnosisAdmissionReceipt> | null> {
    const requestId = identity(requestIdValue, 'request id');
    try {
      return (await findStored(this.#pool, requestId))?.receipt ?? null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findPlanByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<CopilotFailureDiagnosisExecutionPlan> | null> {
    const requestId = identity(requestIdValue, 'request id');
    try {
      return (await findStored(this.#pool, requestId))?.plan ?? null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  admit(planValue: Readonly<CopilotFailureDiagnosisExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
    }>
  > {
    const plan = normalizeCopilotFailureDiagnosisExecutionPlan(planValue);
    return transaction(this.#pool, async (client) => {
      const existing = await findStored(client, plan.requestId);
      if (existing) {
        if (
          existing.plan.planDigest !== plan.planDigest ||
          !storedJsonEquals(existing.plan, plan)
        ) {
          throw new CopilotFailureDiagnosisAdmissionConflictError(
            'requestId is already bound to another diagnosis plan',
          );
        }
        await this.#mutationGuard?.confirm({ client, plan, replay: true });
        return Object.freeze({
          status: 'existing' as const,
          receipt: existing.receipt,
        });
      }
      await this.#mutationGuard?.confirm({ client, plan, replay: false });
      await assertSourceSnapshot(client, plan);
      const bundle = createCopilotFailureDiagnosisAdmissionBundle(plan);
      await insertRun(client, bundle);
      await insertEvent(client, bundle.admissionEvent);
      await insertStepEvidence(
        client,
        bundle.toolStepMutation,
        bundle.receipt.admittedAtMs,
      );
      await insertStepEvidence(
        client,
        bundle.modelStepMutation,
        bundle.receipt.admittedAtMs,
      );
      await insertAdmission(client, bundle);
      return Object.freeze({
        status: 'created' as const,
        receipt: bundle.receipt,
      });
    });
  }
}
