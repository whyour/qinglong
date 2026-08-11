import type { DatabaseSync } from 'node:sqlite';

import { type StepRunMutation } from '@qinglong/runtime-core/step-run';
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

import type { Row } from './authority';
import { TERMINAL_RUN_STATUSES, integer, text, unavailable } from './authority';

export function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const step = mutation.stepRun;
  const result = client
    .prepare(
      `UPDATE "StepRuns"
       SET status = ?, version = ?, attempt_count = ?, output_ref = ?,
           approval_request_id = ?, ready_at_ms = ?, started_at_ms = ?,
           finished_at_ms = ?, result_code = ?, error_summary = ?,
           updated_at_ms = ?, last_mutation_id = ?, step_run_digest = ?,
           step_run_json = ?
       WHERE id = ? AND run_id = ? AND version = ?
         AND step_run_digest = ? AND status = ?`,
    )
    .run(
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
    );
  if (result.changes !== 1) throw new ModelInvocationConflictError();
}

export function updateRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const result = client
    .prepare(
      `UPDATE "Runs"
       SET version = version + 1, event_sequence = event_sequence + 1
       WHERE id = ? AND version = ? AND event_sequence = ?`,
    )
    .run(
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    );
  if (result.changes !== 1) throw new ModelInvocationConflictError();
}

export function insertRunEvent(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const event = mutation.event;
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
      event.dedupeKey!,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    );
}

export function insertMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
       )`,
    )
    .run(
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
    );
}

export function applyMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  updateStepRun(client, mutation);
  updateRun(client, mutation);
  insertRunEvent(client, mutation);
  insertMutation(client, mutation);
}

export function insertStart(
  client: DatabaseSync,
  start: Readonly<ModelInvocationStartRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationStarts" (
         invocation_id, project_id, run_id, step_run_id, trace_id,
         provider, model, policy_revision, request_digest, input_bytes,
         max_output_tokens, deadline_at_ms, admitted_at_ms, mutation_id,
         mutation_digest, run_event_id, start_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertCompletion(
  client: DatabaseSync,
  completion: Readonly<ModelInvocationCompletionRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationCompletions" (
         invocation_id, project_id, run_id, step_run_id, trace_id,
         start_digest, outcome, output_bytes, error_code, completed_at_ms,
         mutation_id, mutation_digest, run_event_id, completion_digest,
         record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertUsage(
  client: DatabaseSync,
  usage: Readonly<ModelInvocationUsageLedgerRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationUsageLedger" (
         invocation_id, project_id, run_id, step_run_id, trace_id,
         provider, model, policy_revision, completion_digest, outcome,
         settled_at_ms, input_bytes, output_bytes, input_tokens,
         output_tokens, total_tokens, cost_micros, ledger_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertQuotaReservation(
  client: DatabaseSync,
  reservation: Readonly<ModelInvocationQuotaReservation>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationQuotaReservations" (
         invocation_id, project_id, model_policy_revision,
         quota_policy_revision, window_ms, window_start_ms, window_end_ms,
         max_invocations, max_tokens, max_cost_micros, reserved_tokens,
         reserved_cost_micros, reserved_at_ms, admission_digest,
         reservation_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertQuotaSettlement(
  client: DatabaseSync,
  settlement: Readonly<ModelInvocationQuotaSettlement>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationQuotaSettlements" (
         invocation_id, project_id, reservation_digest, completion_digest,
         effective_tokens, effective_cost_micros,
         retained_token_reservation, retained_cost_reservation,
         settled_at_ms, settlement_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      settlement.invocationId,
      settlement.projectId,
      settlement.reservationDigest,
      settlement.completionDigest,
      settlement.effectiveTokens,
      settlement.effectiveCostMicros,
      settlement.retainedTokenReservation ? 1 : 0,
      settlement.retainedCostReservation ? 1 : 0,
      settlement.settledAtMs,
      settlement.settlementDigest,
      JSON.stringify(settlement),
    );
}

export function insertPriceQuote(
  client: DatabaseSync,
  quote: Readonly<ModelInvocationPriceQuote>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationPriceQuotes" (
         invocation_id, project_id, model_policy_revision, provider, model,
         price_revision, currency, input_micros_per_million_tokens,
         output_micros_per_million_tokens, max_total_tokens, max_output_tokens,
         reserved_cost_micros, catalog_digest, quote_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertPriceSettlement(
  client: DatabaseSync,
  settlement: Readonly<ModelInvocationPriceSettlement>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationPriceSettlements" (
         invocation_id, project_id, quote_digest, completion_digest, currency,
         input_tokens, output_tokens, cost_micros, settled_at_ms,
         settlement_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function quotaWindowUsage(
  client: DatabaseSync,
  projectId: string,
  windowStartMs: number,
  windowMs: number,
): Readonly<ModelInvocationQuotaWindowUsage> {
  const row = client
    .prepare(
      `SELECT
         COUNT(*) AS "invocationCount",
         COALESCE(SUM(COALESCE(
           settlement.effective_tokens, reservation.reserved_tokens
         )), 0) AS "effectiveTokens",
         COALESCE(SUM(COALESCE(
           settlement.effective_cost_micros,
           reservation.reserved_cost_micros,
           0
         )), 0) AS "effectiveCostMicros",
         COALESCE(SUM(CASE WHEN
           settlement.effective_cost_micros IS NULL
             AND reservation.reserved_cost_micros IS NULL
           THEN 1 ELSE 0 END), 0) AS "unknownCostInvocations"
       FROM "ModelInvocationQuotaReservations" AS reservation
       LEFT JOIN "ModelInvocationQuotaSettlements" AS settlement
         ON settlement.invocation_id = reservation.invocation_id
       WHERE reservation.project_id = ?
         AND reservation.window_start_ms = ?
         AND reservation.window_ms = ?`,
    )
    .get(projectId, windowStartMs, windowMs) as Row | undefined;
  if (!row) throw unavailable();
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

export function insertResolution(
  client: DatabaseSync,
  resolution: Readonly<ModelInvocationResolutionRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelInvocationResolutions" (
         resolution_id, invocation_id, project_id, run_id, step_run_id,
         trace_id, completion_digest, decision, resolved_by_user_id,
         resolved_at_ms, mutation_id, mutation_digest, run_event_id,
         resolution_digest, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function assertCurrent(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
  projectId: string,
): void {
  const rows = client
    .prepare(
      `SELECT
         step.kind AS "stepKind", step.status AS "stepStatus",
         step.version AS "stepVersion",
         step.step_run_digest AS "stepDigest",
         run.project_id AS "projectId", run.status AS "runStatus",
         run.version AS "runVersion",
         run.event_sequence AS "runEventSequence"
       FROM "StepRuns" AS step
       JOIN "Runs" AS run ON run.id = step.run_id
       WHERE step.id = ? AND step.run_id = ?
       LIMIT 2`,
    )
    .all(mutation.stepRun.id, mutation.runId) as Row[];
  const row = rows[0];
  if (
    rows.length !== 1 ||
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
