import type { PostgresClient } from '@qinglong/runtime-core';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  ModelProviderCredentialAdministrationMutationConflictError,
  type AuthorizedModelProviderCredentialTransitionMutation,
} from '../modelProviderCredentialAdministration';
import { ModelProviderCredentialCatalogUnavailableError } from '../modelProviderCredentialCatalog';
import {
  identity,
  integer,
  sqlState,
  unavailable,
  type Queryable,
  type Row,
} from './storageProtocol';

export function administrationAuditFromRow(
  row: Row,
): Readonly<SecurityAuditRecord> {
  const reasons = row.auditReasons;
  if (!Array.isArray(reasons)) throw unavailable();
  const subjectType = row.auditSubjectType;
  const subjectId = row.auditSubjectId;
  const authenticationId = row.auditAuthenticationId;
  const projectVersion = row.auditProjectVersion;
  const bindingVersion = row.auditBindingVersion;
  try {
    return normalizeSecurityAuditRecord({
      eventId: identity(row.auditEventId),
      requestId: identity(row.auditRequestId),
      operationId: identity(row.auditOperationId),
      projectId: identity(row.auditProjectId),
      subject: {
        type: identity(subjectType) as NonNullable<
          SecurityAuditRecord['subject']
        >['type'],
        id: identity(subjectId),
      },
      authenticationId: identity(authenticationId),
      outcome: identity(row.auditOutcome) as SecurityAuditRecord['outcome'],
      reasons: reasons as string[],
      fence: {
        projectVersion: integer(projectVersion),
        bindingVersion: integer(bindingVersion),
      },
      occurredAtMs: integer(row.auditOccurredAtMs),
    });
  } catch (cause) {
    throw unavailable(cause);
  }
}

export async function administrationAuditRows(
  queryable: Queryable,
  eventId: string,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT
       event_id AS "auditEventId",
       request_id AS "auditRequestId",
       operation_id AS "auditOperationId",
       project_id AS "auditProjectId",
       subject_type AS "auditSubjectType",
       subject_id AS "auditSubjectId",
       authentication_id AS "auditAuthenticationId",
       outcome AS "auditOutcome",
       reasons AS "auditReasons",
       project_version AS "auditProjectVersion",
       binding_version AS "auditBindingVersion",
       occurred_at_ms AS "auditOccurredAtMs"
     FROM "ql3"."security_audit_events"
     WHERE event_id = $1
     LIMIT 2`,
    [eventId],
  );
  return result.rows;
}

export function sameAdministrationReplayAudit(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftOccurredAtMs, ...leftSemantic } = left;
  const { occurredAtMs: _rightOccurredAtMs, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

export async function confirmAdministrationFence(
  client: PostgresClient,
  mutation: Readonly<AuthorizedModelProviderCredentialTransitionMutation>,
): Promise<void> {
  try {
    const project = await client.query<Row>(
      `SELECT status, version FROM "ql3"."projects" WHERE id = $1`,
      [mutation.command.projectId],
    );
    const binding = await client.query<Row>(
      `SELECT version, state
       FROM "ql3"."project_role_bindings"
       WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
       ORDER BY version DESC
       LIMIT 1`,
      [mutation.command.projectId, mutation.actor.type, mutation.actor.id],
    );
    if (
      project.rows.length !== 1 ||
      project.rows[0]?.status !== 'active' ||
      integer(project.rows[0]?.version) !== mutation.fence.projectVersion ||
      binding.rows.length !== 1 ||
      binding.rows[0]?.state !== 'active' ||
      integer(binding.rows[0]?.version) !== mutation.fence.bindingVersion
    ) {
      throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
    }
  } catch (error) {
    if (
      error instanceof
      ModelProviderCredentialAdministrationAuthorizationFenceConflictError
    ) {
      throw error;
    }
    throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
  }
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

export function mapAdministrationStorageError(error: unknown): Error {
  if (
    error instanceof
      ModelProviderCredentialAdministrationAuthorizationFenceConflictError ||
    error instanceof
      ModelProviderCredentialAdministrationMutationConflictError ||
    error instanceof ModelProviderCredentialCatalogUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(sqlState(error))) {
    return new ModelProviderCredentialAdministrationMutationConflictError();
  }
  return unavailable(error);
}
