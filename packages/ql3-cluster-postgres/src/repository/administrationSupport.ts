import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type { PostgresClient } from '@qinglong/runtime-core';

export type AdministrationRow = Record<string, unknown>;

export interface AdministrationAuditRow extends AdministrationRow {
  auditEventId: unknown;
  auditRequestId: unknown;
  auditOperationId: unknown;
  auditProjectId: unknown;
  auditSubjectType: unknown;
  auditSubjectId: unknown;
  auditAuthenticationId: unknown;
  auditOutcome: unknown;
  auditReasons: unknown;
  auditProjectVersion: unknown;
  auditBindingVersion: unknown;
  auditOccurredAtMs: unknown;
}

export const ADMINISTRATION_AUDIT_SELECT = `
  audit.event_id AS "auditEventId",
  audit.request_id AS "auditRequestId",
  audit.operation_id AS "auditOperationId",
  audit.project_id AS "auditProjectId",
  audit.subject_type AS "auditSubjectType",
  audit.subject_id AS "auditSubjectId",
  audit.authentication_id AS "auditAuthenticationId",
  audit.outcome AS "auditOutcome",
  audit.reasons AS "auditReasons",
  audit.project_version AS "auditProjectVersion",
  audit.binding_version AS "auditBindingVersion",
  audit.occurred_at_ms AS "auditOccurredAtMs"
`.trim();

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01', '55P03']);

export function requiredString(row: AdministrationRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function requiredInteger(row: AdministrationRow, name: string): number {
  const value = row[name];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError(`${name} is invalid`);
}

function optionalString(row: AdministrationRow, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  return requiredString(row, name);
}

function optionalInteger(row: AdministrationRow, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  return requiredInteger(row, name);
}

export function auditFromRow(
  row: AdministrationAuditRow,
): Readonly<SecurityAuditRecord> {
  const subjectType = optionalString(row, 'auditSubjectType');
  const subjectId = optionalString(row, 'auditSubjectId');
  if ((subjectType === null) !== (subjectId === null)) {
    throw new TypeError('audit subject is invalid');
  }
  const projectVersion = optionalInteger(row, 'auditProjectVersion');
  const bindingVersion = optionalInteger(row, 'auditBindingVersion');
  const reasons = row.auditReasons;
  if (!Array.isArray(reasons)) throw new TypeError('audit reasons are invalid');
  return normalizeSecurityAuditRecord({
    eventId: requiredString(row, 'auditEventId'),
    requestId: requiredString(row, 'auditRequestId'),
    operationId: requiredString(row, 'auditOperationId'),
    projectId: optionalString(row, 'auditProjectId'),
    subject:
      subjectType === null
        ? null
        : {
            type: subjectType as NonNullable<
              SecurityAuditRecord['subject']
            >['type'],
            id: subjectId!,
          },
    authenticationId: optionalString(row, 'auditAuthenticationId'),
    outcome: requiredString(
      row,
      'auditOutcome',
    ) as SecurityAuditRecord['outcome'],
    reasons: reasons as string[],
    fence: projectVersion === null ? null : { projectVersion, bindingVersion },
    occurredAtMs: requiredInteger(row, 'auditOccurredAtMs'),
  });
}

export function sameAudit(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameAdministrationReplayAudit(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftOccurredAtMs, ...leftSemantic } = left;
  const { occurredAtMs: _rightOccurredAtMs, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

export async function insertAdministrationAudit(
  client: PostgresClient,
  audit: Readonly<SecurityAuditRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id, subject_type,
       subject_id, authentication_id, outcome, reasons, project_version,
       binding_version, occurred_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
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

export async function configureAdministrationTransaction(
  client: PostgresClient,
): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

export async function rollbackAdministrationTransaction(
  client: PostgresClient,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary failure; releasing discards a broken connection.
  }
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function retryableAdministrationError(error: unknown): boolean {
  const code = sqlState(error);
  return code === '23505' || RETRYABLE_SQL_STATES.has(code ?? '');
}
