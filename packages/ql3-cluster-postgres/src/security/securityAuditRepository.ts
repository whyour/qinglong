// PostgreSQL runtime sink for immutable security audit events.
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import type { PostgresPool } from '@qinglong/runtime-core';

const INSERT_SQL = `
INSERT INTO "ql3"."security_audit_events" (
  event_id,
  request_id,
  operation_id,
  project_id,
  subject_type,
  subject_id,
  authentication_id,
  outcome,
  reasons,
  project_version,
  binding_version,
  occurred_at_ms
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
`.trim();

export class PostgresSecurityAuditRepository implements SecurityAuditSink {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL security audit pool is invalid');
    }
  }

  async record(value: SecurityAuditRecord): Promise<void> {
    let record: Readonly<SecurityAuditRecord>;
    try {
      record = normalizeSecurityAuditRecord(value);
    } catch {
      throw new SecurityAuditUnavailableError();
    }
    try {
      await this.pool.query(INSERT_SQL, [
        record.eventId,
        record.requestId,
        record.operationId,
        record.projectId,
        record.subject?.type ?? null,
        record.subject?.id ?? null,
        record.authenticationId,
        record.outcome,
        JSON.stringify(record.reasons),
        record.fence?.projectVersion ?? null,
        record.fence?.bindingVersion ?? null,
        record.occurredAtMs,
      ]);
    } catch {
      throw new SecurityAuditUnavailableError();
    }
  }
}
