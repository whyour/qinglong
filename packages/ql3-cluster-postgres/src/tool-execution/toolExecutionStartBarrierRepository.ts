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
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

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
  barrier.audit_event_id::text AS "storedAuditEventId",
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
  return postgresRequiredString(row[key], unavailable);
}

function requiredInteger(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
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

function barrierFromRow(
  row: Row,
): Readonly<ToolExecutionStartBarrierRecord> {
  let barrier: Readonly<ToolExecutionStartBarrierRecord>;
  try {
    barrier = normalizeToolExecutionStartBarrierRecord(
      postgresRequiredJsonObject(
        row.barrierJson,
        unavailable,
      ) as unknown as ToolExecutionStartBarrierRecord,
    );
  } catch (error) {
    if (error instanceof ToolExecutionStartBarrierUnavailableError) {
      throw error;
    }
    throw unavailable(error);
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

function constraintError(error: unknown): boolean {
  const state = postgresSqlState(error);
  return state === '23503' || state === '23505' || state === '23514';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionStartBarrierError ||
    error instanceof ToolExecutionStartBarrierConflictError ||
    error instanceof ToolExecutionStartBarrierUnavailableError
  ) {
    return error;
  }
  return constraintError(error)
    ? new ToolExecutionStartBarrierConflictError()
    : unavailable(error);
}

async function findRows(
  queryable: PostgresQueryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${BARRIER_SELECT}
     FROM "ql3"."tool_execution_start_barriers" AS barrier
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = barrier.step_run_mutation_id
     JOIN "ql3"."tool_execution_trace_anchors" AS trace
       ON trace.trace_id = barrier.trace_id
      AND trace.span_id = barrier.span_id
     JOIN "ql3"."tool_execution_audit_receipts" AS receipt
       ON receipt.event_id = barrier.audit_event_id
     LEFT JOIN "ql3"."tool_execution_start_artifact_bindings"
       AS artifact_binding
       ON artifact_binding.start_id = barrier.start_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export class PostgresToolExecutionStartBarrierRepository
  implements ToolExecutionStartBarrierRepository
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

  async findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    try {
      const rows = await findRows(
        this.pool,
        'barrier.start_id = $1',
        [startId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? barrierFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByStepRun(
    runIdValue: string,
    stepRunIdValue: string,
    startedStepRunVersionValue: number,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null> {
    const runId = identity(runIdValue, 'Run id');
    const stepRunId = identity(stepRunIdValue, 'StepRun id');
    const startedStepRunVersion = version(startedStepRunVersionValue);
    try {
      const rows = await findRows(
        this.pool,
        `barrier.run_id = $1 AND barrier.step_run_id = $2
         AND barrier.started_step_run_version = $3`,
        [runId, stepRunId, startedStepRunVersion],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? barrierFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async prepare(
    commandValue: ToolExecutionStartCommand,
  ): Promise<Readonly<PrepareToolExecutionStartResult>> {
    const command = normalizeToolExecutionStartCommand(commandValue);
    const barrier = toolExecutionStartBarrierRecord(command);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw unavailable(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const existing = await findRows(
          client,
          `barrier.start_id = $1
           OR barrier.step_run_mutation_id = $2
           OR barrier.run_event_id = $3
           OR (barrier.trace_id = $4 AND barrier.span_id = $5)
           OR barrier.audit_event_id = $6::uuid
           OR (
             barrier.run_id = $7 AND barrier.step_run_id = $8
             AND barrier.started_step_run_version = $9
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
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', barrier: stored });
        }

        const mutation = command.stepRunMutation;
        const current = await client.query<Row>(
          `SELECT
             step.kind AS "stepKind", step.status AS "stepStatus",
             step.version AS "stepVersion",
             step.step_run_digest AS "stepDigest",
             step.definition_ref AS "definitionRef",
             step.definition_digest AS "definitionDigest",
             run.project_id AS "projectId", run.status AS "runStatus",
             run.version AS "runVersion",
             run.event_sequence AS "runEventSequence"
           FROM "ql3"."step_runs" AS step
           JOIN "ql3"."runs" AS run ON run.id = step.run_id
           WHERE step.id = $1 AND step.run_id = $2
           LIMIT 2
           FOR UPDATE OF step, run`,
          [barrier.stepRunId, barrier.runId],
        );
        const row = current.rows[0];
        if (
          current.rows.length !== 1 ||
          !row ||
          requiredText(row, 'stepKind') !== 'tool' ||
          requiredText(row, 'stepStatus') !== mutation.previousStatus ||
          requiredInteger(row, 'stepVersion') !==
            mutation.expectedStepRunVersion ||
          requiredText(row, 'stepDigest') !==
            mutation.expectedStepRunDigest ||
          requiredText(row, 'definitionRef') !==
            mutation.stepRun.definitionRef ||
          requiredText(row, 'definitionDigest') !==
            mutation.stepRun.definitionDigest ||
          requiredText(row, 'projectId') !== barrier.projectId ||
          requiredInteger(row, 'runVersion') !==
            mutation.expectedRunVersion ||
          requiredInteger(row, 'runEventSequence') !==
            mutation.expectedRunEventSequence ||
          TERMINAL_RUN_STATUSES.has(requiredText(row, 'runStatus'))
        ) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        const quarantineFence = await client.query<Row>(
          `SELECT "ql3"."plugin_package_tool_start_allowed"(
             $1::varchar, $2::varchar, $3::char(64)
           ) AS "allowed"`,
          [
            barrier.projectId,
            mutation.stepRun.definitionRef,
            mutation.stepRun.definitionDigest,
          ],
        );
        if (
          quarantineFence.rows.length !== 1 ||
          quarantineFence.rows[0]?.allowed !== true
        ) {
          throw new ToolExecutionStartBarrierConflictError();
        }

        const evidence = command.evidence;
        const audit = evidence.audit;
        await client.query(
          `INSERT INTO "ql3"."security_audit_events" (
             event_id, request_id, operation_id, project_id, subject_type,
             subject_id, authentication_id, outcome, reasons,
             project_version, binding_version, occurred_at_ms
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             $10, $11, $12
           )`,
          [
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
          ],
        );
        const trace = evidence.trace;
        await client.query(
          `INSERT INTO "ql3"."tool_execution_trace_anchors" (
             trace_id, span_id, parent_span_id, project_id, run_id,
             step_run_id, invocation_plan_digest, binding_digest,
             adapter_digest, redaction_contract_digest,
             audit_contract_digest, created_at_ms, trace_digest, trace_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14::jsonb
           )`,
          [
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
          ],
        );
        const receipt = evidence.receipt;
        await client.query(
          `INSERT INTO "ql3"."tool_execution_audit_receipts" (
             event_id, project_id, run_id, step_run_id, trace_id, span_id,
             trace_digest, invocation_plan_digest, binding_digest,
             audit_record_digest, created_at_ms, receipt_digest,
             audit_json, receipt_json
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::jsonb, $14::jsonb
           )`,
          [
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
            JSON.stringify(evidence.audit),
            JSON.stringify(receipt),
          ],
        );
        const step = mutation.stepRun;
        const updatedStep = await client.query(
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
        if (updatedStep.rowCount !== 1) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        const updatedRun = await client.query(
          `UPDATE "ql3"."runs"
           SET version = version + 1, event_sequence = event_sequence + 1
           WHERE id = $1 AND version = $2 AND event_sequence = $3`,
          [
            mutation.runId,
            mutation.expectedRunVersion,
            mutation.expectedRunEventSequence,
          ],
        );
        if (updatedRun.rowCount !== 1) {
          throw new ToolExecutionStartBarrierConflictError();
        }
        const event = mutation.event;
        await client.query(
          `INSERT INTO "ql3"."run_events" (
             id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
             attempt_id, step_run_id, payload, created_at_ms
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10
           )`,
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
             mutation_id, mutation_digest, run_id, step_run_id,
             step_run_digest, event_id, event_sequence, run_version,
             step_run_json, committed_at_ms
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             floor(
               extract(epoch FROM transaction_timestamp()) * 1000
             )::bigint
           )`,
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
        await client.query(
          `INSERT INTO "ql3"."tool_execution_start_barriers" (
             start_id, project_id, run_id, step_run_id,
             started_step_run_version, step_run_mutation_id, run_event_id,
             trace_id, span_id, audit_event_id, command_digest,
             barrier_digest, started_at_ms, barrier_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12,
             $13, $14::jsonb
           )`,
          [
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
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."tool_execution_start_artifact_bindings" (
             start_id, project_id, action_ref,
             input_artifact_id, input_artifact_digest, input_digest,
             preview_artifact_id, preview_artifact_digest, action_digest,
             preview_digest, redaction_contract_digest, bound_at_ms
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
           )`,
          [
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
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', barrier });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          ((state &&
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state)) ||
            state === '23505') &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
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
