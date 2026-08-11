import {
  IdentityAdministrationMutationConflictError,
  IdentityAdministrationVersionConflictError,
  normalizeIdentityAdministrationMutationId,
  normalizeIdentityAdministrationSubject,
  normalizeIdentitySubjectRecord,
  type IdentitySubjectRecord,
} from '@qinglong/runtime-core/identity-administration';
import {
  LocalIdentityCredentialAdministrationUnavailableError,
  LocalIdentityCredentialAuthorizationFenceConflictError,
  LocalIdentityOwnerBindingConflictError,
  type AppendAuthorizedLocalIdentityCommand,
  type AppendAuthorizedLocalIdentityResult,
  type InspectAuthorizedLocalIdentityCommand,
  type InspectAuthorizedLocalIdentityResult,
  type ResolvedLocalIdentitySubjectMutation,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import { SecurityAuditUnavailableError } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
} from '../securityPersistence';

import {
  ADMIN_AUDIT_SELECT,
  ADMINISTRABLE_SUBJECT_TYPES,
  IDENTITY_MUTATION_SELECT,
  assertAllowedAudit,
  authorization,
  identityFromRow,
  identityMutationFromRow,
  identityResultFromMutationRow,
  sameIdentitySemantic,
  sameSubject,
  text,
  type Row,
} from './codec';

import {
  activeOwnerBindingExists,
  assertAuthorizationInTransaction,
} from './authorization';

export function resolveIdentity(
  authority: LocalSqliteOperationAuthority,
  requested: SecuritySubject,
): Promise<Readonly<IdentitySubjectRecord> | null> {
  const subject = normalizeIdentityAdministrationSubject(requested);
  return authority.enqueue(
    async () => {
      const row = authority.client
        .prepare(
          `SELECT "subject_type" AS "subjectType",
                    "subject_id" AS "subjectId",
                    "status" AS "status", "version" AS "version",
                    "created_at_ms" AS "createdAtMs",
                    "updated_at_ms" AS "updatedAtMs"
             FROM "QingLong3IdentitySubjects"
             WHERE "subject_type" = ? AND "subject_id" = ?`,
        )
        .get(subject.type, subject.id) as Row | undefined;
      return row ? identityFromRow(row) : null;
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}

export function resolveIdentityMutation(
  authority: LocalSqliteOperationAuthority,
  requestedMutationId: string,
): Promise<Readonly<ResolvedLocalIdentitySubjectMutation> | null> {
  normalizeIdentityAdministrationMutationId(requestedMutationId);
  return authority.enqueue(
    async () => {
      const row = authority.client
        .prepare(
          `SELECT ${IDENTITY_MUTATION_SELECT},
                    ${ADMIN_AUDIT_SELECT}
             FROM "QingLong3IdentityAdministrationMutations" AS mutation
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit."event_id" = mutation."audit_event_id"
             WHERE mutation."mutation_id" = ?`,
        )
        .get(requestedMutationId) as Row | undefined;
      if (!row) return null;
      return Object.freeze({
        projectId: text(row, 'mutationProjectId'),
        identity: identityResultFromMutationRow(row),
        mutation: identityMutationFromRow(row),
        audit: localSecurityAuditFromRow(row),
      });
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}

export function inspectAuthorizedIdentity(
  authority: LocalSqliteOperationAuthority,
  beforeMutation: () => void,
  input: InspectAuthorizedLocalIdentityCommand,
): Promise<InspectAuthorizedLocalIdentityResult> {
  const subject = normalizeIdentityAdministrationSubject(input.target);
  const auth = authorization(input.authorization);
  const audit = assertAllowedAudit(
    input.audit,
    'identity.inspect',
    input.audit.eventId,
    auth,
  );
  return authority.enqueue(
    async () => {
      const client = authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        assertAuthorizationInTransaction(authority, auth, beforeMutation);
        const row = client
          .prepare(
            `SELECT "subject_type" AS "subjectType",
                      "subject_id" AS "subjectId",
                      "status" AS "status", "version" AS "version",
                      "created_at_ms" AS "createdAtMs",
                      "updated_at_ms" AS "updatedAtMs"
               FROM "QingLong3IdentitySubjects"
               WHERE "subject_type" = ? AND "subject_id" = ?`,
          )
          .get(subject.type, subject.id) as Row | undefined;
        insertLocalSecurityAudit(client, audit);
        client.exec('COMMIT');
        return Object.freeze({
          identity: row ? identityFromRow(row) : null,
          audit,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        if (
          error instanceof
          LocalIdentityCredentialAuthorizationFenceConflictError
        ) {
          throw error;
        }
        if (error instanceof SecurityAuditUnavailableError) throw error;
        throw new LocalIdentityCredentialAdministrationUnavailableError();
      }
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}

export function appendAuthorizedIdentity(
  authority: LocalSqliteOperationAuthority,
  beforeMutation: () => void,
  input: AppendAuthorizedLocalIdentityCommand,
): Promise<AppendAuthorizedLocalIdentityResult> {
  const auth = authorization(input.authorization);
  const mutation = input.mutation;
  normalizeIdentityAdministrationMutationId(mutation.mutationId);
  const subject = normalizeIdentityAdministrationSubject(mutation.subject);
  if (
    !ADMINISTRABLE_SUBJECT_TYPES.has(subject.type) ||
    !Number.isSafeInteger(input.expectedCurrentVersion) ||
    input.expectedCurrentVersion < 0 ||
    mutation.subjectVersion !== input.expectedCurrentVersion + 1 ||
    mutation.expectedPreviousVersion !== input.expectedCurrentVersion ||
    !sameSubject(mutation.changedBy, auth.actor) ||
    (mutation.operation === 'register'
      ? input.expectedCurrentVersion !== 0 || mutation.status !== 'active'
      : input.expectedCurrentVersion < 1 ||
        mutation.status !==
          (mutation.operation === 'disable' ? 'disabled' : 'active')) ||
    !Number.isSafeInteger(mutation.createdAtMs) ||
    mutation.createdAtMs < 0
  ) {
    throw new TypeError('Local Identity administration command is invalid');
  }
  const audit = assertAllowedAudit(
    input.audit,
    `identity.${mutation.operation}`,
    mutation.mutationId,
    auth,
  );
  return authority.enqueue(
    async () => {
      const client = authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        assertAuthorizationInTransaction(authority, auth, beforeMutation);
        const replayRow = client
          .prepare(
            `SELECT ${IDENTITY_MUTATION_SELECT},
                      ${ADMIN_AUDIT_SELECT}
               FROM "QingLong3IdentityAdministrationMutations" AS mutation
               JOIN "QingLong3SecurityAuditEvents" AS audit
                 ON audit."event_id" = mutation."audit_event_id"
               WHERE mutation."mutation_id" = ?`,
          )
          .get(mutation.mutationId) as Row | undefined;
        if (replayRow) {
          const existing = Object.freeze({
            projectId: text(replayRow, 'mutationProjectId'),
            identity: identityResultFromMutationRow(replayRow),
            mutation: identityMutationFromRow(replayRow),
            audit: localSecurityAuditFromRow(replayRow),
          });
          const expectedIdentity: IdentitySubjectRecord = {
            subject,
            status: mutation.status,
            version: mutation.subjectVersion,
            createdAtMs:
              mutation.operation === 'register'
                ? mutation.createdAtMs
                : existing.identity.createdAtMs,
            updatedAtMs: mutation.createdAtMs,
          };
          if (
            !sameIdentitySemantic(existing, {
              projectId: auth.projectId,
              identity: expectedIdentity,
              mutation,
              audit,
            })
          ) {
            throw new IdentityAdministrationMutationConflictError();
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            identity: existing.identity,
            mutation: existing.mutation,
            audit: existing.audit,
          });
        }
        const currentRow = client
          .prepare(
            `SELECT "subject_type" AS "subjectType",
                      "subject_id" AS "subjectId",
                      "status" AS "status", "version" AS "version",
                      "created_at_ms" AS "createdAtMs",
                      "updated_at_ms" AS "updatedAtMs"
               FROM "QingLong3IdentitySubjects"
               WHERE "subject_type" = ? AND "subject_id" = ?`,
          )
          .get(subject.type, subject.id) as Row | undefined;
        const current = currentRow ? identityFromRow(currentRow) : null;
        if ((current?.version ?? 0) !== input.expectedCurrentVersion) {
          throw new IdentityAdministrationVersionConflictError();
        }
        if (
          mutation.operation === 'disable' &&
          activeOwnerBindingExists(authority, subject)
        ) {
          throw new LocalIdentityOwnerBindingConflictError();
        }
        const identity = normalizeIdentitySubjectRecord({
          subject,
          status: mutation.status,
          version: mutation.subjectVersion,
          createdAtMs: current?.createdAtMs ?? mutation.createdAtMs,
          updatedAtMs: mutation.createdAtMs,
        });
        if (mutation.operation === 'register') {
          client
            .prepare(
              `INSERT INTO "QingLong3IdentitySubjects" (
                   "subject_type", "subject_id", "status", "version",
                   "created_at_ms", "updated_at_ms"
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              subject.type,
              subject.id,
              identity.status,
              identity.version,
              identity.createdAtMs,
              identity.updatedAtMs,
            );
        } else {
          client
            .prepare(
              `UPDATE "QingLong3IdentitySubjects"
                 SET "status" = ?, "version" = ?, "updated_at_ms" = ?
                 WHERE "subject_type" = ? AND "subject_id" = ?
                   AND "version" = ?`,
            )
            .run(
              identity.status,
              identity.version,
              identity.updatedAtMs,
              subject.type,
              subject.id,
              input.expectedCurrentVersion,
            );
        }
        insertLocalSecurityAudit(client, audit);
        client
          .prepare(
            `INSERT INTO "QingLong3IdentityAdministrationMutations" (
                 "mutation_id", "project_id", "operation", "subject_type",
                 "subject_id", "subject_version",
                 "expected_previous_version", "status", "changed_by_type",
                 "changed_by_id", "audit_event_id",
                 "identity_created_at_ms", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mutation.mutationId,
            auth.projectId,
            mutation.operation,
            subject.type,
            subject.id,
            mutation.subjectVersion,
            mutation.expectedPreviousVersion,
            mutation.status,
            auth.actor.type,
            auth.actor.id,
            audit.eventId,
            identity.createdAtMs,
            mutation.createdAtMs,
          );
        client.exec('COMMIT');
        return Object.freeze({
          status: 'inserted' as const,
          identity,
          mutation: Object.freeze({ ...mutation, subject }),
          audit,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        if (
          error instanceof
            LocalIdentityCredentialAuthorizationFenceConflictError ||
          error instanceof LocalIdentityOwnerBindingConflictError ||
          error instanceof IdentityAdministrationVersionConflictError ||
          error instanceof IdentityAdministrationMutationConflictError
        ) {
          throw error;
        }
        if (error instanceof SecurityAuditUnavailableError) throw error;
        throw new LocalIdentityCredentialAdministrationUnavailableError();
      }
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}
