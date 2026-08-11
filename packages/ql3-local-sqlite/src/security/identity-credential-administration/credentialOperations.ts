import {
  ApiCredentialAdministrationMutationConflictError,
  ApiCredentialAdministrationSubjectNotFoundError,
  ApiCredentialAdministrationVersionConflictError,
  REVOKED_API_CREDENTIAL_DIGEST,
  normalizeApiCredentialAdministrationMutationId,
} from '@qinglong/runtime-core/api-credential-administration';
import {
  assertApiCredentialId,
  normalizeApiCredentialRecord,
} from '@qinglong/runtime-core/api-credential';
import {
  LocalCredentialOwnerContinuityError,
  LocalIdentityCredentialAdministrationUnavailableError,
  LocalIdentityCredentialAuthorizationFenceConflictError,
  type AppendAuthorizedLocalApiCredentialCommand,
  type AppendAuthorizedLocalApiCredentialResult,
  type InspectAuthorizedLocalApiCredentialCommand,
  type InspectAuthorizedLocalApiCredentialResult,
  type ResolvedLocalApiCredentialMutation,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import { SecurityAuditUnavailableError } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
} from '../securityPersistence';

import {
  ADMIN_AUDIT_SELECT,
  ADMINISTRABLE_SUBJECT_TYPES,
  CREDENTIAL_MUTATION_SELECT,
  DIGEST_PATTERN,
  assertAllowedAudit,
  authorization,
  credentialFromMutationRow,
  credentialMutationFromRow,
  identityFromRow,
  integer,
  optionalText,
  sameCredentialSemantic,
  sameSubject,
  text,
  type Row,
} from './codec';

import {
  activeOwnerBindingExists,
  anotherActiveCredentialExists,
  assertAuthorizationInTransaction,
} from './authorization';

export function resolveCredentialMutation(
  authority: LocalSqliteOperationAuthority,
  requestedMutationId: string,
): Promise<Readonly<ResolvedLocalApiCredentialMutation> | null> {
  normalizeApiCredentialAdministrationMutationId(requestedMutationId);
  return authority.enqueue(
    async () => {
      const row = authority.client
        .prepare(
          `SELECT ${CREDENTIAL_MUTATION_SELECT},
                    ${ADMIN_AUDIT_SELECT}
             FROM "QingLong3ApiCredentialAdministrationMutations" AS mutation
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit."event_id" = mutation."audit_event_id"
             WHERE mutation."mutation_id" = ?`,
        )
        .get(requestedMutationId) as Row | undefined;
      if (!row) return null;
      const deliveryDigest = optionalText(row, 'deliveryDigest');
      return Object.freeze({
        projectId: text(row, 'mutationProjectId'),
        credential: credentialFromMutationRow(row),
        mutation: credentialMutationFromRow(row),
        delivery:
          deliveryDigest === null
            ? null
            : Object.freeze({ digest: deliveryDigest }),
        audit: localSecurityAuditFromRow(row),
      });
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}

export function inspectAuthorizedCredential(
  authority: LocalSqliteOperationAuthority,
  beforeMutation: () => void,
  input: InspectAuthorizedLocalApiCredentialCommand,
): Promise<InspectAuthorizedLocalApiCredentialResult> {
  assertApiCredentialId(input.credentialId);
  const auth = authorization(input.authorization);
  const audit = assertAllowedAudit(
    input.audit,
    'credential.inspect',
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
            `SELECT credential."credential_id" AS "credentialId",
                      credential."version" AS "credentialVersion",
                      pepper."pepper_key_id" AS "pepperKeyId",
                      credential."state" AS "state",
                      credential."subject_type" AS "targetSubjectType",
                      credential."subject_id" AS "targetSubjectId",
                      identity."status" AS "subjectStatus",
                      credential."secret_digest" AS "secretDigest",
                      credential."created_at_ms" AS "createdAtMs",
                      credential."not_before_at_ms" AS "notBeforeAtMs",
                      credential."expires_at_ms" AS "expiresAtMs"
               FROM "QingLong3ApiCredentials" AS credential
               JOIN "QingLong3IdentitySubjects" AS identity
                 ON identity."subject_type" = credential."subject_type"
                AND identity."subject_id" = credential."subject_id"
               LEFT JOIN "QingLong3ApiCredentialPepperBindings" AS pepper
                 ON pepper."credential_id" = credential."credential_id"
                AND pepper."credential_version" = credential."version"
               WHERE credential."credential_id" = ?
               ORDER BY credential."version" DESC
               LIMIT 1`,
          )
          .get(input.credentialId) as Row | undefined;
        insertLocalSecurityAudit(client, audit);
        client.exec('COMMIT');
        return Object.freeze({
          credential: row ? credentialFromMutationRow(row) : null,
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

export function appendAuthorizedCredential(
  authority: LocalSqliteOperationAuthority,
  beforeMutation: () => void,
  input: AppendAuthorizedLocalApiCredentialCommand,
): Promise<AppendAuthorizedLocalApiCredentialResult> {
  const auth = authorization(input.authorization);
  const credential = normalizeApiCredentialRecord(input.credential);
  const mutation = input.mutation;
  normalizeApiCredentialAdministrationMutationId(mutation.mutationId);
  const deliveryDigest = input.delivery?.digest ?? null;
  if (
    !ADMINISTRABLE_SUBJECT_TYPES.has(credential.subject.type) ||
    !Number.isSafeInteger(input.expectedCurrentVersion) ||
    input.expectedCurrentVersion < 0 ||
    mutation.credentialId !== credential.credentialId ||
    mutation.credentialVersion !== input.expectedCurrentVersion + 1 ||
    mutation.expectedPreviousVersion !== input.expectedCurrentVersion ||
    credential.version !== mutation.credentialVersion ||
    !sameSubject(mutation.changedBy, auth.actor) ||
    (mutation.operation === 'issue'
      ? input.expectedCurrentVersion !== 0 ||
        credential.state !== 'active' ||
        deliveryDigest === null
      : mutation.operation === 'rotate'
      ? input.expectedCurrentVersion < 1 ||
        credential.state !== 'active' ||
        deliveryDigest === null
      : input.expectedCurrentVersion < 1 ||
        credential.state !== 'revoked' ||
        credential.secretDigest !== REVOKED_API_CREDENTIAL_DIGEST ||
        deliveryDigest !== null) ||
    (deliveryDigest !== null && !DIGEST_PATTERN.test(deliveryDigest))
  ) {
    throw new TypeError(
      'Local API credential administration command is invalid',
    );
  }
  const audit = assertAllowedAudit(
    input.audit,
    `credential.${mutation.operation}`,
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
            `SELECT ${CREDENTIAL_MUTATION_SELECT},
                      ${ADMIN_AUDIT_SELECT}
               FROM "QingLong3ApiCredentialAdministrationMutations" AS mutation
               JOIN "QingLong3SecurityAuditEvents" AS audit
                 ON audit."event_id" = mutation."audit_event_id"
               WHERE mutation."mutation_id" = ?`,
          )
          .get(mutation.mutationId) as Row | undefined;
        if (replayRow) {
          const replayDelivery = optionalText(replayRow, 'deliveryDigest');
          const existing = Object.freeze({
            projectId: text(replayRow, 'mutationProjectId'),
            credential: credentialFromMutationRow(replayRow),
            mutation: credentialMutationFromRow(replayRow),
            delivery:
              replayDelivery === null
                ? null
                : Object.freeze({ digest: replayDelivery }),
            audit: localSecurityAuditFromRow(replayRow),
          });
          if (
            !sameCredentialSemantic(existing, {
              projectId: auth.projectId,
              credential,
              mutation,
              deliveryDigest,
              audit,
            })
          ) {
            throw new ApiCredentialAdministrationMutationConflictError();
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            credential: existing.credential,
            mutation: existing.mutation,
            delivery: existing.delivery,
            audit: existing.audit,
          });
        }
        const identityRow = client
          .prepare(
            `SELECT "subject_type" AS "subjectType",
                      "subject_id" AS "subjectId",
                      "status" AS "status", "version" AS "version",
                      "created_at_ms" AS "createdAtMs",
                      "updated_at_ms" AS "updatedAtMs"
               FROM "QingLong3IdentitySubjects"
               WHERE "subject_type" = ? AND "subject_id" = ?`,
          )
          .get(credential.subject.type, credential.subject.id) as
          | Row
          | undefined;
        const identity = identityRow ? identityFromRow(identityRow) : null;
        if (
          !identity ||
          (mutation.operation !== 'revoke' && identity.status !== 'active') ||
          identity.status !== credential.subjectStatus
        ) {
          throw new ApiCredentialAdministrationSubjectNotFoundError();
        }
        const currentRow = client
          .prepare(
            `SELECT "credential_id" AS "credentialId",
                      "version" AS "version", "state" AS "state",
                      "subject_type" AS "subjectType",
                      "subject_id" AS "subjectId"
               FROM "QingLong3ApiCredentials"
               WHERE "credential_id" = ?
               ORDER BY "version" DESC LIMIT 1`,
          )
          .get(credential.credentialId) as Row | undefined;
        const currentVersion = currentRow ? integer(currentRow, 'version') : 0;
        if (
          currentVersion !== input.expectedCurrentVersion ||
          (currentRow &&
            (text(currentRow, 'subjectType') !== credential.subject.type ||
              text(currentRow, 'subjectId') !== credential.subject.id))
        ) {
          throw new ApiCredentialAdministrationVersionConflictError();
        }
        if (
          mutation.operation === 'revoke' &&
          credential.subject.type === 'user' &&
          activeOwnerBindingExists(authority, credential.subject) &&
          !anotherActiveCredentialExists(
            authority,
            credential.subject,
            credential.credentialId,
            mutation.createdAtMs,
          )
        ) {
          throw new LocalCredentialOwnerContinuityError();
        }
        if (mutation.operation !== 'revoke') {
          const pepper = client
            .prepare(
              `SELECT "state" AS "state"
                 FROM "QingLong3LocalOwnerPepperKeys"
                 WHERE "pepper_key_id" = ?`,
            )
            .get(credential.pepperKeyId) as Row | undefined;
          if (!pepper || pepper.state !== 'active') {
            throw new LocalIdentityCredentialAuthorizationFenceConflictError();
          }
        }
        client
          .prepare(
            `INSERT INTO "QingLong3ApiCredentials" (
                 "credential_id", "version", "state", "subject_type",
                 "subject_id", "secret_digest", "created_at_ms",
                 "not_before_at_ms", "expires_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            credential.credentialId,
            credential.version,
            credential.state,
            credential.subject.type,
            credential.subject.id,
            credential.secretDigest,
            credential.createdAtMs,
            credential.notBeforeAtMs,
            credential.expiresAtMs,
          );
        client
          .prepare(
            `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
                 "credential_id", "credential_version", "pepper_key_id"
               ) VALUES (?, ?, ?)`,
          )
          .run(
            credential.credentialId,
            credential.version,
            credential.pepperKeyId,
          );
        insertLocalSecurityAudit(client, audit);
        client
          .prepare(
            `INSERT INTO "QingLong3ApiCredentialAdministrationMutations" (
                 "mutation_id", "project_id", "operation", "credential_id",
                 "credential_version", "expected_previous_version",
                 "subject_type", "subject_id", "subject_status", "state",
                 "pepper_key_id", "secret_digest", "not_before_at_ms",
                 "expires_at_ms", "delivery_digest", "changed_by_type",
                 "changed_by_id", "audit_event_id", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mutation.mutationId,
            auth.projectId,
            mutation.operation,
            credential.credentialId,
            credential.version,
            mutation.expectedPreviousVersion,
            credential.subject.type,
            credential.subject.id,
            credential.subjectStatus,
            credential.state,
            credential.pepperKeyId,
            credential.secretDigest,
            credential.notBeforeAtMs,
            credential.expiresAtMs,
            deliveryDigest,
            auth.actor.type,
            auth.actor.id,
            audit.eventId,
            credential.createdAtMs,
          );
        client.exec('COMMIT');
        return Object.freeze({
          status: 'inserted' as const,
          credential,
          mutation: Object.freeze({ ...mutation }),
          delivery:
            deliveryDigest === null
              ? null
              : Object.freeze({ digest: deliveryDigest }),
          audit,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        if (
          error instanceof
            LocalIdentityCredentialAuthorizationFenceConflictError ||
          error instanceof LocalCredentialOwnerContinuityError ||
          error instanceof ApiCredentialAdministrationSubjectNotFoundError ||
          error instanceof ApiCredentialAdministrationVersionConflictError ||
          error instanceof ApiCredentialAdministrationMutationConflictError
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
