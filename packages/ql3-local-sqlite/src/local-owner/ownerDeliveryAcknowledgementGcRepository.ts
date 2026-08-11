import type { DatabaseSync } from 'node:sqlite';
import {
  localOwnerSecretDeliveryAcknowledgementSemanticDigest,
  normalizeLocalOwnerSecretDeliveryAcknowledgementRecord,
  type LocalOwnerSecretDeliveryAcknowledgementRecord,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import {
  LocalOwnerDeliveryAcknowledgementGcMutationConflictError,
  LocalOwnerDeliveryAcknowledgementGcReferenceConflictError,
  LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError,
  LocalOwnerDeliveryAcknowledgementGcRetentionPendingError,
  localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest,
  normalizeCompactLocalOwnerDeliveryAcknowledgementCommand,
  type CompactLocalOwnerDeliveryAcknowledgementCommand,
  type LocalOwnerDeliveryAcknowledgementGcRecord,
  type LocalOwnerDeliveryAcknowledgementGcRepository,
  type LocalOwnerDeliveryAcknowledgementGcResult,
} from '@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type QueryRow = Record<string, unknown>;

const GC_SELECT = `
SELECT * FROM "QingLong3LocalOwnerDeliveryAcknowledgementGc"`;

function text(row: QueryRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
  return value;
}

function optionalText(row: QueryRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return text(row, name);
}

function integer(row: QueryRow, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
  return value;
}

function safeRetentionTimestamp(base: number, duration: number): number {
  const result = base + duration;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
  return result;
}

function acknowledgementFromRow(
  row: QueryRow,
): Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> {
  try {
    const common = {
      mutationId: text(row, 'mutation_id'),
      requestId: text(row, 'request_id'),
      factDigest: text(row, 'fact_digest'),
      deliveryDigest: text(row, 'delivery_digest'),
      ttlMs: integer(row, 'ttl_ms'),
      acknowledgedAtMs: integer(row, 'acknowledged_at_ms'),
    };
    const kind = text(row, 'kind');
    return normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(
      kind === 'credential'
        ? {
            ...common,
            kind,
            subjectId: text(row, 'subject_id'),
            credentialId: text(row, 'credential_id'),
          }
        : {
            ...common,
            kind: kind as 'challenge',
            projectId: text(row, 'project_id'),
            challengeId: text(row, 'challenge_id'),
          },
    );
  } catch (error) {
    if (
      error instanceof
      LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError
    ) {
      throw error;
    }
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
}

function gcRecord(
  row: QueryRow,
): Readonly<LocalOwnerDeliveryAcknowledgementGcRecord> {
  const kind = text(row, 'acknowledgement_kind');
  const provisioningMutationId = optionalText(row, 'provisioning_mutation_id');
  const challengeMutationId = optionalText(row, 'challenge_mutation_id');
  const acknowledgementMutationId = text(row, 'acknowledgement_mutation_id');
  if (
    (kind !== 'credential' && kind !== 'challenge') ||
    (kind === 'credential' &&
      (provisioningMutationId !== acknowledgementMutationId ||
        challengeMutationId !== undefined)) ||
    (kind === 'challenge' &&
      (challengeMutationId !== acknowledgementMutationId ||
        provisioningMutationId !== undefined))
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
  const retentionPolicy = Object.freeze({
    version: 1 as const,
    replayRetentionMs: integer(row, 'replay_retention_ms'),
    auditRetentionMs: integer(row, 'audit_retention_ms'),
  });
  const retentionPolicyDigest = text(row, 'retention_policy_digest');
  if (
    integer(row, 'retention_policy_version') !== 1 ||
    localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(
      retentionPolicy,
    ) !== retentionPolicyDigest
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
  }
  return Object.freeze({
    mutationId: text(row, 'gc_mutation_id'),
    requestId: text(row, 'gc_request_id'),
    acknowledgementMutationId,
    acknowledgementKind: kind,
    deliveryDigest: text(row, 'delivery_digest'),
    acknowledgedAtMs: integer(row, 'acknowledged_at_ms'),
    acknowledgementSemanticDigest: text(row, 'acknowledgement_semantic_digest'),
    bridgeClearEvidenceDigest: text(row, 'bridge_clear_evidence_digest'),
    retentionPolicy,
    retentionPolicyDigest,
    retentionEligibleAtMs: integer(row, 'retention_eligible_at_ms'),
    compactedAtMs: integer(row, 'compacted_at_ms'),
  });
}

function sameCompact(
  record: Readonly<LocalOwnerDeliveryAcknowledgementGcRecord>,
  command: Readonly<CompactLocalOwnerDeliveryAcknowledgementCommand>,
): boolean {
  return (
    record.mutationId === command.mutationId &&
    record.requestId === command.requestId &&
    record.acknowledgementMutationId === command.acknowledgementMutationId &&
    record.acknowledgementKind === command.expectedKind &&
    record.deliveryDigest === command.expectedDeliveryDigest &&
    record.bridgeClearEvidenceDigest ===
      command.bridgeClearEvidence.evidenceDigest &&
    record.retentionPolicyDigest ===
      localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(
        command.retentionPolicy,
      ) &&
    record.compactedAtMs === command.compactedAtMs
  );
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

function sourceRetentionEligibleAt(
  client: DatabaseSync,
  acknowledgement: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>,
  command: Readonly<CompactLocalOwnerDeliveryAcknowledgementCommand>,
): number {
  const replayEligibleAt = safeRetentionTimestamp(
    acknowledgement.acknowledgedAtMs,
    command.retentionPolicy.replayRetentionMs,
  );
  if (acknowledgement.kind === 'credential') {
    const source = client
      .prepare(
        `SELECT provisioning."request_id", provisioning."subject_id",
                provisioning."credential_id", credential."version",
                credential."secret_digest", credential."not_before_at_ms",
                credential."expires_at_ms", audit."occurred_at_ms"
         FROM "QingLong3LocalIdentityProvisionings" AS provisioning
         JOIN "QingLong3ApiCredentials" AS credential
           ON credential."credential_id" = provisioning."credential_id"
          AND credential."version" = provisioning."credential_version"
         JOIN "QingLong3SecurityAuditEvents" AS audit
           ON audit."event_id" = provisioning."audit_event_id"
         WHERE provisioning."mutation_id" = ?`,
      )
      .get(acknowledgement.mutationId) as QueryRow | undefined;
    if (
      !source ||
      text(source, 'request_id') !== acknowledgement.requestId ||
      text(source, 'subject_id') !== acknowledgement.subjectId ||
      text(source, 'credential_id') !== acknowledgement.credentialId ||
      text(source, 'secret_digest') !== acknowledgement.factDigest ||
      integer(source, 'expires_at_ms') - integer(source, 'not_before_at_ms') !==
        acknowledgement.ttlMs
    ) {
      throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
    }
    const current = client
      .prepare(
        `SELECT "state", "expires_at_ms"
         FROM "QingLong3ApiCredentials"
         WHERE "credential_id" = ?
         ORDER BY "version" DESC LIMIT 1`,
      )
      .get(acknowledgement.credentialId) as QueryRow | undefined;
    if (
      !current ||
      (text(current, 'state') === 'active' &&
        integer(current, 'expires_at_ms') > command.compactedAtMs)
    ) {
      throw new LocalOwnerDeliveryAcknowledgementGcReferenceConflictError();
    }
    if (
      client
        .prepare(
          `SELECT 1
           FROM "QingLong3LocalOwnerCredentialRecoveries"
           WHERE "state" <> 'completed'
             AND (("previous_credential_id" = ? AND "previous_credential_version" = ?)
               OR ("replacement_credential_id" = ? AND "replacement_credential_version" = ?))
           LIMIT 1`,
        )
        .get(
          acknowledgement.credentialId,
          integer(source, 'version'),
          acknowledgement.credentialId,
          integer(source, 'version'),
        )
    ) {
      throw new LocalOwnerDeliveryAcknowledgementGcReferenceConflictError();
    }
    return Math.max(
      replayEligibleAt,
      integer(source, 'expires_at_ms'),
      safeRetentionTimestamp(
        integer(source, 'occurred_at_ms'),
        command.retentionPolicy.auditRetentionMs,
      ),
    );
  }

  const source = client
    .prepare(
      `SELECT challenge."issue_request_id", challenge."project_id",
              challenge."challenge_id", challenge."token_digest",
              challenge."issued_at_ms", challenge."expires_at_ms",
              challenge."consumed_at_ms",
              issue_audit."occurred_at_ms" AS "issue_audit_at_ms",
              claim_audit."occurred_at_ms" AS "claim_audit_at_ms"
       FROM "QingLong3LocalOwnerBootstrapChallenges" AS challenge
       JOIN "QingLong3SecurityAuditEvents" AS issue_audit
         ON issue_audit."event_id" = challenge."issue_audit_event_id"
       LEFT JOIN "QingLong3SecurityAuditEvents" AS claim_audit
         ON claim_audit."event_id" = challenge."claim_audit_event_id"
       WHERE challenge."issue_mutation_id" = ?`,
    )
    .get(acknowledgement.mutationId) as QueryRow | undefined;
  if (
    !source ||
    text(source, 'issue_request_id') !== acknowledgement.requestId ||
    text(source, 'project_id') !== acknowledgement.projectId ||
    text(source, 'challenge_id') !== acknowledgement.challengeId ||
    text(source, 'token_digest') !== acknowledgement.factDigest ||
    integer(source, 'expires_at_ms') - integer(source, 'issued_at_ms') !==
      acknowledgement.ttlMs
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
  }
  if (
    source.consumed_at_ms === null &&
    integer(source, 'expires_at_ms') > command.compactedAtMs
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcReferenceConflictError();
  }
  const claimAuditAtMs =
    source.claim_audit_at_ms === null
      ? undefined
      : integer(source, 'claim_audit_at_ms');
  return Math.max(
    replayEligibleAt,
    integer(source, 'expires_at_ms'),
    safeRetentionTimestamp(
      integer(source, 'issue_audit_at_ms'),
      command.retentionPolicy.auditRetentionMs,
    ),
    ...(claimAuditAtMs === undefined
      ? []
      : [
          safeRetentionTimestamp(
            claimAuditAtMs,
            command.retentionPolicy.auditRetentionMs,
          ),
        ]),
  );
}

function isDomainError(error: unknown): boolean {
  return (
    error instanceof LocalOwnerDeliveryAcknowledgementGcMutationConflictError ||
    error instanceof
      LocalOwnerDeliveryAcknowledgementGcReferenceConflictError ||
    error instanceof LocalOwnerDeliveryAcknowledgementGcRetentionPendingError ||
    error instanceof
      LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError
  );
}

export class LocalSqliteOwnerDeliveryAcknowledgementGcRepository
  implements LocalOwnerDeliveryAcknowledgementGcRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  resolveByAcknowledgement(
    acknowledgementMutationId: string,
  ): Promise<Readonly<LocalOwnerDeliveryAcknowledgementGcRecord> | null> {
    if (typeof acknowledgementMutationId !== 'string') {
      throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
    }
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(`${GC_SELECT} WHERE "acknowledgement_mutation_id" = ?`)
            .get(acknowledgementMutationId) as QueryRow | undefined;
          return row ? gcRecord(row) : null;
        } catch (error) {
          if (isDomainError(error)) throw error;
          throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError(),
    );
  }

  compact(
    candidate: CompactLocalOwnerDeliveryAcknowledgementCommand,
  ): Promise<Readonly<LocalOwnerDeliveryAcknowledgementGcResult>> {
    const command =
      normalizeCompactLocalOwnerDeliveryAcknowledgementCommand(candidate);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const replay = client
            .prepare(`${GC_SELECT} WHERE "gc_mutation_id" = ?`)
            .get(command.mutationId) as QueryRow | undefined;
          if (replay) {
            const record = gcRecord(replay);
            if (!sameCompact(record, command)) {
              throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({ status: 'existing' as const, record });
          }
          if (
            client
              .prepare(`${GC_SELECT} WHERE "acknowledgement_mutation_id" = ?`)
              .get(command.acknowledgementMutationId)
          ) {
            throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
          }
          const row = client
            .prepare(
              `SELECT * FROM "QingLong3LocalOwnerDeliveryAcknowledgements"
               WHERE "mutation_id" = ?`,
            )
            .get(command.acknowledgementMutationId) as QueryRow | undefined;
          if (!row) {
            throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
          }
          const acknowledgement = acknowledgementFromRow(row);
          if (
            acknowledgement.kind !== command.expectedKind ||
            acknowledgement.deliveryDigest !== command.expectedDeliveryDigest
          ) {
            throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
          }
          const eligibleAtMs = sourceRetentionEligibleAt(
            client,
            acknowledgement,
            command,
          );
          if (command.compactedAtMs < eligibleAtMs) {
            throw new LocalOwnerDeliveryAcknowledgementGcRetentionPendingError(
              eligibleAtMs,
            );
          }
          if (
            client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ?`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
          }
          const semanticDigest =
            localOwnerSecretDeliveryAcknowledgementSemanticDigest(
              acknowledgement,
            );
          const policyDigest =
            localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(
              command.retentionPolicy,
            );
          insertAudit(client, command.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerDeliveryAcknowledgementGc" (
                 gc_mutation_id, gc_request_id,
                 acknowledgement_mutation_id, acknowledgement_kind,
                 delivery_digest, acknowledged_at_ms,
                 acknowledgement_semantic_digest,
                 bridge_clear_evidence_digest, retention_policy_version,
                 replay_retention_ms, audit_retention_ms,
                 retention_policy_digest, retention_eligible_at_ms,
                 compacted_at_ms, audit_event_id,
                 provisioning_mutation_id, challenge_mutation_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.mutationId,
              command.requestId,
              acknowledgement.mutationId,
              acknowledgement.kind,
              acknowledgement.deliveryDigest,
              acknowledgement.acknowledgedAtMs,
              semanticDigest,
              command.bridgeClearEvidence.evidenceDigest,
              command.retentionPolicy.replayRetentionMs,
              command.retentionPolicy.auditRetentionMs,
              policyDigest,
              eligibleAtMs,
              command.compactedAtMs,
              command.audit.eventId,
              acknowledgement.kind === 'credential'
                ? acknowledgement.mutationId
                : null,
              acknowledgement.kind === 'challenge'
                ? acknowledgement.mutationId
                : null,
            );
          const deleted = client
            .prepare(
              `DELETE FROM "QingLong3LocalOwnerDeliveryAcknowledgements"
               WHERE "mutation_id" = ?`,
            )
            .run(acknowledgement.mutationId);
          if (deleted.changes !== 1) {
            throw new LocalOwnerDeliveryAcknowledgementGcMutationConflictError();
          }
          const inserted = client
            .prepare(`${GC_SELECT} WHERE "gc_mutation_id" = ?`)
            .get(command.mutationId) as QueryRow | undefined;
          if (!inserted) {
            throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
          }
          const record = gcRecord(inserted);
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, record });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError(),
    );
  }
}
