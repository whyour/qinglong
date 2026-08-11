// PostgreSQL administration authority for querying security audit events.
import {
  SecurityAuditQueryUnavailableError,
  normalizeSecurityAuditQuery,
  type SecurityAuditQuery,
  type SecurityAuditQueryPage,
  type SecurityAuditQueryRepository,
} from '@qinglong/runtime-core/security-audit-query';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  requiredInteger,
  requiredString,
  type AdministrationRow,
} from '../repository/administrationSupport';

interface AuditRow extends AdministrationRow {
  eventId: unknown;
  requestId: unknown;
  operationId: unknown;
  projectId: unknown;
  subjectType: unknown;
  subjectId: unknown;
  authenticationId: unknown;
  outcome: unknown;
  reasons: unknown;
  projectVersion: unknown;
  bindingVersion: unknown;
  occurredAtMs: unknown;
}

function optionalString(row: AuditRow, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  return requiredString(row, name);
}

function optionalInteger(row: AuditRow, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  return requiredInteger(row, name);
}

function recordFromRow(row: AuditRow): Readonly<SecurityAuditRecord> {
  const subjectType = optionalString(row, 'subjectType');
  const subjectId = optionalString(row, 'subjectId');
  if ((subjectType === null) !== (subjectId === null)) {
    throw new SecurityAuditQueryUnavailableError();
  }
  const projectVersion = optionalInteger(row, 'projectVersion');
  const bindingVersion = optionalInteger(row, 'bindingVersion');
  if (!Array.isArray(row.reasons)) {
    throw new SecurityAuditQueryUnavailableError();
  }
  try {
    return normalizeSecurityAuditRecord({
      eventId: requiredString(row, 'eventId'),
      requestId: requiredString(row, 'requestId'),
      operationId: requiredString(row, 'operationId'),
      projectId: optionalString(row, 'projectId'),
      subject:
        subjectType === null
          ? null
          : {
              type: subjectType as NonNullable<
                SecurityAuditRecord['subject']
              >['type'],
              id: subjectId!,
            },
      authenticationId: optionalString(row, 'authenticationId'),
      outcome: requiredString(row, 'outcome') as SecurityAuditRecord['outcome'],
      reasons: row.reasons as string[],
      fence:
        projectVersion === null ? null : { projectVersion, bindingVersion },
      occurredAtMs: requiredInteger(row, 'occurredAtMs'),
    });
  } catch {
    throw new SecurityAuditQueryUnavailableError();
  }
}

export class PostgresSecurityAuditQueryRepository
  implements SecurityAuditQueryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL security audit query pool is invalid');
    }
  }

  async list(input: SecurityAuditQuery): Promise<SecurityAuditQueryPage> {
    const query = normalizeSecurityAuditQuery(input);
    const conditions: string[] = [];
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (query.before) {
      const occurred = parameter(query.before.occurredAtMs);
      const event = parameter(query.before.eventId);
      conditions.push(
        `(occurred_at_ms, event_id) < (${occurred}, ${event}::uuid)`,
      );
    }
    if (query.filter.projectId !== undefined) {
      conditions.push(`project_id = ${parameter(query.filter.projectId)}`);
    }
    if (query.filter.subject !== undefined) {
      conditions.push(
        `subject_type = ${parameter(
          query.filter.subject.type,
        )} AND subject_id = ${parameter(query.filter.subject.id)}`,
      );
    }
    if (query.filter.outcome !== undefined) {
      conditions.push(`outcome = ${parameter(query.filter.outcome)}`);
    }
    const limit = parameter(query.limit);
    let result;
    try {
      result = await this.pool.query<AuditRow>(
        `SELECT
           event_id AS "eventId", request_id AS "requestId",
           operation_id AS "operationId", project_id AS "projectId",
           subject_type AS "subjectType", subject_id AS "subjectId",
           authentication_id AS "authenticationId", outcome, reasons,
           project_version AS "projectVersion",
           binding_version AS "bindingVersion",
           occurred_at_ms AS "occurredAtMs"
         FROM "ql3"."security_audit_events"
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY occurred_at_ms DESC, event_id DESC
         LIMIT ${limit}`,
        values,
      );
    } catch {
      throw new SecurityAuditQueryUnavailableError();
    }
    let records: readonly Readonly<SecurityAuditRecord>[];
    try {
      records = Object.freeze(result.rows.map(recordFromRow));
    } catch {
      throw new SecurityAuditQueryUnavailableError();
    }
    const last = records.at(-1);
    return Object.freeze({
      records,
      nextCursor:
        records.length === query.limit && last
          ? Object.freeze({
              occurredAtMs: last.occurredAtMs,
              eventId: last.eventId,
            })
          : null,
    });
  }
}
