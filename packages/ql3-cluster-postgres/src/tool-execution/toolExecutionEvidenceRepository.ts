import {
  InvalidToolExecutionEvidenceError,
  ToolExecutionEvidenceConflictError,
  ToolExecutionEvidenceUnavailableError,
  normalizeListToolExecutionEvidenceQuery,
  normalizeListToolExecutionEvidenceResult,
  normalizeToolExecutionEvidenceBundle,
  type ListToolExecutionEvidenceQuery,
  type ListToolExecutionEvidenceResult,
  type PrepareToolExecutionEvidenceResult,
  type ToolExecutionEvidenceBundle,
  type ToolExecutionEvidenceRepository,
} from '@qinglong/runtime-core/tool-execution-evidence';
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

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const AUDIT_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const EVIDENCE_SELECT = `
  trace.trace_json AS "traceJson",
  receipt.audit_json AS "auditJson",
  receipt.receipt_json AS "receiptJson",
  trace.trace_id AS "storedTraceId",
  trace.span_id AS "storedSpanId",
  trace.parent_span_id AS "storedParentSpanId",
  trace.project_id AS "traceProjectId",
  trace.run_id AS "traceRunId",
  trace.step_run_id AS "traceStepRunId",
  trace.invocation_plan_digest AS "traceInvocationPlanDigest",
  trace.binding_digest AS "traceBindingDigest",
  trace.adapter_digest AS "storedAdapterDigest",
  trace.redaction_contract_digest AS "storedRedactionContractDigest",
  trace.audit_contract_digest AS "storedAuditContractDigest",
  trace.created_at_ms AS "traceCreatedAtMs",
  trace.trace_digest AS "storedTraceDigest",
  receipt.event_id AS "storedEventId",
  receipt.project_id AS "receiptProjectId",
  receipt.run_id AS "receiptRunId",
  receipt.step_run_id AS "receiptStepRunId",
  receipt.trace_id AS "receiptTraceId",
  receipt.span_id AS "receiptSpanId",
  receipt.trace_digest AS "receiptTraceDigest",
  receipt.invocation_plan_digest AS "receiptInvocationPlanDigest",
  receipt.binding_digest AS "receiptBindingDigest",
  receipt.audit_record_digest AS "storedAuditRecordDigest",
  receipt.created_at_ms AS "receiptCreatedAtMs",
  receipt.receipt_digest AS "storedReceiptDigest"
`;

function unavailable(
  cause?: unknown,
): ToolExecutionEvidenceUnavailableError {
  return new ToolExecutionEvidenceUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function identity(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new InvalidToolExecutionEvidenceError(`${label} is invalid`);
  }
  return value;
}

function requiredText(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function requiredInteger(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return postgresRequiredString(value, unavailable);
}

function jsonObject(row: Row, key: string): Readonly<Record<string, unknown>> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function bundleFromRow(
  row: Row,
): Readonly<ToolExecutionEvidenceBundle> {
  let bundle: Readonly<ToolExecutionEvidenceBundle>;
  try {
    bundle = normalizeToolExecutionEvidenceBundle({
      schema: 'qinglong/tool-execution-evidence-bundle@v1',
      trace: jsonObject(row, 'traceJson'),
      audit: jsonObject(row, 'auditJson'),
      receipt: jsonObject(row, 'receiptJson'),
    } as unknown as ToolExecutionEvidenceBundle);
  } catch {
    throw unavailable();
  }
  const trace = bundle.trace;
  const receipt = bundle.receipt;
  if (
    requiredText(row, 'storedTraceId') !== trace.traceId ||
    requiredText(row, 'storedSpanId') !== trace.spanId ||
    nullableText(row, 'storedParentSpanId') !== trace.parentSpanId ||
    requiredText(row, 'traceProjectId') !== trace.projectId ||
    requiredText(row, 'traceRunId') !== trace.runId ||
    requiredText(row, 'traceStepRunId') !== trace.stepRunId ||
    requiredText(row, 'traceInvocationPlanDigest') !==
      trace.invocationPlanDigest ||
    requiredText(row, 'traceBindingDigest') !== trace.bindingDigest ||
    requiredText(row, 'storedAdapterDigest') !== trace.adapterDigest ||
    requiredText(row, 'storedRedactionContractDigest') !==
      trace.redactionContractDigest ||
    requiredText(row, 'storedAuditContractDigest') !==
      trace.auditContractDigest ||
    requiredInteger(row, 'traceCreatedAtMs') !== trace.createdAtMs ||
    requiredText(row, 'storedTraceDigest') !== trace.traceDigest ||
    requiredText(row, 'storedEventId') !== receipt.eventId ||
    requiredText(row, 'receiptProjectId') !== receipt.projectId ||
    requiredText(row, 'receiptRunId') !== receipt.runId ||
    requiredText(row, 'receiptStepRunId') !== receipt.stepRunId ||
    requiredText(row, 'receiptTraceId') !== receipt.traceId ||
    requiredText(row, 'receiptSpanId') !== receipt.spanId ||
    requiredText(row, 'receiptTraceDigest') !== receipt.traceDigest ||
    requiredText(row, 'receiptInvocationPlanDigest') !==
      receipt.invocationPlanDigest ||
    requiredText(row, 'receiptBindingDigest') !== receipt.bindingDigest ||
    requiredText(row, 'storedAuditRecordDigest') !==
      receipt.auditRecordDigest ||
    requiredInteger(row, 'receiptCreatedAtMs') !== receipt.createdAtMs ||
    requiredText(row, 'storedReceiptDigest') !== receipt.receiptDigest
  ) {
    throw unavailable();
  }
  return bundle;
}

function constraintError(error: unknown): boolean {
  const state = postgresSqlState(error);
  return state === '23503' || state === '23505' || state === '23514';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionEvidenceError ||
    error instanceof ToolExecutionEvidenceConflictError ||
    error instanceof ToolExecutionEvidenceUnavailableError
  ) {
    return error;
  }
  return constraintError(error)
    ? new ToolExecutionEvidenceConflictError()
    : unavailable(error);
}

async function findRows(
  queryable: PostgresQueryable,
  where: string,
  values: readonly unknown[],
  limit = 2,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${EVIDENCE_SELECT}
     FROM "ql3"."tool_execution_trace_anchors" AS trace
     JOIN "ql3"."tool_execution_audit_receipts" AS receipt
       ON receipt.trace_id = trace.trace_id
      AND receipt.span_id = trace.span_id
     WHERE ${where}
     LIMIT ${limit}`,
    values,
  );
  return result.rows;
}

async function insertAudit(
  client: PostgresClient,
  bundle: Readonly<ToolExecutionEvidenceBundle>,
): Promise<void> {
  const audit = bundle.audit;
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id, subject_type,
       subject_id, authentication_id, outcome, reasons, project_version,
       binding_version, occurred_at_ms
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
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
}

async function insertTraceAndReceipt(
  client: PostgresClient,
  bundle: Readonly<ToolExecutionEvidenceBundle>,
): Promise<void> {
  const trace = bundle.trace;
  await client.query(
    `INSERT INTO "ql3"."tool_execution_trace_anchors" (
       trace_id, span_id, parent_span_id, project_id, run_id, step_run_id,
       invocation_plan_digest, binding_digest, adapter_digest,
       redaction_contract_digest, audit_contract_digest, created_at_ms,
       trace_digest, trace_json
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
  const receipt = bundle.receipt;
  await client.query(
    `INSERT INTO "ql3"."tool_execution_audit_receipts" (
       event_id, project_id, run_id, step_run_id, trace_id, span_id,
       trace_digest, invocation_plan_digest, binding_digest,
       audit_record_digest, created_at_ms, receipt_digest, audit_json,
       receipt_json
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
      JSON.stringify(bundle.audit),
      JSON.stringify(receipt),
    ],
  );
}

export class PostgresToolExecutionEvidenceRepository
  implements ToolExecutionEvidenceRepository
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

  async findByTrace(
    traceIdValue: string,
    spanIdValue: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null> {
    const traceId = identity(traceIdValue, TRACE_ID_PATTERN, 'traceId');
    const spanId = identity(spanIdValue, SPAN_ID_PATTERN, 'spanId');
    try {
      const rows = await findRows(
        this.pool,
        'trace.trace_id = $1 AND trace.span_id = $2',
        [traceId, spanId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? bundleFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByAuditEventId(
    eventIdValue: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null> {
    const eventId = identity(
      eventIdValue,
      AUDIT_EVENT_ID_PATTERN,
      'audit eventId',
    );
    try {
      const rows = await findRows(
        this.pool,
        'receipt.event_id = $1::uuid',
        [eventId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? bundleFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listByRun(
    queryValue: ListToolExecutionEvidenceQuery,
  ): Promise<ListToolExecutionEvidenceResult> {
    const query = normalizeListToolExecutionEvidenceQuery(queryValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${EVIDENCE_SELECT}
         FROM "ql3"."tool_execution_trace_anchors" AS trace
         JOIN "ql3"."tool_execution_audit_receipts" AS receipt
           ON receipt.trace_id = trace.trace_id
          AND receipt.span_id = trace.span_id
         WHERE trace.run_id = $1 AND (
           $2::char(32) IS NULL OR trace.created_at_ms > $3 OR
           (trace.created_at_ms = $3 AND trace.trace_id > $2) OR
           (trace.created_at_ms = $3 AND trace.trace_id = $2
             AND trace.span_id > $4)
         )
         ORDER BY trace.created_at_ms, trace.trace_id, trace.span_id
         LIMIT $5`,
        [
          query.runId,
          query.after?.traceId ?? null,
          query.after?.createdAtMs ?? 0,
          query.after?.spanId ?? '',
          query.limit + 1,
        ],
      );
      const truncated = result.rows.length > query.limit;
      const bundles = result.rows.slice(0, query.limit).map(bundleFromRow);
      const last = bundles.at(-1);
      return normalizeListToolExecutionEvidenceResult(
        {
          bundles,
          truncated,
          ...(truncated && last
            ? {
                next: {
                  createdAtMs: last.trace.createdAtMs,
                  traceId: last.trace.traceId,
                  spanId: last.trace.spanId,
                },
              }
            : {}),
        },
        query,
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async prepare(
    bundleValue: ToolExecutionEvidenceBundle,
  ): Promise<Readonly<PrepareToolExecutionEvidenceResult>> {
    const bundle = normalizeToolExecutionEvidenceBundle(bundleValue);
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
          'receipt.event_id = $1::uuid OR (trace.trace_id = $2 AND trace.span_id = $3)',
          [
            bundle.receipt.eventId,
            bundle.trace.traceId,
            bundle.trace.spanId,
          ],
          3,
        );
        if (existing.length > 1) {
          throw new ToolExecutionEvidenceConflictError();
        }
        if (existing[0]) {
          const stored = bundleFromRow(existing[0]);
          if (JSON.stringify(stored) !== JSON.stringify(bundle)) {
            throw new ToolExecutionEvidenceConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', bundle: stored });
        }

        const step = await client.query<Row>(
          `SELECT step.kind, step.status, run.project_id AS "projectId"
           FROM "ql3"."step_runs" AS step
           JOIN "ql3"."runs" AS run ON run.id = step.run_id
           WHERE step.id = $1 AND step.run_id = $2
           LIMIT 2
           FOR SHARE OF step, run`,
          [bundle.trace.stepRunId, bundle.trace.runId],
        );
        if (
          step.rows.length !== 1 ||
          requiredText(step.rows[0]!, 'kind') !== 'tool' ||
          !['ready', 'waiting_approval'].includes(
            requiredText(step.rows[0]!, 'status'),
          ) ||
          requiredText(step.rows[0]!, 'projectId') !==
            bundle.trace.projectId
        ) {
          throw new ToolExecutionEvidenceConflictError();
        }

        await insertAudit(client, bundle);
        await insertTraceAndReceipt(client, bundle);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', bundle });
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
