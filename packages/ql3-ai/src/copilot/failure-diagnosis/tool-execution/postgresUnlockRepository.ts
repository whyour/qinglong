import { isDeepStrictEqual } from 'node:util';

import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  normalizeToolExecutionCompletionRecord,
  type ToolExecutionCompletionRecord,
} from '@qinglong/runtime-core/tool-execution-completion';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../../migration/modelInvocationMigration';
import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import {
  CopilotFailureDiagnosisToolExecutionConflictError,
  CopilotFailureDiagnosisToolExecutionUnavailableError,
  type CopilotFailureDiagnosisToolUnlockCommand,
  type CopilotFailureDiagnosisToolUnlockReceipt,
  type CopilotFailureDiagnosisToolUnlockRepository,
} from './contracts';
import {
  normalizeCopilotFailureDiagnosisToolUnlockCommand,
  normalizeCopilotFailureDiagnosisToolUnlockReceipt,
} from './unlockProtocol';

const UNLOCK_TABLE = 'copilot_failure_diagnosis_tool_unlocks';
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;

type Row = Readonly<Record<string, unknown>>;

function unavailable(
  cause?: unknown,
): CopilotFailureDiagnosisToolExecutionUnavailableError {
  return new CopilotFailureDiagnosisToolExecutionUnavailableError({
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
    error instanceof CopilotFailureDiagnosisToolExecutionConflictError ||
    error instanceof CopilotFailureDiagnosisToolExecutionUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514'].includes(sqlState(error) ?? '')) {
    return new CopilotFailureDiagnosisToolExecutionConflictError(
      'a durable Tool unlock identity is already bound',
    );
  }
  return unavailable(error);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw unavailable();
  return value;
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

function same(left: unknown, right: unknown): boolean {
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

type StoredUnlock = Readonly<{
  receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
  commandDigest: string;
}>;

const UNLOCK_SELECT = `
  unlock.request_id AS "requestId",
  unlock.plan_digest AS "planDigest",
  unlock.start_id AS "startId",
  unlock.tool_completion_digest AS "toolCompletionDigest",
  unlock.model_step_run_id AS "modelStepRunId",
  unlock.model_step_run_version AS "modelStepRunVersion",
  unlock.model_step_run_digest AS "modelStepRunDigest",
  unlock.model_mutation_id AS "modelMutationId",
  unlock.model_mutation_digest AS "modelMutationDigest",
  unlock.model_event_id AS "modelEventId",
  unlock.final_run_version AS "finalRunVersion",
  unlock.final_run_event_sequence AS "finalRunEventSequence",
  unlock.unlocked_at_ms AS "unlockedAtMs",
  unlock.receipt_digest AS "receiptDigest",
  unlock.command_digest AS "commandDigest",
  unlock.receipt_json AS "receiptJson",
  admission.plan_digest AS "joinedPlanDigest",
  completion.completion_digest AS "joinedCompletionDigest",
  mutation.mutation_digest AS "joinedMutationDigest",
  mutation.step_run_digest AS "joinedModelStepRunDigest",
  mutation.event_id AS "joinedEventId",
  mutation.event_sequence AS "joinedEventSequence",
  mutation.run_version AS "joinedRunVersion"`;

async function findRows(
  queryable: PostgresQueryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${UNLOCK_SELECT}
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${UNLOCK_TABLE}" AS unlock
     JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}".
       "copilot_failure_diagnosis_admissions" AS admission
       ON admission.request_id = unlock.request_id
     JOIN "ql3"."tool_execution_completions" AS completion
       ON completion.start_id = unlock.start_id
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = unlock.model_mutation_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

function storedUnlock(row: Row): StoredUnlock {
  let receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
  try {
    receipt = normalizeCopilotFailureDiagnosisToolUnlockReceipt(
      jsonObject(
        row.receiptJson,
      ) as unknown as CopilotFailureDiagnosisToolUnlockReceipt,
    );
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    text(row, 'requestId') !== receipt.requestId ||
    text(row, 'planDigest') !== receipt.planDigest ||
    text(row, 'startId') !== receipt.startId ||
    text(row, 'toolCompletionDigest') !== receipt.toolCompletionDigest ||
    text(row, 'modelStepRunId') !== receipt.modelStepRunId ||
    integer(row, 'modelStepRunVersion') !== receipt.modelStepRunVersion ||
    text(row, 'modelStepRunDigest') !== receipt.modelStepRunDigest ||
    text(row, 'modelMutationId') !== receipt.modelMutationId ||
    text(row, 'modelMutationDigest') !== receipt.modelMutationDigest ||
    text(row, 'modelEventId') !== receipt.modelEventId ||
    integer(row, 'finalRunVersion') !== receipt.finalRunVersion ||
    integer(row, 'finalRunEventSequence') !== receipt.finalRunEventSequence ||
    integer(row, 'unlockedAtMs') !== receipt.unlockedAtMs ||
    text(row, 'receiptDigest') !== receipt.receiptDigest ||
    text(row, 'joinedPlanDigest') !== receipt.planDigest ||
    text(row, 'joinedCompletionDigest') !== receipt.toolCompletionDigest ||
    text(row, 'joinedMutationDigest') !== receipt.modelMutationDigest ||
    text(row, 'joinedModelStepRunDigest') !== receipt.modelStepRunDigest ||
    text(row, 'joinedEventId') !== receipt.modelEventId ||
    integer(row, 'joinedEventSequence') !== receipt.finalRunEventSequence ||
    integer(row, 'joinedRunVersion') !== receipt.finalRunVersion
  ) {
    throw unavailable();
  }
  return Object.freeze({
    receipt,
    commandDigest: text(row, 'commandDigest'),
  });
}

async function updateModelStepRun(
  client: PostgresClient,
  command: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Promise<void> {
  const mutation = command.modelStepRunMutation;
  const step = mutation.stepRun;
  const result = await client.query(
    `UPDATE "ql3"."step_runs"
     SET status = $1, version = $2, attempt_count = $3,
         output_ref = $4, approval_request_id = $5, ready_at_ms = $6,
         started_at_ms = $7, finished_at_ms = $8, result_code = $9,
         error_summary = $10, updated_at_ms = $11,
         last_mutation_id = $12, step_run_digest = $13,
         step_run_json = $14::jsonb
     WHERE id = $15 AND run_id = $16 AND version = $17
       AND step_run_digest = $18 AND status = $19`,
    [
      step.status,
      step.version,
      step.attemptCount,
      step.outputRef,
      step.approvalRequestId,
      step.readyAtMs,
      step.startedAtMs,
      step.finishedAtMs,
      step.resultCode,
      step.errorSummary,
      step.updatedAtMs,
      step.lastMutationId,
      step.stepRunDigest,
      JSON.stringify(step),
      step.id,
      step.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    ],
  );
  if (result.rowCount !== 1) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the Model StepRun unlock fence changed',
    );
  }
}

async function updateRun(
  client: PostgresClient,
  command: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Promise<void> {
  const mutation = command.modelStepRunMutation;
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET version = version + 1, event_sequence = event_sequence + 1
     WHERE id = $1 AND status = 'running'
       AND version = $2 AND event_sequence = $3`,
    [
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    ],
  );
  if (result.rowCount !== 1) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the diagnosis Run unlock fence changed',
    );
  }
}

async function insertEventAndMutation(
  client: PostgresClient,
  command: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Promise<void> {
  const mutation = command.modelStepRunMutation;
  const event = mutation.event;
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
      event.dedupeKey,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    ],
  );
  await client.query(
    `INSERT INTO "ql3"."step_run_mutations" (
       mutation_id, mutation_digest, run_id, step_run_id,
       step_run_digest, event_id, event_sequence, run_version,
       step_run_json, committed_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
     )`,
    [
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
    ],
  );
}

async function insertUnlock(
  client: PostgresClient,
  command: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Promise<void> {
  const receipt = command.receipt;
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${UNLOCK_TABLE}" (
       request_id, plan_digest, run_id, start_id, tool_step_run_id,
       tool_completion_digest,
       model_step_run_id, model_step_run_version, model_step_run_digest,
       model_mutation_id, model_mutation_digest, model_event_id,
       final_run_version, final_run_event_sequence, unlocked_at_ms,
       receipt_digest, command_digest, receipt_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb
     )`,
    [
      receipt.requestId,
      receipt.planDigest,
      receipt.runId,
      receipt.startId,
      receipt.toolStepRunId,
      receipt.toolCompletionDigest,
      receipt.modelStepRunId,
      receipt.modelStepRunVersion,
      receipt.modelStepRunDigest,
      receipt.modelMutationId,
      receipt.modelMutationDigest,
      receipt.modelEventId,
      receipt.finalRunVersion,
      receipt.finalRunEventSequence,
      receipt.unlockedAtMs,
      receipt.receiptDigest,
      command.commandDigest,
      JSON.stringify(receipt),
    ],
  );
}

async function currentEvidence(
  client: PostgresClient,
  command: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Promise<void> {
  const mutation = command.modelStepRunMutation;
  const result = await client.query<Row>(
    `SELECT admission.plan_json AS "planJson",
            completion.completion_json AS "completionJson",
            model_step.kind AS "modelKind",
            model_step.status AS "modelStatus",
            model_step.version AS "modelVersion",
            model_step.step_run_digest AS "modelDigest",
            run.project_id AS "projectId", run.status AS "runStatus",
            run.version AS "runVersion",
            run.event_sequence AS "runEventSequence"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}".
       "copilot_failure_diagnosis_admissions" AS admission
     JOIN "ql3"."tool_execution_completions" AS completion
       ON completion.start_id = $2
      AND completion.run_id = admission.run_id
      AND completion.step_run_id = admission.tool_step_run_id
     JOIN "ql3"."step_runs" AS model_step
       ON model_step.run_id = admission.run_id
      AND model_step.id = admission.model_step_run_id
     JOIN "ql3"."runs" AS run ON run.id = admission.run_id
     WHERE admission.request_id = $1
     LIMIT 2
     FOR UPDATE OF model_step, run`,
    [command.plan.requestId, command.completion.startId],
  );
  const row = result.rows[0];
  let plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  let completion: Readonly<ToolExecutionCompletionRecord>;
  try {
    plan = row
      ? normalizeCopilotFailureDiagnosisExecutionPlan(
          jsonObject(
            row.planJson,
          ) as unknown as CopilotFailureDiagnosisExecutionPlan,
        )
      : command.plan;
    completion = row
      ? normalizeToolExecutionCompletionRecord(
          jsonObject(
            row.completionJson,
          ) as unknown as ToolExecutionCompletionRecord,
        )
      : command.completion;
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    result.rows.length !== 1 ||
    !row ||
    !same(plan, command.plan) ||
    !same(completion, command.completion) ||
    text(row, 'modelKind') !== 'model' ||
    text(row, 'modelStatus') !== mutation.previousStatus ||
    integer(row, 'modelVersion') !== mutation.expectedStepRunVersion ||
    text(row, 'modelDigest') !== mutation.expectedStepRunDigest ||
    text(row, 'projectId') !== command.plan.projectId ||
    text(row, 'runStatus') !== 'running' ||
    integer(row, 'runVersion') !== mutation.expectedRunVersion ||
    integer(row, 'runEventSequence') !== mutation.expectedRunEventSequence
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the admitted Tool completion or Model StepRun fence changed',
    );
  }
}

export class PostgresCopilotFailureDiagnosisToolUnlockRepository
  implements CopilotFailureDiagnosisToolUnlockRepository
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

  async findByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisToolUnlockReceipt> | null> {
    if (
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)
    ) {
      throw new TypeError('Tool unlock request id is invalid');
    }
    try {
      const rows = await findRows(this.pool, 'unlock.request_id = $1', [
        requestId,
      ]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? storedUnlock(rows[0]).receipt : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async commit(commandValue: CopilotFailureDiagnosisToolUnlockCommand): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
    }>
  > {
    const command =
      normalizeCopilotFailureDiagnosisToolUnlockCommand(commandValue);
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (cause) {
        throw unavailable(cause);
      }
      let began = false;
      try {
        await begin(client);
        began = true;
        const existingRows = await findRows(
          client,
          `unlock.request_id = $1
           OR unlock.tool_completion_digest = $2
           OR unlock.model_mutation_id = $3
           OR unlock.model_event_id = $4`,
          [
            command.receipt.requestId,
            command.receipt.toolCompletionDigest,
            command.receipt.modelMutationId,
            command.receipt.modelEventId,
          ],
        );
        if (existingRows.length > 1) {
          throw new CopilotFailureDiagnosisToolExecutionConflictError();
        }
        if (existingRows[0]) {
          const stored = storedUnlock(existingRows[0]);
          if (
            stored.commandDigest !== command.commandDigest ||
            !same(stored.receipt, command.receipt)
          ) {
            throw new CopilotFailureDiagnosisToolExecutionConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            receipt: stored.receipt,
          });
        }

        await currentEvidence(client, command);
        await updateModelStepRun(client, command);
        await updateRun(client, command);
        await insertEventAndMutation(client, command);
        await insertUnlock(client, command);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt: command.receipt,
        });
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
}
