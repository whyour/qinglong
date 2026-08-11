import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidToolExecutionStartBarrierError,
  ToolExecutionStartBarrierConflictError,
  ToolExecutionStartBarrierUnavailableError,
  normalizeToolExecutionStartBarrierRecord,
  normalizeToolExecutionStartCommand,
  toolExecutionStartBarrierRecord,
  type PrepareToolExecutionStartResult,
  type ToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRepository,
  type ToolExecutionStartCommand,
} from '@qinglong/runtime-core/tool-execution-start-barrier';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';
import type { ToolExecutionEvidenceBundle } from '@qinglong/runtime-core/tool-execution-evidence';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const BARRIER_SELECT = `
  barrier.barrier_json AS "barrierJson",
  barrier.start_id AS "storedStartId",
  barrier.project_id AS "storedProjectId",
  barrier.run_id AS "storedRunId",
  barrier.step_run_id AS "storedStepRunId",
  barrier.started_step_run_version AS "storedStepRunVersion",
  barrier.step_run_mutation_id AS "storedMutationId",
  barrier.run_event_id AS "storedRunEventId",
  barrier.trace_id AS "storedTraceId",
  barrier.span_id AS "storedSpanId",
  barrier.audit_event_id AS "storedAuditEventId",
  barrier.command_digest AS "storedCommandDigest",
  barrier.barrier_digest AS "storedBarrierDigest",
  barrier.started_at_ms AS "storedStartedAtMs",
  mutation.mutation_digest AS "storedMutationDigest",
  mutation.step_run_digest AS "storedStartedStepRunDigest",
  trace.trace_digest AS "storedTraceDigest",
  receipt.receipt_digest AS "storedAuditReceiptDigest",
  artifact_binding.project_id AS "storedArtifactProjectId",
  artifact_binding.action_ref AS "storedArtifactActionRef",
  artifact_binding.input_artifact_id AS "storedInputArtifactId",
  artifact_binding.input_artifact_digest AS "storedInputArtifactDigest",
  artifact_binding.input_digest AS "storedInputDigest",
  artifact_binding.preview_artifact_id AS "storedPreviewArtifactId",
  artifact_binding.preview_artifact_digest AS "storedPreviewArtifactDigest",
  artifact_binding.action_digest AS "storedArtifactActionDigest",
  artifact_binding.preview_digest AS "storedPreviewDigest",
  artifact_binding.redaction_contract_digest
    AS "storedArtifactRedactionContractDigest",
  artifact_binding.bound_at_ms AS "storedArtifactBoundAtMs"
`;

function unavailable(
  cause?: unknown,
): ToolExecutionStartBarrierUnavailableError {
  return new ToolExecutionStartBarrierUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidToolExecutionStartBarrierError(`${label} is invalid`);
  }
  return value;
}

function version(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > 2_147_483_647
  ) {
    throw new InvalidToolExecutionStartBarrierError(
      'started StepRun version is invalid',
    );
  }
  return value as number;
}

function barrierFromRow(row: Row): Readonly<ToolExecutionStartBarrierRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredText(row, 'barrierJson'));
  } catch {
    throw unavailable();
  }
  let barrier: Readonly<ToolExecutionStartBarrierRecord>;
  try {
    barrier = normalizeToolExecutionStartBarrierRecord(
      parsed as ToolExecutionStartBarrierRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    barrier.startId !== requiredText(row, 'storedStartId') ||
    barrier.projectId !== requiredText(row, 'storedProjectId') ||
    barrier.runId !== requiredText(row, 'storedRunId') ||
    barrier.stepRunId !== requiredText(row, 'storedStepRunId') ||
    barrier.startedStepRunVersion !==
      requiredInteger(row, 'storedStepRunVersion') ||
    barrier.stepRunMutationId !== requiredText(row, 'storedMutationId') ||
    barrier.runEventId !== requiredText(row, 'storedRunEventId') ||
    barrier.traceId !== requiredText(row, 'storedTraceId') ||
    barrier.spanId !== requiredText(row, 'storedSpanId') ||
    barrier.auditEventId !== requiredText(row, 'storedAuditEventId') ||
    barrier.commandDigest !== requiredText(row, 'storedCommandDigest') ||
    barrier.barrierDigest !== requiredText(row, 'storedBarrierDigest') ||
    barrier.startedAtMs !== requiredInteger(row, 'storedStartedAtMs') ||
    barrier.stepRunMutationDigest !==
      requiredText(row, 'storedMutationDigest') ||
    barrier.startedStepRunDigest !==
      requiredText(row, 'storedStartedStepRunDigest') ||
    barrier.traceDigest !== requiredText(row, 'storedTraceDigest') ||
    barrier.auditReceiptDigest !==
      requiredText(row, 'storedAuditReceiptDigest') ||
    barrier.projectId !== requiredText(row, 'storedArtifactProjectId') ||
    barrier.actionRef !== requiredText(row, 'storedArtifactActionRef') ||
    barrier.invocationArtifact.artifactId !==
      requiredText(row, 'storedInputArtifactId') ||
    barrier.invocationArtifact.artifactDigest !==
      requiredText(row, 'storedInputArtifactDigest') ||
    barrier.invocationArtifact.inputDigest !==
      requiredText(row, 'storedInputDigest') ||
    barrier.previewArtifact.artifactId !==
      requiredText(row, 'storedPreviewArtifactId') ||
    barrier.previewArtifact.artifactDigest !==
      requiredText(row, 'storedPreviewArtifactDigest') ||
    barrier.previewArtifact.actionDigest !==
      requiredText(row, 'storedArtifactActionDigest') ||
    barrier.previewArtifact.previewDigest !==
      requiredText(row, 'storedPreviewDigest') ||
    barrier.previewArtifact.redactionContractDigest !==
      requiredText(row, 'storedArtifactRedactionContractDigest') ||
    barrier.startedAtMs !== requiredInteger(row, 'storedArtifactBoundAtMs')
  ) {
    throw unavailable();
  }
  return barrier;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const number = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT')) ||
    (typeof number === 'number' && (number & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionStartBarrierError ||
    error instanceof ToolExecutionStartBarrierConflictError ||
    error instanceof ToolExecutionStartBarrierUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolExecutionStartBarrierConflictError()
    : unavailable(error);
}

function assertToolDefinitionIsNotQuarantined(
  client: DatabaseSync,
  projectId: string,
  definitionRef: string,
  definitionDigest: string,
): void {
  const quarantined = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
       JOIN "QingLong3ProjectToolDefinitionSnapshotSources" AS source
         ON source.project_id = quarantine.project_id
        AND source.package_name = quarantine.package_name
        AND source.installation_id = quarantine.installation_id
        AND source.lock_digest = quarantine.lock_digest
       JOIN "QingLong3ProjectToolDefinitionSnapshots" AS snapshot
         ON snapshot.project_id = source.project_id
        AND snapshot.active_vector_digest = source.active_vector_digest
       JOIN json_each(snapshot.snapshot_json, '$.definitions') AS definition
       WHERE quarantine.project_id = ?
         AND json_extract(definition.value, '$.packageName') =
           quarantine.package_name
         AND 'tool:' ||
           json_extract(definition.value, '$.definition.name') || '@' ||
           json_extract(definition.value, '$.definition.version') = ?
         AND json_extract(definition.value, '$.definitionDigest') = ?
       LIMIT 1`,
    )
    .get(projectId, definitionRef, definitionDigest);
  if (quarantined) {
    throw new ToolExecutionStartBarrierConflictError();
  }
}

function assertToolDefinitionHasActivePackageLifecycle(
  client: DatabaseSync,
  projectId: string,
  definitionRef: string,
  definitionDigest: string,
): void {
  const inactive = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageLifecycleHeads" AS lifecycle
       JOIN "QingLong3ProjectToolDefinitionSnapshotSources" AS source
         ON source.project_id = lifecycle.project_id
        AND source.package_name = lifecycle.package_name
        AND source.installation_id = lifecycle.installation_id
        AND source.lock_digest = lifecycle.lock_digest
       JOIN "QingLong3ProjectToolDefinitionSnapshots" AS snapshot
         ON snapshot.project_id = source.project_id
        AND snapshot.active_vector_digest = source.active_vector_digest
       JOIN json_each(snapshot.snapshot_json, '$.definitions') AS definition
       WHERE lifecycle.project_id = ?
         AND lifecycle.disposition <> 'active'
         AND json_extract(definition.value, '$.packageName') =
           lifecycle.package_name
         AND 'tool:' ||
           json_extract(definition.value, '$.definition.name') || '@' ||
           json_extract(definition.value, '$.definition.version') = ?
         AND json_extract(definition.value, '$.definitionDigest') = ?
       LIMIT 1`,
    )
    .get(projectId, definitionRef, definitionDigest);
  if (inactive) {
    throw new ToolExecutionStartBarrierConflictError();
  }
}

function insertAudit(
  client: DatabaseSync,
  audit: Readonly<SecurityAuditRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
         event_id, request_id, operation_id, project_id, subject_type,
         subject_id, authentication_id, outcome, reasons_json,
         fence_project_version, fence_binding_version, occurred_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    );
}

function insertEvidence(
  client: DatabaseSync,
  bundle: Readonly<ToolExecutionEvidenceBundle>,
): void {
  insertAudit(client, bundle.audit);
  const trace = bundle.trace;
  client
    .prepare(
      `INSERT INTO "ToolExecutionTraceAnchors" (
         trace_id, span_id, parent_span_id, project_id, run_id,
         step_run_id, invocation_plan_digest, binding_digest,
         adapter_digest, redaction_contract_digest,
         audit_contract_digest, created_at_ms, trace_digest, trace_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trace.traceId,
      trace.spanId,
      trace.parentSpanId,
      trace.projectId,
      trace.runId,
      trace.stepRunId,
      trace.invocationPlanDigest,
      trace.bindingDigest,
      trace.adapterDigest,
      trace.redactionContractDigest,
      trace.auditContractDigest,
      trace.createdAtMs,
      trace.traceDigest,
      JSON.stringify(trace),
    );
  const receipt = bundle.receipt;
  client
    .prepare(
      `INSERT INTO "ToolExecutionAuditReceipts" (
         event_id, project_id, run_id, step_run_id, trace_id, span_id,
         trace_digest, invocation_plan_digest, binding_digest,
         audit_record_digest, created_at_ms, receipt_digest,
         audit_json, receipt_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.eventId,
      receipt.projectId,
      receipt.runId,
      receipt.stepRunId,
      receipt.traceId,
      receipt.spanId,
      receipt.traceDigest,
      receipt.invocationPlanDigest,
      receipt.bindingDigest,
      receipt.auditRecordDigest,
      receipt.createdAtMs,
      receipt.receiptDigest,
      JSON.stringify(bundle.audit),
      JSON.stringify(receipt),
    );
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const stepRun = mutation.stepRun;
  const result = client
    .prepare(
      `UPDATE "StepRuns"
       SET "status" = ?, "version" = ?, "attempt_count" = ?,
           "output_ref" = ?, "approval_request_id" = ?, "ready_at_ms" = ?,
           "started_at_ms" = ?, "finished_at_ms" = ?, "result_code" = ?,
           "error_summary" = ?, "updated_at_ms" = ?,
           "last_mutation_id" = ?, "step_run_digest" = ?,
           "step_run_json" = ?
       WHERE "id" = ? AND "run_id" = ? AND "version" = ?
         AND "step_run_digest" = ? AND "status" = ?`,
    )
    .run(
      stepRun.status,
      stepRun.version,
      stepRun.attemptCount,
      stepRun.outputRef,
      stepRun.approvalRequestId,
      stepRun.readyAtMs,
      stepRun.startedAtMs,
      stepRun.finishedAtMs,
      stepRun.resultCode,
      stepRun.errorSummary,
      stepRun.updatedAtMs,
      stepRun.lastMutationId,
      stepRun.stepRunDigest,
      JSON.stringify(stepRun),
      stepRun.id,
      stepRun.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    );
  if (result.changes !== 1) {
    throw new ToolExecutionStartBarrierConflictError();
  }
}

function appendRunEvent(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const event = mutation.event;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         "id", "run_id", "sequence", "type", "dedupe_key", "actor_type",
         "actor_id", "attempt_id", "step_run_id", "payload", "created_at_ms"
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

function insertStepRunMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         "mutation_id", "mutation_digest", "run_id", "step_run_id",
         "step_run_digest", "event_id", "event_sequence",
         "run_version", "step_run_json", "committed_at_ms"
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

function insertBarrier(
  client: DatabaseSync,
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ToolExecutionStartBarriers" (
         start_id, project_id, run_id, step_run_id,
         started_step_run_version, step_run_mutation_id, run_event_id,
         trace_id, span_id, audit_event_id, command_digest,
         barrier_digest, started_at_ms, barrier_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      barrier.startId,
      barrier.projectId,
      barrier.runId,
      barrier.stepRunId,
      barrier.startedStepRunVersion,
      barrier.stepRunMutationId,
      barrier.runEventId,
      barrier.traceId,
      barrier.spanId,
      barrier.auditEventId,
      barrier.commandDigest,
      barrier.barrierDigest,
      barrier.startedAtMs,
      JSON.stringify(barrier),
    );
}

function insertArtifactBinding(
  client: DatabaseSync,
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ToolExecutionStartArtifactBindings" (
         start_id, project_id, action_ref,
         input_artifact_id, input_artifact_digest, input_digest,
         preview_artifact_id, preview_artifact_digest, action_digest,
         preview_digest, redaction_contract_digest, bound_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      barrier.startId,
      barrier.projectId,
      barrier.actionRef,
      barrier.invocationArtifact.artifactId,
      barrier.invocationArtifact.artifactDigest,
      barrier.invocationArtifact.inputDigest,
      barrier.previewArtifact.artifactId,
      barrier.previewArtifact.artifactDigest,
      barrier.previewArtifact.actionDigest,
      barrier.previewArtifact.previewDigest,
      barrier.previewArtifact.redactionContractDigest,
      barrier.startedAtMs,
    );
}

export class LocalSqliteToolExecutionStartBarrierRepository
  implements ToolExecutionStartBarrierRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.client = this.authority.client;
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(async () => {
      try {
        return work();
      } catch (error) {
        throw mapStorageError(error);
      }
    }, unavailable);
  }

  private findRows(where: string, values: readonly (string | number)[]): Row[] {
    return this.client
      .prepare(
        `SELECT ${BARRIER_SELECT}
         FROM "ToolExecutionStartBarriers" AS barrier
         JOIN "StepRunMutations" AS mutation
           ON mutation.mutation_id = barrier.step_run_mutation_id
         JOIN "ToolExecutionTraceAnchors" AS trace
           ON trace.trace_id = barrier.trace_id
          AND trace.span_id = barrier.span_id
         JOIN "ToolExecutionAuditReceipts" AS receipt
           ON receipt.event_id = barrier.audit_event_id
         LEFT JOIN "ToolExecutionStartArtifactBindings" AS artifact_binding
           ON artifact_binding.start_id = barrier.start_id
         WHERE ${where}
         LIMIT 2`,
      )
      .all(...values) as Row[];
  }

  findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    return this.enqueue(() => {
      const rows = this.findRows('barrier.start_id = ?', [startId]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? barrierFromRow(rows[0]) : null;
    });
  }

  findByStepRun(
    runIdValue: string,
    stepRunIdValue: string,
    startedStepRunVersionValue: number,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null> {
    const runId = identity(runIdValue, 'Run id');
    const stepRunId = identity(stepRunIdValue, 'StepRun id');
    const startedStepRunVersion = version(startedStepRunVersionValue);
    return this.enqueue(() => {
      const rows = this.findRows(
        `barrier.run_id = ? AND barrier.step_run_id = ?
         AND barrier.started_step_run_version = ?`,
        [runId, stepRunId, startedStepRunVersion],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? barrierFromRow(rows[0]) : null;
    });
  }

  prepare(
    commandValue: ToolExecutionStartCommand,
  ): Promise<Readonly<PrepareToolExecutionStartResult>> {
    const command = normalizeToolExecutionStartCommand(commandValue);
    const barrier = toolExecutionStartBarrierRecord(command);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const existing = this.findRows(
          `barrier.start_id = ?
           OR barrier.step_run_mutation_id = ?
           OR barrier.run_event_id = ?
           OR (barrier.trace_id = ? AND barrier.span_id = ?)
           OR barrier.audit_event_id = ?
           OR (
             barrier.run_id = ? AND barrier.step_run_id = ?
             AND barrier.started_step_run_version = ?
           )`,
          [
            barrier.startId,
            barrier.stepRunMutationId,
            barrier.runEventId,
            barrier.traceId,
            barrier.spanId,
            barrier.auditEventId,
            barrier.runId,
            barrier.stepRunId,
            barrier.startedStepRunVersion,
          ],
        );
        if (existing.length > 1) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        if (existing[0]) {
          const stored = barrierFromRow(existing[0]);
          if (JSON.stringify(stored) !== JSON.stringify(barrier)) {
            throw new ToolExecutionStartBarrierConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', barrier: stored });
        }

        const mutation = command.stepRunMutation;
        const current = this.client
          .prepare(
            `SELECT
               step.kind AS "stepKind",
               step.status AS "stepStatus",
               step.version AS "stepVersion",
               step.step_run_digest AS "stepDigest",
               step.definition_ref AS "definitionRef",
               step.definition_digest AS "definitionDigest",
               run.project_id AS "projectId",
               run.status AS "runStatus",
               run.version AS "runVersion",
               run.event_sequence AS "runEventSequence"
             FROM "StepRuns" AS step
             JOIN "Runs" AS run ON run.id = step.run_id
             WHERE step.id = ? AND step.run_id = ?
             LIMIT 2`,
          )
          .all(barrier.stepRunId, barrier.runId) as Row[];
        if (
          current.length !== 1 ||
          requiredText(current[0]!, 'stepKind') !== 'tool' ||
          requiredText(current[0]!, 'stepStatus') !== mutation.previousStatus ||
          requiredInteger(current[0]!, 'stepVersion') !==
            mutation.expectedStepRunVersion ||
          requiredText(current[0]!, 'stepDigest') !==
            mutation.expectedStepRunDigest ||
          requiredText(current[0]!, 'definitionRef') !==
            mutation.stepRun.definitionRef ||
          requiredText(current[0]!, 'definitionDigest') !==
            mutation.stepRun.definitionDigest ||
          requiredText(current[0]!, 'projectId') !== barrier.projectId ||
          requiredInteger(current[0]!, 'runVersion') !==
            mutation.expectedRunVersion ||
          requiredInteger(current[0]!, 'runEventSequence') !==
            mutation.expectedRunEventSequence ||
          TERMINAL_RUN_STATUSES.has(requiredText(current[0]!, 'runStatus'))
        ) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        assertToolDefinitionIsNotQuarantined(
          this.client,
          barrier.projectId,
          mutation.stepRun.definitionRef,
          mutation.stepRun.definitionDigest,
        );
        assertToolDefinitionHasActivePackageLifecycle(
          this.client,
          barrier.projectId,
          mutation.stepRun.definitionRef,
          mutation.stepRun.definitionDigest,
        );

        insertEvidence(this.client, command.evidence);
        updateStepRun(this.client, mutation);
        const runResult = this.client
          .prepare(
            `UPDATE "Runs"
             SET "version" = "version" + 1,
                 "event_sequence" = "event_sequence" + 1
             WHERE "id" = ? AND "version" = ? AND "event_sequence" = ?`,
          )
          .run(
            mutation.runId,
            mutation.expectedRunVersion,
            mutation.expectedRunEventSequence,
          );
        if (runResult.changes !== 1) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        appendRunEvent(this.client, mutation);
        insertStepRunMutation(this.client, mutation);
        insertBarrier(this.client, barrier);
        insertArtifactBinding(this.client, barrier);

        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', barrier });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; the shared authority owns close.
          }
        }
        throw error;
      }
    });
  }
}
