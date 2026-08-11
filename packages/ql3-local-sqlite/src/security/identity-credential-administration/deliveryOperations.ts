import { normalizeApiCredentialAdministrationMutationId } from '@qinglong/runtime-core/api-credential-administration';
import {
  LocalCredentialDeliveryMutationConflictError,
  LocalIdentityCredentialAdministrationUnavailableError,
  LocalIdentityCredentialAuthorizationFenceConflictError,
  type AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand,
  type AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult,
  type LocalCredentialDeliveryAcknowledgementRecord,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import { SecurityAuditUnavailableError } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../securityPersistence';

import {
  ADMIN_AUDIT_SELECT,
  DIGEST_PATTERN,
  assertAllowedAudit,
  authorization,
  integer,
  optionalText,
  sameSubject,
  text,
  type Row,
} from './codec';

import { assertAuthorizationInTransaction } from './authorization';

export function resolveDeliveryAcknowledgement(
  authority: LocalSqliteOperationAuthority,
  credentialMutationId: string,
): Promise<Readonly<LocalCredentialDeliveryAcknowledgementRecord> | null> {
  normalizeApiCredentialAdministrationMutationId(credentialMutationId);
  return authority.enqueue(
    async () => {
      const row = authority.client
        .prepare(
          `SELECT "credential_mutation_id" AS "credentialMutationId",
                    "acknowledgement_mutation_id" AS "acknowledgementMutationId",
                    "project_id" AS "projectId",
                    "delivery_digest" AS "deliveryDigest",
                    "acknowledged_by_type" AS "acknowledgedByType",
                    "acknowledged_by_id" AS "acknowledgedById",
                    "acknowledged_at_ms" AS "acknowledgedAtMs"
             FROM "QingLong3ApiCredentialDeliveryAcknowledgements"
             WHERE "credential_mutation_id" = ?`,
        )
        .get(credentialMutationId) as Row | undefined;
      return row
        ? Object.freeze({
            credentialMutationId: text(row, 'credentialMutationId'),
            acknowledgementMutationId: text(row, 'acknowledgementMutationId'),
            projectId: text(row, 'projectId'),
            deliveryDigest: text(row, 'deliveryDigest'),
            acknowledgedBy: Object.freeze({
              type: text(row, 'acknowledgedByType') as SecuritySubject['type'],
              id: text(row, 'acknowledgedById'),
            }),
            acknowledgedAtMs: integer(row, 'acknowledgedAtMs'),
          })
        : null;
    },
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}

export function appendAuthorizedDeliveryAcknowledgement(
  authority: LocalSqliteOperationAuthority,
  beforeMutation: () => void,
  input: AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand,
): Promise<AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult> {
  const auth = authorization(input.authorization);
  const acknowledgement = input.acknowledgement;
  normalizeApiCredentialAdministrationMutationId(
    acknowledgement.credentialMutationId,
  );
  normalizeApiCredentialAdministrationMutationId(
    acknowledgement.acknowledgementMutationId,
  );
  if (
    acknowledgement.credentialMutationId ===
      acknowledgement.acknowledgementMutationId ||
    acknowledgement.projectId !== auth.projectId ||
    !DIGEST_PATTERN.test(acknowledgement.deliveryDigest) ||
    !sameSubject(acknowledgement.acknowledgedBy, auth.actor) ||
    !Number.isSafeInteger(acknowledgement.acknowledgedAtMs) ||
    acknowledgement.acknowledgedAtMs < 0
  ) {
    throw new TypeError('Local credential delivery acknowledgement is invalid');
  }
  const audit = assertAllowedAudit(
    input.audit,
    'credential.delivery.acknowledge',
    acknowledgement.acknowledgementMutationId,
    auth,
  );
  return authority.enqueue(
    async () => {
      const client = authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        assertAuthorizationInTransaction(authority, auth, beforeMutation);
        const existing = client
          .prepare(
            `SELECT "credential_mutation_id" AS "credentialMutationId",
                      "acknowledgement_mutation_id" AS "acknowledgementMutationId",
                      "project_id" AS "projectId",
                      "delivery_digest" AS "deliveryDigest",
                      "acknowledged_by_type" AS "acknowledgedByType",
                      "acknowledged_by_id" AS "acknowledgedById",
                      "acknowledged_at_ms" AS "acknowledgedAtMs"
               FROM "QingLong3ApiCredentialDeliveryAcknowledgements"
               WHERE "credential_mutation_id" = ?
                  OR "acknowledgement_mutation_id" = ?
               LIMIT 1`,
          )
          .get(
            acknowledgement.credentialMutationId,
            acknowledgement.acknowledgementMutationId,
          ) as Row | undefined;
        if (existing) {
          const stored = Object.freeze({
            credentialMutationId: text(existing, 'credentialMutationId'),
            acknowledgementMutationId: text(
              existing,
              'acknowledgementMutationId',
            ),
            projectId: text(existing, 'projectId'),
            deliveryDigest: text(existing, 'deliveryDigest'),
            acknowledgedBy: Object.freeze({
              type: text(
                existing,
                'acknowledgedByType',
              ) as SecuritySubject['type'],
              id: text(existing, 'acknowledgedById'),
            }),
            acknowledgedAtMs: integer(existing, 'acknowledgedAtMs'),
          });
          const auditRow = client
            .prepare(
              `SELECT ${ADMIN_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents" AS audit
                 WHERE "event_id" = ?`,
            )
            .get(stored.acknowledgementMutationId) as Row | undefined;
          if (
            stored.credentialMutationId !==
              acknowledgement.credentialMutationId ||
            stored.acknowledgementMutationId !==
              acknowledgement.acknowledgementMutationId ||
            stored.projectId !== acknowledgement.projectId ||
            stored.deliveryDigest !== acknowledgement.deliveryDigest ||
            !sameSubject(
              stored.acknowledgedBy,
              acknowledgement.acknowledgedBy,
            ) ||
            !auditRow ||
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              audit,
            )
          ) {
            throw new LocalCredentialDeliveryMutationConflictError();
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            acknowledgement: stored,
            audit: localSecurityAuditFromRow(auditRow),
          });
        }
        const credentialMutation = client
          .prepare(
            `SELECT "project_id" AS "projectId",
                      "delivery_digest" AS "deliveryDigest",
                      "operation" AS "operation"
               FROM "QingLong3ApiCredentialAdministrationMutations"
               WHERE "mutation_id" = ?`,
          )
          .get(acknowledgement.credentialMutationId) as Row | undefined;
        if (
          !credentialMutation ||
          text(credentialMutation, 'projectId') !== auth.projectId ||
          text(credentialMutation, 'operation') === 'revoke' ||
          optionalText(credentialMutation, 'deliveryDigest') !==
            acknowledgement.deliveryDigest
        ) {
          throw new LocalCredentialDeliveryMutationConflictError();
        }
        insertLocalSecurityAudit(client, audit);
        client
          .prepare(
            `INSERT INTO "QingLong3ApiCredentialDeliveryAcknowledgements" (
                 "credential_mutation_id", "acknowledgement_mutation_id",
                 "project_id", "delivery_digest", "acknowledged_by_type",
                 "acknowledged_by_id", "audit_event_id",
                 "acknowledged_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            acknowledgement.credentialMutationId,
            acknowledgement.acknowledgementMutationId,
            acknowledgement.projectId,
            acknowledgement.deliveryDigest,
            acknowledgement.acknowledgedBy.type,
            acknowledgement.acknowledgedBy.id,
            audit.eventId,
            acknowledgement.acknowledgedAtMs,
          );
        client.exec('COMMIT');
        return Object.freeze({
          status: 'inserted' as const,
          acknowledgement: Object.freeze({
            ...acknowledgement,
            acknowledgedBy: Object.freeze({
              ...acknowledgement.acknowledgedBy,
            }),
          }),
          audit,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        if (
          error instanceof
            LocalIdentityCredentialAuthorizationFenceConflictError ||
          error instanceof LocalCredentialDeliveryMutationConflictError
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
