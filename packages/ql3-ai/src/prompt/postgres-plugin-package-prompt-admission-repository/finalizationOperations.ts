import type { PostgresClient, PostgresQueryable } from '@qinglong/runtime-core';

import {
  normalizeModelInvocationCompletionRecord,
  type ModelInvocationCompletionRecord,
} from '../../model-invocation/modelInvocation';
import {
  normalizeModelInvocationResolutionRecord,
  type ModelInvocationResolutionRecord,
} from '../../model-invocation/modelInvocationResolution';
import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  normalizePluginPackagePromptFinalizationReceipt,
  pluginPackagePromptFinalizationEventIdentity,
  pluginPackagePromptFinalizationReceiptDigest,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptExecutionInProgressError,
  PluginPackagePromptResolutionRequiredError,
  PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA,
  type PluginPackagePromptExecutionPlan,
  type PluginPackagePromptFinalizationReceipt,
  type PluginPackagePromptFinalRunStatus,
  type PluginPackagePromptTerminalEvidenceKind,
} from '../pluginPackagePromptExecution';
import { findAdmission } from './admissionRecords';
import {
  integer,
  json,
  jsonObject,
  nullableText,
  text,
  unavailable,
  type Row,
} from './authority';

type TerminalEvidence = Readonly<{
  kind: PluginPackagePromptTerminalEvidenceKind;
  digest: string;
  stepRunDigest: string;
  runStatus: PluginPackagePromptFinalRunStatus;
  finalizedAtMs: number;
  runVersion: number;
  runEventSequence: number;
}>;

function finalizationPayload(
  receipt: Readonly<PluginPackagePromptFinalizationReceipt>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    invocationId: receipt.invocationId,
    planDigest: receipt.planDigest,
    terminalEvidenceKind: receipt.terminalEvidenceKind,
    terminalEvidenceDigest: receipt.terminalEvidenceDigest,
    finalStepRunDigest: receipt.finalStepRunDigest,
    runStatus: receipt.runStatus,
  });
}

function runFailureFields(status: PluginPackagePromptFinalRunStatus): Readonly<{
  errorCode: string | null;
  errorSummary: string | null;
}> {
  if (status === 'succeeded') {
    return Object.freeze({ errorCode: null, errorSummary: null });
  }
  if (status === 'timed_out') {
    return Object.freeze({
      errorCode: 'PLUGIN_PACKAGE_PROMPT_TIMED_OUT',
      errorSummary: 'Plugin Package Prompt execution timed out',
    });
  }
  if (status === 'cancelled') {
    return Object.freeze({
      errorCode: 'PLUGIN_PACKAGE_PROMPT_CANCELLED',
      errorSummary: 'Plugin Package Prompt execution was cancelled',
    });
  }
  return Object.freeze({
    errorCode: 'PLUGIN_PACKAGE_PROMPT_FAILED',
    errorSummary: 'Plugin Package Prompt execution failed',
  });
}

async function finalizationRows(
  queryable: PostgresQueryable,
  requestId: string,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT request_id AS "requestId",
            invocation_id AS "invocationId",
            plan_digest AS "planDigest", run_id AS "runId",
            step_run_id AS "stepRunId",
            terminal_evidence_kind AS "terminalEvidenceKind",
            terminal_evidence_digest AS "terminalEvidenceDigest",
            final_step_run_digest AS "finalStepRunDigest",
            run_status AS "runStatus", event_id AS "eventId",
            final_run_version AS "finalRunVersion",
            final_run_event_sequence AS "finalRunEventSequence",
            finalized_at_ms AS "finalizedAtMs",
            receipt_digest AS "receiptDigest",
            receipt_json AS "receiptJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
     WHERE request_id = $1 LIMIT 2`,
    [requestId],
  );
  return result.rows;
}

async function terminalEvidence(
  client: PostgresClient,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
): Promise<TerminalEvidence> {
  const result = await client.query<Row>(
    `SELECT run.status AS "runStatus", run.version AS "runVersion",
            run.event_sequence AS "runEventSequence",
            step.status AS "stepStatus",
            step.step_run_digest AS "stepRunDigest",
            completion.record_json AS "completionJson",
            resolution.record_json AS "resolutionJson"
     FROM "ql3"."runs" AS run
     JOIN "ql3"."step_runs" AS step
       ON step.run_id = run.id AND step.id = $1
     LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
       AS completion ON completion.invocation_id = $2
     LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions"
       AS resolution ON resolution.invocation_id = $3
     WHERE run.id = $4
     FOR UPDATE OF run, step`,
    [plan.stepRunId, plan.invocationId, plan.invocationId, plan.runId],
  );
  const row = result.rows.length === 1 ? result.rows[0]! : null;
  if (!row || text(row, 'runStatus') !== 'running') throw unavailable();
  if (row.completionJson === null || row.completionJson === undefined) {
    throw new PluginPackagePromptExecutionInProgressError();
  }
  let completion: Readonly<ModelInvocationCompletionRecord>;
  try {
    completion = normalizeModelInvocationCompletionRecord(
      jsonObject(
        row.completionJson,
      ) as unknown as ModelInvocationCompletionRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    completion.invocationId !== plan.invocationId ||
    completion.projectId !== plan.target.projectId ||
    completion.runId !== plan.runId ||
    completion.stepRunId !== plan.stepRunId ||
    completion.traceId !== plan.traceId
  ) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the ModelInvocation completion is detached from the Prompt plan',
    );
  }

  let kind: PluginPackagePromptTerminalEvidenceKind = 'completion';
  let digest = completion.completionDigest;
  let stepRunDigest = completion.completedStepRunDigest;
  let runStatus: PluginPackagePromptFinalRunStatus;
  let finalizedAtMs = completion.completedAtMs;
  if (completion.outcome === 'succeeded') runStatus = 'succeeded';
  else if (completion.outcome === 'failed') runStatus = 'failed';
  else if (completion.outcome === 'timed_out') runStatus = 'timed_out';
  else {
    if (row.resolutionJson === null || row.resolutionJson === undefined) {
      throw new PluginPackagePromptResolutionRequiredError();
    }
    let resolution: Readonly<ModelInvocationResolutionRecord>;
    try {
      resolution = normalizeModelInvocationResolutionRecord(
        jsonObject(
          row.resolutionJson,
        ) as unknown as ModelInvocationResolutionRecord,
      );
    } catch {
      throw unavailable();
    }
    if (
      resolution.invocationId !== plan.invocationId ||
      resolution.projectId !== plan.target.projectId ||
      resolution.runId !== plan.runId ||
      resolution.stepRunId !== plan.stepRunId ||
      resolution.traceId !== plan.traceId ||
      resolution.completionDigest !== completion.completionDigest
    ) {
      throw new PluginPackagePromptAdmissionConflictError(
        'the ModelInvocation resolution is detached from the Prompt plan',
      );
    }
    if (resolution.decision === 'retry') {
      throw new PluginPackagePromptExecutionInProgressError();
    }
    kind = 'resolution';
    digest = resolution.resolutionDigest;
    stepRunDigest = resolution.resolvedStepRunDigest;
    runStatus = resolution.decision === 'cancel' ? 'cancelled' : 'failed';
    finalizedAtMs = resolution.resolvedAtMs;
  }
  if (
    text(row, 'stepStatus') !== runStatus ||
    text(row, 'stepRunDigest') !== stepRunDigest
  ) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the terminal model StepRun evidence drifted',
    );
  }
  return Object.freeze({
    kind,
    digest,
    stepRunDigest,
    runStatus,
    finalizedAtMs,
    runVersion: integer(row, 'runVersion'),
    runEventSequence: integer(row, 'runEventSequence'),
  });
}

async function parseFinalization(
  queryable: PostgresQueryable,
  row: Row,
): Promise<Readonly<PluginPackagePromptFinalizationReceipt>> {
  let receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
  try {
    receipt = normalizePluginPackagePromptFinalizationReceipt(
      jsonObject(
        row.receiptJson,
      ) as unknown as PluginPackagePromptFinalizationReceipt,
    );
  } catch {
    throw unavailable();
  }
  if (
    receipt.requestId !== text(row, 'requestId') ||
    receipt.invocationId !== text(row, 'invocationId') ||
    receipt.planDigest !== text(row, 'planDigest') ||
    receipt.runId !== text(row, 'runId') ||
    receipt.stepRunId !== text(row, 'stepRunId') ||
    receipt.terminalEvidenceKind !== text(row, 'terminalEvidenceKind') ||
    receipt.terminalEvidenceDigest !== text(row, 'terminalEvidenceDigest') ||
    receipt.finalStepRunDigest !== text(row, 'finalStepRunDigest') ||
    receipt.runStatus !== text(row, 'runStatus') ||
    receipt.eventId !== text(row, 'eventId') ||
    receipt.finalRunVersion !== integer(row, 'finalRunVersion') ||
    receipt.finalRunEventSequence !== integer(row, 'finalRunEventSequence') ||
    receipt.finalizedAtMs !== integer(row, 'finalizedAtMs') ||
    receipt.receiptDigest !== text(row, 'receiptDigest')
  ) {
    throw unavailable();
  }
  const evidenceTable =
    receipt.terminalEvidenceKind === 'completion'
      ? 'model_invocation_completions'
      : 'model_invocation_resolutions';
  const evidenceDigestColumn =
    receipt.terminalEvidenceKind === 'completion'
      ? 'completion_digest'
      : 'resolution_digest';
  const result = await queryable.query<Row>(
    `SELECT run.status AS "runStatus", run.version AS "runVersion",
            run.event_sequence AS "runEventSequence",
            run.finished_at_ms AS "finishedAtMs",
            step.status AS "stepStatus",
            step.step_run_digest AS "stepRunDigest",
            event.type AS "eventType", event.dedupe_key AS "dedupeKey",
            event.actor_type AS "actorType", event.actor_id AS "actorId",
            event.step_run_id AS "eventStepRunId", event.payload,
            event.created_at_ms AS "eventCreatedAtMs",
            evidence.${evidenceDigestColumn} AS "evidenceDigest"
     FROM "ql3"."runs" AS run
     JOIN "ql3"."step_runs" AS step
       ON step.run_id = run.id AND step.id = $1
     JOIN "ql3"."run_events" AS event
       ON event.run_id = run.id AND event.id = $2
     JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${evidenceTable}" AS evidence
       ON evidence.invocation_id = $3
     WHERE run.id = $4`,
    [receipt.stepRunId, receipt.eventId, receipt.invocationId, receipt.runId],
  );
  const durable = result.rows.length === 1 ? result.rows[0]! : null;
  if (
    !durable ||
    text(durable, 'runStatus') !== receipt.runStatus ||
    integer(durable, 'runVersion') !== receipt.finalRunVersion ||
    integer(durable, 'runEventSequence') !== receipt.finalRunEventSequence ||
    integer(durable, 'finishedAtMs') !== receipt.finalizedAtMs ||
    text(durable, 'stepStatus') !== receipt.runStatus ||
    text(durable, 'stepRunDigest') !== receipt.finalStepRunDigest ||
    text(durable, 'eventType') !== `prompt.${receipt.runStatus}` ||
    nullableText(durable, 'dedupeKey') !== receipt.eventId ||
    text(durable, 'actorType') !== 'system' ||
    nullableText(durable, 'actorId') !== null ||
    nullableText(durable, 'eventStepRunId') !== receipt.stepRunId ||
    json(durable.payload) !== json(finalizationPayload(receipt)) ||
    integer(durable, 'eventCreatedAtMs') !== receipt.finalizedAtMs ||
    text(durable, 'evidenceDigest') !== receipt.terminalEvidenceDigest
  ) {
    throw unavailable();
  }
  return receipt;
}

export async function findFinalization(
  queryable: PostgresQueryable,
  requestId: string,
): Promise<Readonly<PluginPackagePromptFinalizationReceipt> | null> {
  const rows = await finalizationRows(queryable, requestId);
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseFinalization(queryable, rows[0]) : null;
}

export async function finalizeOperation(
  client: PostgresClient,
  requestId: string,
): Promise<
  Readonly<{
    status: 'created' | 'existing';
    receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
  }>
> {
  const existingRows = await finalizationRows(client, requestId);
  if (existingRows.length > 1) throw unavailable();
  if (existingRows[0]) {
    return Object.freeze({
      status: 'existing' as const,
      receipt: await parseFinalization(client, existingRows[0]),
    });
  }
  const admission = await findAdmission(client, 'request_id', requestId);
  if (!admission) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the Prompt admission is absent',
    );
  }
  const evidence = await terminalEvidence(client, admission.plan);
  if (
    evidence.runVersion !== evidence.runEventSequence ||
    evidence.runVersion < admission.receipt.finalRunVersion
  ) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the Prompt Run counter chain drifted',
    );
  }
  const eventId = pluginPackagePromptFinalizationEventIdentity(
    admission.plan.invocationId,
    evidence.digest,
  );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA,
    requestId: admission.plan.requestId,
    invocationId: admission.plan.invocationId,
    planDigest: admission.plan.planDigest,
    runId: admission.plan.runId,
    stepRunId: admission.plan.stepRunId,
    terminalEvidenceKind: evidence.kind,
    terminalEvidenceDigest: evidence.digest,
    finalStepRunDigest: evidence.stepRunDigest,
    runStatus: evidence.runStatus,
    eventId,
    finalRunVersion: evidence.runVersion + 1,
    finalRunEventSequence: evidence.runEventSequence + 1,
    finalizedAtMs: evidence.finalizedAtMs,
  });
  const receipt = normalizePluginPackagePromptFinalizationReceipt({
    ...unsigned,
    receiptDigest: pluginPackagePromptFinalizationReceiptDigest(unsigned),
  });
  const failure = runFailureFields(receipt.runStatus);
  const updated = await client.query(
    `UPDATE "ql3"."runs"
     SET status = $1, version = $2, event_sequence = $3,
         finished_at_ms = $4, error_code = $5, error_summary = $6
     WHERE id = $7 AND status = 'running'
       AND version = $8 AND event_sequence = $9`,
    [
      receipt.runStatus,
      receipt.finalRunVersion,
      receipt.finalRunEventSequence,
      receipt.finalizedAtMs,
      failure.errorCode,
      failure.errorSummary,
      receipt.runId,
      evidence.runVersion,
      evidence.runEventSequence,
    ],
  );
  if ((updated.rowCount ?? updated.rows.length) !== 1) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the Prompt Run changed before finalization',
    );
  }
  await client.query(
    `INSERT INTO "ql3"."run_events" (
       id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
       attempt_id, step_run_id, payload, created_at_ms
     ) VALUES ($1, $2, $3, $4, $5, 'system', NULL, NULL, $6, $7::jsonb, $8)`,
    [
      receipt.eventId,
      receipt.runId,
      receipt.finalRunEventSequence,
      `prompt.${receipt.runStatus}`,
      receipt.eventId,
      receipt.stepRunId,
      json(finalizationPayload(receipt)),
      receipt.finalizedAtMs,
    ],
  );
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations" (
       request_id, invocation_id, plan_digest, run_id, step_run_id,
       terminal_evidence_kind, terminal_evidence_digest,
       final_step_run_digest, run_status, event_id,
       final_run_version, final_run_event_sequence, finalized_at_ms,
       receipt_digest, receipt_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15::jsonb
     )`,
    [
      receipt.requestId,
      receipt.invocationId,
      receipt.planDigest,
      receipt.runId,
      receipt.stepRunId,
      receipt.terminalEvidenceKind,
      receipt.terminalEvidenceDigest,
      receipt.finalStepRunDigest,
      receipt.runStatus,
      receipt.eventId,
      receipt.finalRunVersion,
      receipt.finalRunEventSequence,
      receipt.finalizedAtMs,
      receipt.receiptDigest,
      json(receipt),
    ],
  );
  return Object.freeze({ status: 'created' as const, receipt });
}
