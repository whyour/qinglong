import type { DatabaseSync } from 'node:sqlite';

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
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

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
  trace.run_id AS "traceRunId",
  trace.step_run_id AS "traceStepRunId",
  trace.trace_digest AS "storedTraceDigest",
  trace.created_at_ms AS "traceCreatedAtMs",
  receipt.event_id AS "storedEventId",
  receipt.run_id AS "receiptRunId",
  receipt.step_run_id AS "receiptStepRunId",
  receipt.trace_id AS "receiptTraceId",
  receipt.span_id AS "receiptSpanId",
  receipt.receipt_digest AS "storedReceiptDigest",
  receipt.created_at_ms AS "receiptCreatedAtMs",
  audit.event_id AS "auditEventId",
  audit.request_id AS "auditRequestId",
  audit.operation_id AS "auditOperationId",
  audit.project_id AS "auditProjectId",
  audit.subject_type AS "auditSubjectType",
  audit.subject_id AS "auditSubjectId",
  audit.authentication_id AS "auditAuthenticationId",
  audit.outcome AS "auditOutcome",
  audit.reasons_json AS "auditReasonsJson",
  audit.fence_project_version AS "auditProjectVersion",
  audit.fence_binding_version AS "auditBindingVersion",
  audit.occurred_at_ms AS "auditOccurredAtMs"
`;

function unavailable(cause?: unknown): ToolExecutionEvidenceUnavailableError {
  return new ToolExecutionEvidenceUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function traceIdentity(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new InvalidToolExecutionEvidenceError(`${label} is invalid`);
  }
  return value;
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

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') throw unavailable();
  return value as string | null;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw unavailable();
  }
  return value as number | null;
}

function parseJson(row: Row, key: string): unknown {
  try {
    return JSON.parse(requiredText(row, key));
  } catch {
    throw unavailable();
  }
}

function auditFromColumns(row: Row): Readonly<SecurityAuditRecord> {
  let reasons: unknown;
  try {
    reasons = JSON.parse(requiredText(row, 'auditReasonsJson'));
  } catch {
    throw unavailable();
  }
  const subjectType = nullableText(row, 'auditSubjectType');
  const subjectId = nullableText(row, 'auditSubjectId');
  const projectVersion = nullableInteger(row, 'auditProjectVersion');
  const bindingVersion = nullableInteger(row, 'auditBindingVersion');
  try {
    return normalizeSecurityAuditRecord({
      eventId: requiredText(row, 'auditEventId'),
      requestId: requiredText(row, 'auditRequestId'),
      operationId: requiredText(row, 'auditOperationId'),
      projectId: nullableText(row, 'auditProjectId'),
      subject:
        subjectType === null && subjectId === null
          ? null
          : {
              type: subjectType as NonNullable<
                SecurityAuditRecord['subject']
              >['type'],
              id: subjectId!,
            },
      authenticationId: nullableText(row, 'auditAuthenticationId'),
      outcome: requiredText(
        row,
        'auditOutcome',
      ) as SecurityAuditRecord['outcome'],
      reasons: reasons as readonly string[],
      fence:
        projectVersion === null
          ? null
          : {
              projectVersion,
              bindingVersion,
            },
      occurredAtMs: requiredInteger(row, 'auditOccurredAtMs'),
    });
  } catch {
    throw unavailable();
  }
}

function bundleFromRow(row: Row): Readonly<ToolExecutionEvidenceBundle> {
  let bundle: Readonly<ToolExecutionEvidenceBundle>;
  try {
    bundle = normalizeToolExecutionEvidenceBundle({
      schema: 'qinglong/tool-execution-evidence-bundle@v1',
      trace: parseJson(row, 'traceJson'),
      audit: parseJson(row, 'auditJson'),
      receipt: parseJson(row, 'receiptJson'),
    } as ToolExecutionEvidenceBundle);
  } catch {
    throw unavailable();
  }
  const storedAudit = auditFromColumns(row);
  if (
    JSON.stringify(storedAudit) !== JSON.stringify(bundle.audit) ||
    requiredText(row, 'storedTraceId') !== bundle.trace.traceId ||
    requiredText(row, 'storedSpanId') !== bundle.trace.spanId ||
    requiredText(row, 'traceRunId') !== bundle.trace.runId ||
    requiredText(row, 'traceStepRunId') !== bundle.trace.stepRunId ||
    requiredText(row, 'storedTraceDigest') !== bundle.trace.traceDigest ||
    requiredInteger(row, 'traceCreatedAtMs') !== bundle.trace.createdAtMs ||
    requiredText(row, 'storedEventId') !== bundle.receipt.eventId ||
    requiredText(row, 'receiptRunId') !== bundle.receipt.runId ||
    requiredText(row, 'receiptStepRunId') !== bundle.receipt.stepRunId ||
    requiredText(row, 'receiptTraceId') !== bundle.receipt.traceId ||
    requiredText(row, 'receiptSpanId') !== bundle.receipt.spanId ||
    requiredText(row, 'storedReceiptDigest') !==
      bundle.receipt.receiptDigest ||
    requiredInteger(row, 'receiptCreatedAtMs') !==
      bundle.receipt.createdAtMs
  ) {
    throw unavailable();
  }
  return bundle;
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
    error instanceof InvalidToolExecutionEvidenceError ||
    error instanceof ToolExecutionEvidenceConflictError ||
    error instanceof ToolExecutionEvidenceUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolExecutionEvidenceConflictError()
    : unavailable(error);
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

export class LocalSqliteToolExecutionEvidenceRepository
  implements ToolExecutionEvidenceRepository
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
    return this.authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      unavailable,
    );
  }

  private findRows(
    where: string,
    values: readonly (string | number | null)[],
  ): Row[] {
    return this.client
      .prepare(
        `SELECT ${EVIDENCE_SELECT}
         FROM "ToolExecutionTraceAnchors" AS trace
         JOIN "ToolExecutionAuditReceipts" AS receipt
           ON receipt.trace_id = trace.trace_id
          AND receipt.span_id = trace.span_id
         JOIN "QingLong3SecurityAuditEvents" AS audit
           ON audit.event_id = receipt.event_id
         WHERE ${where}
         LIMIT 2`,
      )
      .all(...values) as Row[];
  }

  findByTrace(
    traceIdValue: string,
    spanIdValue: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null> {
    const traceId = traceIdentity(
      traceIdValue,
      TRACE_ID_PATTERN,
      'traceId',
    );
    const spanId = traceIdentity(spanIdValue, SPAN_ID_PATTERN, 'spanId');
    return this.enqueue(() => {
      const rows = this.findRows(
        'trace.trace_id = ? AND trace.span_id = ?',
        [traceId, spanId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? bundleFromRow(rows[0]) : null;
    });
  }

  findByAuditEventId(
    eventIdValue: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null> {
    const eventId = traceIdentity(
      eventIdValue,
      AUDIT_EVENT_ID_PATTERN,
      'audit eventId',
    );
    return this.enqueue(() => {
      const rows = this.findRows('receipt.event_id = ?', [eventId]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? bundleFromRow(rows[0]) : null;
    });
  }

  listByRun(
    queryValue: ListToolExecutionEvidenceQuery,
  ): Promise<ListToolExecutionEvidenceResult> {
    const query = normalizeListToolExecutionEvidenceQuery(queryValue);
    return this.enqueue(() => {
      const rows = this.client
        .prepare(
          `SELECT ${EVIDENCE_SELECT}
           FROM "ToolExecutionTraceAnchors" AS trace
           JOIN "ToolExecutionAuditReceipts" AS receipt
             ON receipt.trace_id = trace.trace_id
            AND receipt.span_id = trace.span_id
           JOIN "QingLong3SecurityAuditEvents" AS audit
             ON audit.event_id = receipt.event_id
           WHERE trace.run_id = ? AND (
             ? IS NULL OR trace.created_at_ms > ? OR
             (trace.created_at_ms = ? AND trace.trace_id > ?) OR
             (trace.created_at_ms = ? AND trace.trace_id = ?
               AND trace.span_id > ?)
           )
           ORDER BY trace.created_at_ms, trace.trace_id, trace.span_id
           LIMIT ?`,
        )
        .all(
          query.runId,
          query.after?.traceId ?? null,
          query.after?.createdAtMs ?? 0,
          query.after?.createdAtMs ?? 0,
          query.after?.traceId ?? '',
          query.after?.createdAtMs ?? 0,
          query.after?.traceId ?? '',
          query.after?.spanId ?? '',
          query.limit + 1,
        ) as Row[];
      const truncated = rows.length > query.limit;
      const bundles = rows.slice(0, query.limit).map(bundleFromRow);
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
    });
  }

  prepare(
    bundleValue: ToolExecutionEvidenceBundle,
  ): Promise<Readonly<PrepareToolExecutionEvidenceResult>> {
    const bundle = normalizeToolExecutionEvidenceBundle(bundleValue);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const existing = this.client
          .prepare(
            `SELECT ${EVIDENCE_SELECT}
             FROM "ToolExecutionTraceAnchors" AS trace
             JOIN "ToolExecutionAuditReceipts" AS receipt
               ON receipt.trace_id = trace.trace_id
              AND receipt.span_id = trace.span_id
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit.event_id = receipt.event_id
             WHERE receipt.event_id = ?
                OR (trace.trace_id = ? AND trace.span_id = ?)
             LIMIT 3`,
          )
          .all(
            bundle.receipt.eventId,
            bundle.trace.traceId,
            bundle.trace.spanId,
          ) as Row[];
        if (existing.length > 1) {
          throw new ToolExecutionEvidenceConflictError();
        }
        if (existing[0]) {
          const stored = bundleFromRow(existing[0]);
          if (JSON.stringify(stored) !== JSON.stringify(bundle)) {
            throw new ToolExecutionEvidenceConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', bundle: stored });
        }

        const step = this.client
          .prepare(
            `SELECT step.kind, step.status, run.project_id AS "projectId"
             FROM "StepRuns" AS step
             JOIN "Runs" AS run ON run.id = step.run_id
             WHERE step.id = ? AND step.run_id = ?
             LIMIT 2`,
          )
          .all(bundle.trace.stepRunId, bundle.trace.runId) as Row[];
        if (
          step.length !== 1 ||
          requiredText(step[0]!, 'kind') !== 'tool' ||
          !['ready', 'waiting_approval'].includes(
            requiredText(step[0]!, 'status'),
          ) ||
          requiredText(step[0]!, 'projectId') !== bundle.trace.projectId
        ) {
          throw new ToolExecutionEvidenceConflictError();
        }

        insertAudit(this.client, bundle.audit);
        const trace = bundle.trace;
        this.client
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
        this.client
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
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', bundle });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // The shared authority owns close; preserve the original failure.
          }
        }
        throw error;
      }
    });
  }
}
