import type { DatabaseSync } from 'node:sqlite';

import {
  normalizeLocalSecretEnvelope,
  type LocalSecretEnvelope,
} from '@qinglong/runtime-core/local-secret';
import {
  normalizeProjectRecord,
  normalizeProjectRoleBinding,
  type ProjectRecord,
  type ProjectRoleBindingRecord,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import {
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
} from '@qinglong/runtime-core/run-repository';

import {
  createSqlitePersistencePrimitives,
  sqliteDriverErrorCode,
  sqliteDriverErrorNumber,
  type SqliteQueryRow,
  type SqliteQueryValue,
} from '../storage/sqlitePersistence';

export type QueryRow = SqliteQueryRow;

export function mapSqliteError(error: unknown): RunRepositoryError {
  if (error instanceof RunRepositoryError) return error;
  const baseCode = (sqliteDriverErrorNumber(error) ?? 0) & 0xff;
  if (baseCode === 5 || baseCode === 6) {
    return new RunRepositoryBusyError(error);
  }
  if (
    baseCode === 19 ||
    sqliteDriverErrorCode(error) === 'ERR_SQLITE_CONSTRAINT'
  ) {
    return new RunRepositoryConstraintError(
      'Local SQLite Run repository constraint violation',
      error,
    );
  }
  return new RunRepositoryOperationError(error);
}

const SECURITY_SQLITE_PERSISTENCE = createSqlitePersistencePrimitives({
  invalidRowValue: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has an invalid ${property}`,
    ),
  invalidJson: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has invalid ${property} JSON`,
    ),
  unsupportedRowValue: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has an unsupported ${property}`,
    ),
  duplicateIdentityRows: () =>
    new RunRepositoryConstraintError(
      'Local SQLite Run repository returned duplicate identity rows',
    ),
  mapDriverError: mapSqliteError,
});

export function optionalInteger(
  row: QueryRow,
  property: string,
): number | undefined {
  return SECURITY_SQLITE_PERSISTENCE.optionalInteger(row, property);
}

export function optionalString(
  row: QueryRow,
  property: string,
): string | undefined {
  return SECURITY_SQLITE_PERSISTENCE.optionalString(row, property);
}

export function requiredBlob(row: QueryRow, property: string): Buffer {
  try {
    return SECURITY_SQLITE_PERSISTENCE.requiredBlob(row, property);
  } catch (error) {
    if (error instanceof RunRepositoryConstraintError) {
      throw new RunRepositoryConstraintError(
        `Local SQLite row has an invalid ${property}`,
      );
    }
    throw error;
  }
}

export function requiredInteger(row: QueryRow, property: string): number {
  return SECURITY_SQLITE_PERSISTENCE.requiredInteger(row, property);
}

export function requiredJson(row: QueryRow, property: string): unknown {
  return SECURITY_SQLITE_PERSISTENCE.requiredJson(row, property);
}

export function requiredString(row: QueryRow, property: string): string {
  return SECURITY_SQLITE_PERSISTENCE.requiredString(row, property);
}

export function queryRows(
  client: DatabaseSync,
  sql: string,
  values: readonly SqliteQueryValue[] = [],
): QueryRow[] {
  return SECURITY_SQLITE_PERSISTENCE.queryRows(client, sql, values);
}

export function singleRow(rows: QueryRow[]): QueryRow | null {
  return SECURITY_SQLITE_PERSISTENCE.singleRow(rows);
}

export function localSecretEnvelopeFromRow(row: QueryRow): LocalSecretEnvelope {
  const nonce = requiredBlob(row, 'nonce');
  const ciphertext = requiredBlob(row, 'ciphertext');
  const authTag = requiredBlob(row, 'authTag');
  try {
    return normalizeLocalSecretEnvelope({
      projectId: requiredString(row, 'projectId'),
      name: requiredString(row, 'name'),
      version: requiredInteger(row, 'version'),
      mutationId: requiredString(row, 'mutationId'),
      keyId: requiredString(row, 'keyId'),
      algorithm: requiredString(row, 'algorithm') as 'aes-256-gcm',
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: authTag.toString('base64url'),
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
  }
}

export const LOCAL_SECRET_SELECT = `
  "project_id" AS "projectId",
  "secret_name" AS "name",
  "version" AS "version",
  "mutation_id" AS "mutationId",
  "key_id" AS "keyId",
  "algorithm" AS "algorithm",
  "nonce" AS "nonce",
  "ciphertext" AS "ciphertext",
  "auth_tag" AS "authTag",
  "created_at_ms" AS "createdAtMs"
`;

export const LOCAL_PROJECT_SELECT = `
  "id" AS "id",
  "name" AS "name",
  "slug" AS "slug",
  "status" AS "status",
  "version" AS "version",
  "created_at_ms" AS "createdAtMs",
  "updated_at_ms" AS "updatedAtMs"
`;

export const LOCAL_ROLE_BINDING_SELECT = `
  "project_id" AS "projectId",
  "subject_type" AS "subjectType",
  "subject_id" AS "subjectId",
  "version" AS "version",
  "state" AS "state",
  "role" AS "role",
  "mutation_id" AS "mutationId",
  "changed_by_type" AS "changedByType",
  "changed_by_id" AS "changedById",
  "created_at_ms" AS "createdAtMs"
`;

export const LOCAL_SECURITY_AUDIT_SELECT = `
  "event_id" AS "eventId",
  "request_id" AS "requestId",
  "operation_id" AS "operationId",
  "project_id" AS "projectId",
  "subject_type" AS "subjectType",
  "subject_id" AS "subjectId",
  "authentication_id" AS "authenticationId",
  "outcome" AS "outcome",
  "reasons_json" AS "reasonsJson",
  "fence_project_version" AS "fenceProjectVersion",
  "fence_binding_version" AS "fenceBindingVersion",
  "occurred_at_ms" AS "occurredAtMs"
`;

export const LOCAL_SECRET_JOIN_SELECT = `
  secret."project_id" AS "projectId",
  secret."secret_name" AS "name",
  secret."version" AS "version",
  secret."mutation_id" AS "mutationId",
  secret."key_id" AS "keyId",
  secret."algorithm" AS "algorithm",
  secret."nonce" AS "nonce",
  secret."ciphertext" AS "ciphertext",
  secret."auth_tag" AS "authTag",
  secret."created_at_ms" AS "createdAtMs"
`;

export const LOCAL_SECURITY_AUDIT_JOIN_SELECT = `
  audit."event_id" AS "eventId",
  audit."request_id" AS "requestId",
  audit."operation_id" AS "operationId",
  audit."project_id" AS "auditProjectId",
  audit."subject_type" AS "subjectType",
  audit."subject_id" AS "subjectId",
  audit."authentication_id" AS "authenticationId",
  audit."outcome" AS "outcome",
  audit."reasons_json" AS "reasonsJson",
  audit."fence_project_version" AS "fenceProjectVersion",
  audit."fence_binding_version" AS "fenceBindingVersion",
  audit."occurred_at_ms" AS "occurredAtMs"
`;

export function localProjectFromRow(row: QueryRow): Readonly<ProjectRecord> {
  return normalizeProjectRecord({
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    slug: requiredString(row, 'slug'),
    status: requiredString(row, 'status') as ProjectRecord['status'],
    version: requiredInteger(row, 'version'),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
    updatedAtMs: requiredInteger(row, 'updatedAtMs'),
  });
}

export function localRoleBindingFromRow(
  row: QueryRow,
): Readonly<ProjectRoleBindingRecord> {
  const state = requiredString(
    row,
    'state',
  ) as ProjectRoleBindingRecord['state'];
  return normalizeProjectRoleBinding({
    projectId: requiredString(row, 'projectId'),
    subject: {
      type: requiredString(
        row,
        'subjectType',
      ) as ProjectRoleBindingRecord['subject']['type'],
      id: requiredString(row, 'subjectId'),
    },
    version: requiredInteger(row, 'version'),
    state,
    ...(state === 'active'
      ? {
          role: requiredString(row, 'role') as NonNullable<
            ProjectRoleBindingRecord['role']
          >,
        }
      : {}),
    mutationId: requiredString(row, 'mutationId'),
    changedBy: {
      type: requiredString(
        row,
        'changedByType',
      ) as ProjectRoleBindingRecord['changedBy']['type'],
      id: requiredString(row, 'changedById'),
    },
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  });
}

export function localSecurityAuditFromRow(
  row: QueryRow,
): Readonly<SecurityAuditRecord> {
  const subjectType = optionalString(row, 'subjectType');
  const subjectId = optionalString(row, 'subjectId');
  const authenticationId = optionalString(row, 'authenticationId');
  const fenceProjectVersion = optionalInteger(row, 'fenceProjectVersion');
  const fenceBindingVersion = optionalInteger(row, 'fenceBindingVersion');
  return normalizeSecurityAuditRecord({
    eventId: requiredString(row, 'eventId'),
    requestId: requiredString(row, 'requestId'),
    operationId: requiredString(row, 'operationId'),
    projectId:
      optionalString(row, 'auditProjectId') ??
      optionalString(row, 'projectId') ??
      null,
    subject:
      subjectType && subjectId
        ? {
            type: subjectType as NonNullable<
              SecurityAuditRecord['subject']
            >['type'],
            id: subjectId,
          }
        : null,
    authenticationId: authenticationId ?? null,
    outcome: requiredString(row, 'outcome') as SecurityAuditRecord['outcome'],
    reasons: requiredJson(row, 'reasonsJson') as readonly string[],
    fence:
      fenceProjectVersion === undefined
        ? null
        : {
            projectVersion: fenceProjectVersion,
            bindingVersion: fenceBindingVersion ?? null,
          },
    occurredAtMs: requiredInteger(row, 'occurredAtMs'),
  });
}

export function sameSecurityAuditSemantic(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftTime, ...leftSemantic } = left;
  const { occurredAtMs: _rightTime, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

export function insertLocalSecurityAudit(
  client: DatabaseSync,
  audit: Readonly<SecurityAuditRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
         "event_id", "request_id", "operation_id", "project_id",
         "subject_type", "subject_id", "authentication_id", "outcome",
         "reasons_json", "fence_project_version", "fence_binding_version",
         "occurred_at_ms"
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
