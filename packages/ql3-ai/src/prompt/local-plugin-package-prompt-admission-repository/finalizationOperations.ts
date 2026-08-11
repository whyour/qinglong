import type { DatabaseSync } from 'node:sqlite';

import { assertLocalModelInvocationFeatureActive } from '../../feature-activation/localModelInvocationFeatureActivation';
import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  normalizeModelInvocationCompletionRecord,
  type ModelInvocationCompletionRecord,
} from '../../model-invocation/modelInvocation';
import {
  normalizeModelInvocationResolutionRecord,
  type ModelInvocationResolutionRecord,
} from '../../model-invocation/modelInvocationResolution';
import {
  normalizePluginPackagePromptFinalizationReceipt,
  pluginPackagePromptFinalizationEventIdentity,
  pluginPackagePromptFinalizationReceiptDigest,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionUnavailableError,
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
  canonicalJson,
  integer,
  nullableText,
  text,
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

function selectFinalization(
  client: DatabaseSync,
  where: string,
  value: string,
): Row | undefined {
  return client
    .prepare(
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
       FROM "ModelInvocationPromptFinalizations"
       WHERE ${where} LIMIT 2`,
    )
    .get(value) as Row | undefined;
}

function parseFinalization(
  client: DatabaseSync,
  row: Row,
): Readonly<PluginPackagePromptFinalizationReceipt> {
  let receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
  try {
    receipt = normalizePluginPackagePromptFinalizationReceipt(
      JSON.parse(
        text(row, 'receiptJson'),
      ) as PluginPackagePromptFinalizationReceipt,
    );
  } catch {
    throw new PluginPackagePromptAdmissionUnavailableError();
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
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  const evidenceTable =
    receipt.terminalEvidenceKind === 'completion'
      ? 'ModelInvocationCompletions'
      : 'ModelInvocationResolutions';
  const evidenceDigestColumn =
    receipt.terminalEvidenceKind === 'completion'
      ? 'completion_digest'
      : 'resolution_digest';
  const durable = client
    .prepare(
      `SELECT run.status AS "runStatus", run.version AS "runVersion",
              run.event_sequence AS "runEventSequence",
              run.finished_at_ms AS "finishedAtMs",
              step.status AS "stepStatus",
              step.step_run_digest AS "stepRunDigest",
              event.type AS "eventType",
              event.dedupe_key AS "dedupeKey",
              event.actor_type AS "actorType",
              event.actor_id AS "actorId",
              event.step_run_id AS "eventStepRunId",
              event.payload, event.created_at_ms AS "eventCreatedAtMs",
              evidence.${evidenceDigestColumn} AS "evidenceDigest"
       FROM "Runs" AS run
       JOIN "StepRuns" AS step
         ON step.run_id = run.id AND step.id = ?
       JOIN "RunEvents" AS event
         ON event.run_id = run.id AND event.id = ?
       JOIN "${evidenceTable}" AS evidence
         ON evidence.invocation_id = ?
       WHERE run.id = ?`,
    )
    .get(
      receipt.stepRunId,
      receipt.eventId,
      receipt.invocationId,
      receipt.runId,
    ) as Row | undefined;
  const expectedStepStatus = receipt.runStatus;
  if (
    !durable ||
    text(durable, 'runStatus') !== receipt.runStatus ||
    integer(durable, 'runVersion') !== receipt.finalRunVersion ||
    integer(durable, 'runEventSequence') !== receipt.finalRunEventSequence ||
    integer(durable, 'finishedAtMs') !== receipt.finalizedAtMs ||
    text(durable, 'stepStatus') !== expectedStepStatus ||
    text(durable, 'stepRunDigest') !== receipt.finalStepRunDigest ||
    text(durable, 'eventType') !== `prompt.${receipt.runStatus}` ||
    nullableText(durable, 'dedupeKey') !== receipt.eventId ||
    text(durable, 'actorType') !== 'system' ||
    nullableText(durable, 'actorId') !== null ||
    nullableText(durable, 'eventStepRunId') !== receipt.stepRunId ||
    text(durable, 'payload') !== canonicalJson(finalizationPayload(receipt)) ||
    integer(durable, 'eventCreatedAtMs') !== receipt.finalizedAtMs ||
    text(durable, 'evidenceDigest') !== receipt.terminalEvidenceDigest
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return receipt;
}

function terminalEvidence(
  client: DatabaseSync,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
): TerminalEvidence {
  const row = client
    .prepare(
      `SELECT run.status AS "runStatus", run.version AS "runVersion",
              run.event_sequence AS "runEventSequence",
              step.status AS "stepStatus",
              step.step_run_digest AS "stepRunDigest",
              completion.record_json AS "completionJson",
              resolution.record_json AS "resolutionJson"
       FROM "Runs" AS run
       JOIN "StepRuns" AS step
         ON step.run_id = run.id AND step.id = ?
       LEFT JOIN "ModelInvocationCompletions" AS completion
         ON completion.invocation_id = ?
       LEFT JOIN "ModelInvocationResolutions" AS resolution
         ON resolution.invocation_id = ?
       WHERE run.id = ?`,
    )
    .get(plan.stepRunId, plan.invocationId, plan.invocationId, plan.runId) as
    | Row
    | undefined;
  if (!row || text(row, 'runStatus') !== 'running') {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  if (row.completionJson === null) {
    throw new PluginPackagePromptExecutionInProgressError();
  }
  let completion: Readonly<ModelInvocationCompletionRecord>;
  try {
    completion = normalizeModelInvocationCompletionRecord(
      JSON.parse(
        text(row, 'completionJson'),
      ) as ModelInvocationCompletionRecord,
    );
  } catch {
    throw new PluginPackagePromptAdmissionUnavailableError();
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
  let evidenceDigest = completion.completionDigest;
  let stepRunDigest = completion.completedStepRunDigest;
  let runStatus: PluginPackagePromptFinalRunStatus;
  let finalizedAtMs = completion.completedAtMs;
  if (completion.outcome === 'succeeded') runStatus = 'succeeded';
  else if (completion.outcome === 'failed') runStatus = 'failed';
  else if (completion.outcome === 'timed_out') runStatus = 'timed_out';
  else {
    if (row.resolutionJson === null) {
      throw new PluginPackagePromptResolutionRequiredError();
    }
    let resolution: Readonly<ModelInvocationResolutionRecord>;
    try {
      resolution = normalizeModelInvocationResolutionRecord(
        JSON.parse(
          text(row, 'resolutionJson'),
        ) as ModelInvocationResolutionRecord,
      );
    } catch {
      throw new PluginPackagePromptAdmissionUnavailableError();
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
    evidenceDigest = resolution.resolutionDigest;
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
    digest: evidenceDigest,
    stepRunDigest,
    runStatus,
    finalizedAtMs,
    runVersion: integer(row, 'runVersion'),
    runEventSequence: integer(row, 'runEventSequence'),
  });
}

export function findFinalization(
  client: DatabaseSync,
  requestId: string,
): Readonly<PluginPackagePromptFinalizationReceipt> | null {
  const row = selectFinalization(client, 'request_id = ?', requestId);
  return row ? parseFinalization(client, row) : null;
}

export function finalizeOperation(
  authority: LocalModelInvocationOperationAuthority,
  requestId: string,
): Readonly<{
  status: 'created' | 'existing';
  receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
}> {
  let began = false;
  try {
    authority.client.exec('BEGIN IMMEDIATE');
    began = true;
    const existingRow = selectFinalization(
      authority.client,
      'request_id = ?',
      requestId,
    );
    if (existingRow) {
      const receipt = parseFinalization(authority.client, existingRow);
      authority.client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'existing' as const, receipt });
    }
    assertLocalModelInvocationFeatureActive(authority.client);
    const admission = findAdmission(
      authority.client,
      'request_id = ?',
      requestId,
    );
    if (!admission) {
      throw new PluginPackagePromptAdmissionConflictError(
        'the Prompt admission is absent',
      );
    }
    const evidence = terminalEvidence(authority.client, admission.plan);
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
    const updated = authority.client
      .prepare(
        `UPDATE "Runs"
         SET status = ?, version = ?, event_sequence = ?,
             finished_at_ms = ?, error_code = ?, error_summary = ?
         WHERE id = ? AND status = 'running'
           AND version = ? AND event_sequence = ?`,
      )
      .run(
        receipt.runStatus,
        receipt.finalRunVersion,
        receipt.finalRunEventSequence,
        receipt.finalizedAtMs,
        failure.errorCode,
        failure.errorSummary,
        receipt.runId,
        evidence.runVersion,
        evidence.runEventSequence,
      );
    if (updated.changes !== 1) {
      throw new PluginPackagePromptAdmissionConflictError(
        'the Prompt Run changed before finalization',
      );
    }
    authority.client
      .prepare(
        `INSERT INTO "RunEvents" (
           id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
           attempt_id, step_run_id, payload, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'system', NULL, NULL, ?, ?, ?)`,
      )
      .run(
        receipt.eventId,
        receipt.runId,
        receipt.finalRunEventSequence,
        `prompt.${receipt.runStatus}`,
        receipt.eventId,
        receipt.stepRunId,
        canonicalJson(finalizationPayload(receipt)),
        receipt.finalizedAtMs,
      );
    authority.client
      .prepare(
        `INSERT INTO "ModelInvocationPromptFinalizations" (
           request_id, invocation_id, plan_digest, run_id, step_run_id,
           terminal_evidence_kind, terminal_evidence_digest,
           final_step_run_digest, run_status, event_id,
           final_run_version, final_run_event_sequence, finalized_at_ms,
           receipt_digest, receipt_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        canonicalJson(receipt),
      );
    authority.client.exec('COMMIT');
    began = false;
    return Object.freeze({ status: 'created' as const, receipt });
  } finally {
    if (began && authority.client.isTransaction) {
      try {
        authority.client.exec('ROLLBACK');
      } catch {
        // Preserve the original fail-closed error.
      }
    }
  }
}
