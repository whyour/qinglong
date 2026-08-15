import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS } from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import {
  normalizeStepRunMutation,
  normalizeStepRunRecord,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import {
  CopilotFailureDiagnosisPreModelTerminalizationConflictError,
  CopilotFailureDiagnosisPreModelTerminalizationUnavailableError,
  type CopilotFailureDiagnosisPreModelTerminalizationAuthority,
  type CopilotFailureDiagnosisPreModelTerminalizationCommand,
  type CopilotFailureDiagnosisPreModelTerminalizationReceipt,
  type CopilotFailureDiagnosisPreModelTerminalizationRepository,
} from './contracts';
import {
  normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand,
  normalizeCopilotFailureDiagnosisPreModelTerminalizationReceipt,
} from './protocol';

const TABLE = '"ql3_ai"."copilot_failure_diagnosis_pre_model_terminalizations"';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function conflict(message?: string): never {
  throw new CopilotFailureDiagnosisPreModelTerminalizationConflictError(
    message,
  );
}

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisPreModelTerminalizationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Mapped to the generic durable conflict below.
    }
  }
  return conflict();
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return conflict();
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : conflict();
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : string(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function authority(
  queryable: Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>,
  requestId: string,
  lock: boolean,
): Promise<Readonly<CopilotFailureDiagnosisPreModelTerminalizationAuthority>> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT admission.plan_json AS "planJson",
            run.id AS "runId", run.project_id AS "projectId",
            run.status AS "runStatus", run.version AS "runVersion",
            run.event_sequence AS "runEventSequence",
            run.cancel_requested_at_ms AS "cancelRequestedAtMs",
            run.cancel_reason AS "cancelReason",
            tool_step.step_run_json AS "toolStepJson",
            model_step.step_run_json AS "modelStepJson",
            (model_start.invocation_id IS NOT NULL) AS "modelStartExists",
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "observedAtMs"
       FROM "ql3_ai"."copilot_failure_diagnosis_admissions" AS admission
       JOIN "ql3"."runs" AS run ON run.id = admission.run_id
       JOIN "ql3"."step_runs" AS tool_step
         ON tool_step.run_id = run.id
        AND tool_step.id = admission.tool_step_run_id
       JOIN "ql3"."step_runs" AS model_step
         ON model_step.run_id = run.id
        AND model_step.id = admission.model_step_run_id
       LEFT JOIN "ql3_ai"."model_invocation_starts" AS model_start
         ON model_start.invocation_id = admission.plan_json->>'modelInvocationId'
      WHERE admission.request_id = $1
      ${lock ? 'FOR UPDATE OF run, tool_step, model_step' : ''}`,
    [requestId],
  );
  if (result.rows.length !== 1)
    return conflict('terminalization authority is absent');
  const row = result.rows[0]!;
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan(
    object(row.planJson) as unknown as CopilotFailureDiagnosisExecutionPlan,
  );
  const toolStep = normalizeStepRunRecord(
    object(row.toolStepJson) as unknown as StepRunRecord,
  );
  const modelStep = normalizeStepRunRecord(
    object(row.modelStepJson) as unknown as StepRunRecord,
  );
  return Object.freeze({
    plan,
    run: Object.freeze({
      id: string(row.runId),
      projectId: string(row.projectId),
      status: string(row.runStatus) as never,
      version: integer(row.runVersion),
      eventSequence: integer(row.runEventSequence),
      ...(row.cancelRequestedAtMs === null
        ? {}
        : { cancelRequestedAtMs: integer(row.cancelRequestedAtMs) }),
      ...(row.cancelReason === null
        ? {}
        : { cancelReason: string(row.cancelReason) as never }),
    }),
    toolStep,
    modelStep,
    modelStartExists: row.modelStartExists === true,
    observedAtMs: integer(row.observedAtMs),
  });
}

async function updateStep(
  client: PostgresClient,
  mutationValue: Readonly<StepRunMutation>,
): Promise<void> {
  const mutation = normalizeStepRunMutation(mutationValue);
  const step = mutation.stepRun;
  const updated = await client.query(
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
  if ((updated.rowCount ?? updated.rows.length) !== 1) return conflict();
  const run = await client.query(
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
  if ((run.rowCount ?? run.rows.length) !== 1) return conflict();
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
      step.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    ],
  );
  await client.query(
    `INSERT INTO "ql3"."step_run_mutations" (
       mutation_id, mutation_digest, run_id, step_run_id, step_run_digest,
       event_id, event_sequence, run_version, step_run_json, committed_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint)`,
    [
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      step.id,
      step.stepRunDigest,
      event.id,
      event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(step),
    ],
  );
}

function failure(
  receipt: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>,
): Readonly<{
  code: string;
  summary: string;
}> {
  if (receipt.reason === 'tool_failed') {
    return Object.freeze({
      code: 'COPILOT_DIAGNOSIS_TOOL_FAILED',
      summary: 'Copilot diagnosis Tool failed',
    });
  }
  if (receipt.reason === 'tool_timed_out' || receipt.outcome === 'timed_out') {
    return Object.freeze({
      code: 'COPILOT_DIAGNOSIS_TIMED_OUT',
      summary: 'Copilot diagnosis timed out',
    });
  }
  if (receipt.stage === 'log') {
    return Object.freeze({
      code: 'COPILOT_DIAGNOSIS_LOG_UNAVAILABLE',
      summary: 'Copilot diagnosis log is unavailable',
    });
  }
  return Object.freeze({
    code: 'COPILOT_DIAGNOSIS_CANCELLED',
    summary: 'Copilot diagnosis was cancelled',
  });
}

export class PostgresCopilotFailureDiagnosisPreModelTerminalizationRepository
  implements CopilotFailureDiagnosisPreModelTerminalizationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      return unavailable();
    }
  }

  async findByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt> | null> {
    if (!REQUEST_ID_PATTERN.test(requestId))
      return conflict('request id is invalid');
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `SELECT receipt_json AS "receiptJson" FROM ${TABLE} WHERE request_id = $1`,
        [requestId],
      );
      if (result.rows.length > 1) return conflict();
      if (!result.rows[0]) return null;
      const receipt =
        normalizeCopilotFailureDiagnosisPreModelTerminalizationReceipt(
          object(
            result.rows[0].receiptJson,
          ) as unknown as CopilotFailureDiagnosisPreModelTerminalizationReceipt,
        );
      const durable = await this.pool.query<Record<string, unknown>>(
        `SELECT run.status AS "runStatus", run.version AS "runVersion",
                run.event_sequence AS "runEventSequence",
                run.finished_at_ms AS "finishedAtMs",
                event.type AS "eventType", event.payload,
                event.created_at_ms AS "eventCreatedAtMs"
           FROM "ql3"."runs" AS run
           JOIN "ql3"."run_events" AS event
             ON event.run_id = run.id AND event.id = $1
          WHERE run.id = $2`,
        [receipt.runEventId, receipt.runId],
      );
      if (durable.rows.length !== 1) return conflict();
      const proof = durable.rows[0]!;
      const payload = object(proof.payload);
      if (
        string(proof.runStatus) !== receipt.outcome ||
        integer(proof.runVersion) !== receipt.finalRunVersion ||
        integer(proof.runEventSequence) !== receipt.finalRunEventSequence ||
        integer(proof.finishedAtMs) !== receipt.finalizedAtMs ||
        string(proof.eventType) !== `copilot.diagnosis.${receipt.outcome}` ||
        integer(proof.eventCreatedAtMs) !== receipt.finalizedAtMs ||
        payload.requestId !== receipt.requestId ||
        payload.planDigest !== receipt.planDigest ||
        payload.reason !== receipt.reason ||
        payload.evidenceDigest !== receipt.evidenceDigest
      )
        return conflict();
      for (const step of receipt.terminalSteps) {
        const stepProof = await this.pool.query<Record<string, unknown>>(
          `SELECT step.status, step.version,
                  mutation.mutation_digest AS "mutationDigest",
                  mutation.event_id AS "eventId"
             FROM "ql3"."step_runs" AS step
             JOIN "ql3"."step_run_mutations" AS mutation
               ON mutation.mutation_id = $1 AND mutation.step_run_id = step.id
            WHERE step.id = $2 AND step.run_id = $3`,
          [step.mutationId, step.stepRunId, receipt.runId],
        );
        if (
          stepProof.rows.length !== 1 ||
          string(stepProof.rows[0]!.status) !== step.status ||
          integer(stepProof.rows[0]!.version) !== step.version ||
          string(stepProof.rows[0]!.mutationDigest) !== step.mutationDigest ||
          string(stepProof.rows[0]!.eventId) !== step.eventId
        )
          return conflict();
      }
      return receipt;
    } catch (cause) {
      if (
        cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationConflictError
      )
        throw cause;
      return unavailable(cause);
    }
  }

  async readAuthority(
    requestId: string,
  ): Promise<
    Readonly<CopilotFailureDiagnosisPreModelTerminalizationAuthority>
  > {
    if (!REQUEST_ID_PATTERN.test(requestId))
      return conflict('request id is invalid');
    try {
      return await authority(this.pool, requestId, false);
    } catch (cause) {
      if (
        cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationConflictError
      )
        throw cause;
      return unavailable(cause);
    }
  }

  async commit(
    commandValue: Readonly<CopilotFailureDiagnosisPreModelTerminalizationCommand>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>;
    }>
  > {
    const command =
      normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand(
        commandValue,
      );
    const existing = await this.findByRequestId(command.plan.requestId);
    if (existing) {
      if (existing.receiptDigest !== command.receipt.receiptDigest)
        return conflict();
      return Object.freeze({ status: 'existing' as const, receipt: existing });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (cause) {
        return unavailable(cause);
      }
      let began = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        began = true;
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
          '5s',
        ]);
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
          '2s',
        ]);
        const current = await authority(client, command.plan.requestId, true);
        if (
          !same(current.plan, command.plan) ||
          current.run.status !== 'running' ||
          current.run.version !== command.expectedRunVersion ||
          current.run.eventSequence !== command.expectedRunEventSequence ||
          current.modelStartExists ||
          current.observedAtMs < command.receipt.finalizedAtMs ||
          (command.receipt.reason === 'deadline_exceeded' &&
            current.observedAtMs < current.plan.deadlineAtMs) ||
          (command.receipt.reason === 'tool_budget_exhausted' &&
            (current.toolStep.status !== 'ready' ||
              current.observedAtMs +
                BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS * 1_000 <=
                current.plan.deadlineAtMs)) ||
          (command.receipt.reason === 'cancellation_requested' &&
            (current.run.cancelRequestedAtMs === undefined ||
              current.run.cancelReason === undefined))
        )
          return conflict();
        if (command.receipt.stage === 'tool') {
          const proof = await client.query<Record<string, unknown>>(
            `SELECT outcome, completion_digest AS "completionDigest"
               FROM "ql3"."tool_execution_failure_completions"
              WHERE start_id = $1 AND run_id = $2 AND step_run_id = $3`,
            [
              command.receipt.toolStartId,
              command.plan.runId,
              command.plan.toolStepRunId,
            ],
          );
          if (
            proof.rows.length !== 1 ||
            string(proof.rows[0]!.completionDigest) !==
              command.receipt.toolCompletionDigest ||
            string(proof.rows[0]!.outcome) !== command.receipt.outcome
          )
            return conflict();
        } else if (command.receipt.stage === 'log') {
          const proof = await client.query<Record<string, unknown>>(
            `SELECT completion.completion_digest AS "completionDigest",
                    unlock.tool_completion_digest AS "unlockDigest"
               FROM "ql3"."tool_execution_completions" AS completion
               JOIN "ql3_ai"."copilot_failure_diagnosis_tool_unlocks" AS unlock
                 ON unlock.request_id = $1 AND unlock.start_id = completion.start_id
              WHERE completion.start_id = $2 AND completion.run_id = $3
                AND completion.step_run_id = $4`,
            [
              command.plan.requestId,
              command.receipt.toolStartId,
              command.plan.runId,
              command.plan.toolStepRunId,
            ],
          );
          if (
            proof.rows.length !== 1 ||
            string(proof.rows[0]!.completionDigest) !==
              command.receipt.toolCompletionDigest ||
            string(proof.rows[0]!.unlockDigest) !==
              command.receipt.toolCompletionDigest
          )
            return conflict();
        }
        for (const mutation of command.stepMutations)
          await updateStep(client, mutation);
        const failureFact = failure(command.receipt);
        const updated = await client.query(
          `UPDATE "ql3"."runs"
              SET status = $1, version = $2, event_sequence = $3,
                  output_ref = NULL, finished_at_ms = $4,
                  error_code = $5, error_summary = $6
            WHERE id = $7 AND status = 'running'
              AND version = $8 AND event_sequence = $9`,
          [
            command.receipt.outcome,
            command.receipt.finalRunVersion,
            command.receipt.finalRunEventSequence,
            command.receipt.finalizedAtMs,
            failureFact.code,
            failureFact.summary,
            command.plan.runId,
            command.receipt.finalRunVersion - 1,
            command.receipt.finalRunEventSequence - 1,
          ],
        );
        if ((updated.rowCount ?? updated.rows.length) !== 1) return conflict();
        const payload = JSON.stringify({
          requestId: command.receipt.requestId,
          planDigest: command.receipt.planDigest,
          reason: command.receipt.reason,
          evidenceDigest: command.receipt.evidenceDigest,
          outcome: command.receipt.outcome,
        });
        await client.query(
          `INSERT INTO "ql3"."run_events" (
             id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
             attempt_id, step_run_id, payload, created_at_ms
           ) VALUES ($1, $2, $3, $4, $1, 'system', NULL, NULL, NULL,
             $5::jsonb, $6)`,
          [
            command.receipt.runEventId,
            command.receipt.runId,
            command.receipt.finalRunEventSequence,
            `copilot.diagnosis.${command.receipt.outcome}`,
            payload,
            command.receipt.finalizedAtMs,
          ],
        );
        await client.query(
          `INSERT INTO ${TABLE} (
             request_id, plan_digest, run_id, stage, reason, outcome,
             evidence_digest, tool_start_id, tool_completion_digest,
             terminal_steps_json, final_run_version,
             final_run_event_sequence, run_event_id, finalized_at_ms,
             receipt_digest, receipt_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             $11, $12, $13, $14, $15, $16::jsonb)`,
          [
            command.receipt.requestId,
            command.receipt.planDigest,
            command.receipt.runId,
            command.receipt.stage,
            command.receipt.reason,
            command.receipt.outcome,
            command.receipt.evidenceDigest,
            command.receipt.toolStartId,
            command.receipt.toolCompletionDigest,
            JSON.stringify(command.receipt.terminalSteps),
            command.receipt.finalRunVersion,
            command.receipt.finalRunEventSequence,
            command.receipt.runEventId,
            command.receipt.finalizedAtMs,
            command.receipt.receiptDigest,
            JSON.stringify(command.receipt),
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt: command.receipt,
        });
      } catch (cause) {
        if (began) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* preserve */
          }
        }
        const state =
          cause && typeof cause === 'object' && 'code' in cause
            ? String(cause.code)
            : '';
        if ((state === '40001' || state === '40P01') && attempt < 2) continue;
        const recovered = await this.findByRequestId(command.plan.requestId);
        if (recovered) {
          if (recovered.receiptDigest !== command.receipt.receiptDigest)
            return conflict();
          return Object.freeze({
            status: 'existing' as const,
            receipt: recovered,
          });
        }
        if (
          cause instanceof
          CopilotFailureDiagnosisPreModelTerminalizationConflictError
        )
          throw cause;
        return unavailable(cause);
      } finally {
        client.release();
      }
    }
    return unavailable();
  }
}
