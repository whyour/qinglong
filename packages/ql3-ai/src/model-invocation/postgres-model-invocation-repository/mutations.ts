import type { PostgresClient } from '@qinglong/runtime-core';
import { type StepRunMutation } from '@qinglong/runtime-core/step-run';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  type ModelInvocationPriceQuote,
  type ModelInvocationPriceSettlement,
} from '../../pricing/pricing';
import { type ModelInvocationUsageLedgerRecord } from '../../usage/usageLedger';
import {
  type ModelInvocationQuotaReservation,
  type ModelInvocationQuotaSettlement,
  type ModelInvocationQuotaWindowUsage,
} from '../../usage/usageQuota';
import {
  ModelInvocationConflictError,
  type ModelInvocationCompletionRecord,
  type ModelInvocationStartRecord,
} from '../modelInvocation';
import { type ModelInvocationResolutionRecord } from '../modelInvocationResolution';

import type { Queryable, Row } from './authority';
import { TERMINAL_RUN_STATUSES, integer, text, unavailable } from './authority';

export async function updateStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const step = mutation.stepRun;
  const result = await client.query(
    `UPDATE "ql3"."step_runs"
     SET status = $1, version = $2, attempt_count = $3, output_ref = $4,
         approval_request_id = $5, ready_at_ms = $6, started_at_ms = $7,
         finished_at_ms = $8, result_code = $9, error_summary = $10,
         updated_at_ms = $11, last_mutation_id = $12,
         step_run_digest = $13, step_run_json = $14::jsonb
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
  if (result.rowCount !== 1) throw new ModelInvocationConflictError();
}

export async function updateRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET version = version + 1, event_sequence = event_sequence + 1
     WHERE id = $1 AND version = $2 AND event_sequence = $3`,
    [
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    ],
  );
  if (result.rowCount !== 1) throw new ModelInvocationConflictError();
}

export async function insertRunEvent(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
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
}

export async function insertMutation(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
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

export async function applyMutation(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  await updateStepRun(client, mutation);
  await updateRun(client, mutation);
  await insertRunEvent(client, mutation);
  await insertMutation(client, mutation);
}

export async function insertStart(
  client: PostgresClient,
  start: Readonly<ModelInvocationStartRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (
       invocation_id, project_id, run_id, step_run_id, trace_id,
       provider, model, policy_revision, request_digest, input_bytes,
       max_output_tokens, deadline_at_ms, admitted_at_ms, mutation_id,
       mutation_digest, run_event_id, start_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb
     )`,
    [
      start.invocationId,
      start.projectId,
      start.runId,
      start.stepRunId,
      start.traceId,
      start.provider,
      start.model,
      start.policyRevision,
      start.requestDigest,
      start.inputBytes,
      start.maxOutputTokens,
      start.deadlineAtMs,
      start.admittedAtMs,
      start.stepRunMutationId,
      start.stepRunMutationDigest,
      start.runEventId,
      start.startDigest,
      JSON.stringify(start),
    ],
  );
}

export async function insertCompletion(
  client: PostgresClient,
  completion: Readonly<ModelInvocationCompletionRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (
       invocation_id, project_id, run_id, step_run_id, trace_id,
       start_digest, outcome, output_bytes, error_code, completed_at_ms,
       mutation_id, mutation_digest, run_event_id, completion_digest,
       record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15::jsonb
     )`,
    [
      completion.invocationId,
      completion.projectId,
      completion.runId,
      completion.stepRunId,
      completion.traceId,
      completion.startDigest,
      completion.outcome,
      completion.outputBytes,
      completion.errorCode,
      completion.completedAtMs,
      completion.stepRunMutationId,
      completion.stepRunMutationDigest,
      completion.runEventId,
      completion.completionDigest,
      JSON.stringify(completion),
    ],
  );
}

export async function insertUsage(
  client: PostgresClient,
  usage: Readonly<ModelInvocationUsageLedgerRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger" (
       invocation_id, project_id, run_id, step_run_id, trace_id,
       provider, model, policy_revision, completion_digest, outcome,
       settled_at_ms, input_bytes, output_bytes, input_tokens,
       output_tokens, total_tokens, cost_micros, ledger_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19::jsonb
     )`,
    [
      usage.invocationId,
      usage.projectId,
      usage.runId,
      usage.stepRunId,
      usage.traceId,
      usage.provider,
      usage.model,
      usage.policyRevision,
      usage.completionDigest,
      usage.outcome,
      usage.settledAtMs,
      usage.inputBytes,
      usage.outputBytes,
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.costMicros,
      usage.ledgerDigest,
      JSON.stringify(usage),
    ],
  );
}

export async function insertQuotaReservation(
  client: PostgresClient,
  reservation: Readonly<ModelInvocationQuotaReservation>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations" (
       invocation_id, project_id, model_policy_revision,
       quota_policy_revision, window_ms, window_start_ms, window_end_ms,
       max_invocations, max_tokens, max_cost_micros, reserved_tokens,
       reserved_cost_micros, reserved_at_ms, admission_digest,
       reservation_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16::jsonb
     )`,
    [
      reservation.invocationId,
      reservation.projectId,
      reservation.modelPolicyRevision,
      reservation.quotaPolicyRevision,
      reservation.windowMs,
      reservation.windowStartMs,
      reservation.windowEndMs,
      reservation.maxInvocations,
      reservation.maxTokens,
      reservation.maxCostMicros,
      reservation.reservedTokens,
      reservation.reservedCostMicros,
      reservation.reservedAtMs,
      reservation.admissionDigest,
      reservation.reservationDigest,
      JSON.stringify(reservation),
    ],
  );
}

export async function insertQuotaSettlement(
  client: PostgresClient,
  settlement: Readonly<ModelInvocationQuotaSettlement>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements" (
       invocation_id, project_id, reservation_digest, completion_digest,
       effective_tokens, effective_cost_micros,
       retained_token_reservation, retained_cost_reservation,
       settled_at_ms, settlement_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
     )`,
    [
      settlement.invocationId,
      settlement.projectId,
      settlement.reservationDigest,
      settlement.completionDigest,
      settlement.effectiveTokens,
      settlement.effectiveCostMicros,
      settlement.retainedTokenReservation,
      settlement.retainedCostReservation,
      settlement.settledAtMs,
      settlement.settlementDigest,
      JSON.stringify(settlement),
    ],
  );
}

export async function insertPriceQuote(
  client: PostgresClient,
  quote: Readonly<ModelInvocationPriceQuote>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes" (
       invocation_id, project_id, model_policy_revision, provider, model,
       price_revision, currency, input_micros_per_million_tokens,
       output_micros_per_million_tokens, max_total_tokens, max_output_tokens,
       reserved_cost_micros, catalog_digest, quote_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15::jsonb
     )`,
    [
      quote.invocationId,
      quote.projectId,
      quote.modelPolicyRevision,
      quote.provider,
      quote.model,
      quote.priceRevision,
      quote.currency,
      quote.inputMicrosPerMillionTokens,
      quote.outputMicrosPerMillionTokens,
      quote.maxTotalTokens,
      quote.maxOutputTokens,
      quote.reservedCostMicros,
      quote.catalogDigest,
      quote.quoteDigest,
      JSON.stringify(quote),
    ],
  );
}

export async function insertPriceSettlement(
  client: PostgresClient,
  settlement: Readonly<ModelInvocationPriceSettlement>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements" (
       invocation_id, project_id, quote_digest, completion_digest, currency,
       input_tokens, output_tokens, cost_micros, settled_at_ms,
       settlement_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
     )`,
    [
      settlement.invocationId,
      settlement.projectId,
      settlement.quoteDigest,
      settlement.completionDigest,
      settlement.currency,
      settlement.inputTokens,
      settlement.outputTokens,
      settlement.costMicros,
      settlement.settledAtMs,
      settlement.settlementDigest,
      JSON.stringify(settlement),
    ],
  );
}

export async function quotaWindowUsage(
  queryable: Queryable,
  projectId: string,
  windowStartMs: number,
  windowMs: number,
): Promise<Readonly<ModelInvocationQuotaWindowUsage>> {
  const result = await queryable.query<Row>(
    `SELECT
       COUNT(*)::text AS "invocationCount",
       COALESCE(SUM(COALESCE(
         settlement.effective_tokens, reservation.reserved_tokens
       )), 0)::text AS "effectiveTokens",
       COALESCE(SUM(COALESCE(
         settlement.effective_cost_micros,
         reservation.reserved_cost_micros,
         0
       )), 0)::text AS "effectiveCostMicros",
       COUNT(*) FILTER (
         WHERE settlement.effective_cost_micros IS NULL
           AND reservation.reserved_cost_micros IS NULL
       )::text AS "unknownCostInvocations"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
       AS reservation
     LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements"
       AS settlement ON settlement.invocation_id = reservation.invocation_id
     WHERE reservation.project_id = $1
       AND reservation.window_start_ms = $2
       AND reservation.window_ms = $3`,
    [projectId, windowStartMs, windowMs],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw unavailable();
  return Object.freeze({
    projectId,
    windowStartMs,
    windowEndMs: windowStartMs + windowMs,
    invocationCount: integer(row, 'invocationCount'),
    effectiveTokens: integer(row, 'effectiveTokens'),
    effectiveCostMicros: integer(row, 'effectiveCostMicros'),
    unknownCostInvocations: integer(row, 'unknownCostInvocations'),
  });
}

export async function insertResolution(
  client: PostgresClient,
  resolution: Readonly<ModelInvocationResolutionRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions" (
       resolution_id, invocation_id, project_id, run_id, step_run_id,
       trace_id, completion_digest, decision, resolved_by_user_id,
       resolved_at_ms, mutation_id, mutation_digest, run_event_id,
       resolution_digest, record_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15::jsonb
     )`,
    [
      resolution.resolutionId,
      resolution.invocationId,
      resolution.projectId,
      resolution.runId,
      resolution.stepRunId,
      resolution.traceId,
      resolution.completionDigest,
      resolution.decision,
      resolution.resolvedByUserId,
      resolution.resolvedAtMs,
      resolution.stepRunMutationId,
      resolution.stepRunMutationDigest,
      resolution.runEventId,
      resolution.resolutionDigest,
      JSON.stringify(resolution),
    ],
  );
}

export async function assertCurrent(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
  projectId: string,
): Promise<void> {
  const result = await client.query<Row>(
    `SELECT
       step.kind AS "stepKind", step.status AS "stepStatus",
       step.version AS "stepVersion", step.step_run_digest AS "stepDigest",
       run.project_id AS "projectId", run.status AS "runStatus",
       run.version AS "runVersion",
       run.event_sequence AS "runEventSequence"
     FROM "ql3"."step_runs" AS step
     JOIN "ql3"."runs" AS run ON run.id = step.run_id
     WHERE step.id = $1 AND step.run_id = $2
     LIMIT 2
     FOR UPDATE OF step, run`,
    [mutation.stepRun.id, mutation.runId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    text(row, 'stepKind') !== 'model' ||
    text(row, 'stepStatus') !== mutation.previousStatus ||
    integer(row, 'stepVersion') !== mutation.expectedStepRunVersion ||
    text(row, 'stepDigest') !== mutation.expectedStepRunDigest ||
    text(row, 'projectId') !== projectId ||
    integer(row, 'runVersion') !== mutation.expectedRunVersion ||
    integer(row, 'runEventSequence') !== mutation.expectedRunEventSequence ||
    TERMINAL_RUN_STATUSES.has(text(row, 'runStatus'))
  ) {
    throw new ModelInvocationConflictError();
  }
}
