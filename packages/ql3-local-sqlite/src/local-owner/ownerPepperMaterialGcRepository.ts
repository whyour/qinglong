import type { DatabaseSync } from 'node:sqlite';
import {
  LocalOwnerPepperMaterialGcInProgressError,
  LocalOwnerPepperMaterialGcMutationConflictError,
  LocalOwnerPepperMaterialGcReferenceConflictError,
  LocalOwnerPepperMaterialGcRepositoryUnavailableError,
  LocalOwnerPepperMaterialGcRetentionPendingError,
  localOwnerPepperMaterialGcRetentionPolicyDigest,
  normalizeCompleteLocalOwnerPepperMaterialGcCommand,
  normalizePrepareLocalOwnerPepperMaterialGcCommand,
  type CompleteLocalOwnerPepperMaterialGcCommand,
  type LocalOwnerPepperMaterialGcRecord,
  type LocalOwnerPepperMaterialGcRepository,
  type LocalOwnerPepperMaterialGcResult,
  type PrepareLocalOwnerPepperMaterialGcCommand,
} from '@qinglong/runtime-core/local-owner-pepper-material-gc';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type QueryRow = Record<string, unknown>;

const GC_SELECT = `
SELECT * FROM "QingLong3LocalOwnerPepperMaterialGc"`;

function text(row: QueryRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
  }
  return value;
}

function optionalInteger(row: QueryRow, name: string): number | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return integer(row, name);
}

function gcRecord(row: QueryRow): Readonly<LocalOwnerPepperMaterialGcRecord> {
  const state = text(row, 'state');
  const completeMutationId = optionalText(row, 'complete_mutation_id');
  const completeRequestId = optionalText(row, 'complete_request_id');
  const destructionProofDigest = optionalText(row, 'destruction_proof_digest');
  const completedAtMs = optionalInteger(row, 'completed_at_ms');
  if (
    (state !== 'prepared' && state !== 'completed') ||
    (state === 'prepared' &&
      (completeMutationId !== undefined ||
        completeRequestId !== undefined ||
        destructionProofDigest !== undefined ||
        completedAtMs !== undefined)) ||
    (state === 'completed' &&
      (completeMutationId === undefined ||
        completeRequestId === undefined ||
        destructionProofDigest === undefined ||
        completedAtMs === undefined))
  ) {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
  }
  const retentionPolicy = Object.freeze({
    version: 1 as const,
    acknowledgementRetentionMs: integer(row, 'acknowledgement_retention_ms'),
    auditRetentionMs: integer(row, 'audit_retention_ms'),
    backupRetentionMs: integer(row, 'backup_retention_ms'),
  });
  if (
    integer(row, 'retention_policy_version') !== 1 ||
    localOwnerPepperMaterialGcRetentionPolicyDigest(retentionPolicy) !==
      text(row, 'retention_policy_digest')
  ) {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
  }
  return Object.freeze({
    prepareMutationId: text(row, 'prepare_mutation_id'),
    prepareRequestId: text(row, 'prepare_request_id'),
    pepperKeyId: text(row, 'pepper_key_id'),
    materialDigest: text(row, 'material_digest'),
    backupMaterialDigest: text(row, 'backup_material_digest'),
    activePepperKeyId: text(row, 'active_pepper_key_id'),
    activeGeneration: integer(row, 'active_generation'),
    activeMaterialDigest: text(row, 'active_material_digest'),
    retentionPolicy,
    retentionPolicyDigest: text(row, 'retention_policy_digest'),
    referencesInspectedAtMs: integer(row, 'references_inspected_at_ms'),
    retentionEligibleAtMs: integer(row, 'retention_eligible_at_ms'),
    preparedAtMs: integer(row, 'prepared_at_ms'),
    state,
    ...(completeMutationId === undefined ? {} : { completeMutationId }),
    ...(completeRequestId === undefined ? {} : { completeRequestId }),
    ...(destructionProofDigest === undefined ? {} : { destructionProofDigest }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  });
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

function safeRetentionTimestamp(base: number, duration: number): number {
  const result = base + duration;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
  }
  return result;
}

function nullableMaximum(row: QueryRow | undefined): number | undefined {
  const value = row?.latest_at_ms;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
  }
  return value;
}

function retentionEligibleAt(
  client: DatabaseSync,
  pepperKeyId: string,
  retiredAtMs: number,
  command: Readonly<PrepareLocalOwnerPepperMaterialGcCommand>,
): number {
  const acknowledgement = nullableMaximum(
    client
      .prepare(
        `SELECT MAX("acknowledged_at_ms") AS "latest_at_ms"
         FROM (
           SELECT acknowledgement."acknowledged_at_ms"
           FROM "QingLong3LocalOwnerDeliveryAcknowledgements" AS acknowledgement
           JOIN "QingLong3ApiCredentialPepperBindings" AS binding
             ON binding."credential_id" = acknowledgement."credential_id"
           WHERE acknowledgement."kind" = 'credential'
             AND binding."pepper_key_id" = ?
           UNION ALL
           SELECT compacted."acknowledged_at_ms"
           FROM "QingLong3LocalOwnerDeliveryAcknowledgementGc" AS compacted
           JOIN "QingLong3LocalIdentityProvisionings" AS provisioning
             ON provisioning."mutation_id" = compacted."provisioning_mutation_id"
           JOIN "QingLong3ApiCredentialPepperBindings" AS binding
             ON binding."credential_id" = provisioning."credential_id"
            AND binding."credential_version" = provisioning."credential_version"
           WHERE compacted."acknowledgement_kind" = 'credential'
             AND binding."pepper_key_id" = ?
           UNION ALL
           SELECT recovery."acknowledged_at_ms"
           FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
           WHERE recovery."acknowledged_at_ms" IS NOT NULL
             AND (
               EXISTS (
                 SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS previous
                 WHERE previous."credential_id" = recovery."previous_credential_id"
                   AND previous."credential_version" = recovery."previous_credential_version"
                   AND previous."pepper_key_id" = ?
               )
               OR EXISTS (
                 SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS replacement
                 WHERE replacement."credential_id" = recovery."replacement_credential_id"
                   AND replacement."credential_version" = recovery."replacement_credential_version"
                   AND replacement."pepper_key_id" = ?
               )
             )
         )`,
      )
      .get(pepperKeyId, pepperKeyId, pepperKeyId, pepperKeyId) as
      | QueryRow
      | undefined,
  );
  const securityAudit = nullableMaximum(
    client
      .prepare(
        `SELECT MAX(audit."occurred_at_ms") AS "latest_at_ms"
         FROM "QingLong3SecurityAuditEvents" AS audit
         WHERE audit."event_id" IN (
           SELECT provisioning."audit_event_id"
           FROM "QingLong3LocalIdentityProvisionings" AS provisioning
           JOIN "QingLong3ApiCredentialPepperBindings" AS binding
             ON binding."credential_id" = provisioning."credential_id"
            AND binding."credential_version" = provisioning."credential_version"
           WHERE binding."pepper_key_id" = ?
           UNION
           SELECT recovery."issue_audit_event_id"
           FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
           WHERE EXISTS (
             SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS binding
             WHERE binding."pepper_key_id" = ?
               AND (
                 (binding."credential_id" = recovery."previous_credential_id"
                   AND binding."credential_version" = recovery."previous_credential_version")
                 OR (binding."credential_id" = recovery."replacement_credential_id"
                   AND binding."credential_version" = recovery."replacement_credential_version")
               )
           )
           UNION
           SELECT recovery."complete_audit_event_id"
           FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
           WHERE recovery."complete_audit_event_id" IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS binding
               WHERE binding."pepper_key_id" = ?
                 AND (
                   (binding."credential_id" = recovery."previous_credential_id"
                     AND binding."credential_version" = recovery."previous_credential_version")
                   OR (binding."credential_id" = recovery."replacement_credential_id"
                     AND binding."credential_version" = recovery."replacement_credential_version")
                 )
             )
         )`,
      )
      .get(pepperKeyId, pepperKeyId, pepperKeyId) as QueryRow | undefined,
  );
  return Math.max(
    safeRetentionTimestamp(
      retiredAtMs,
      command.retentionPolicy.backupRetentionMs,
    ),
    ...(acknowledgement === undefined
      ? []
      : [
          safeRetentionTimestamp(
            acknowledgement,
            command.retentionPolicy.acknowledgementRetentionMs,
          ),
        ]),
    ...(securityAudit === undefined
      ? []
      : [
          safeRetentionTimestamp(
            securityAudit,
            command.retentionPolicy.auditRetentionMs,
          ),
        ]),
  );
}

function hasRuntimeReferences(
  client: DatabaseSync,
  pepperKeyId: string,
  inspectedAtMs: number,
): boolean {
  const current = client
    .prepare(
      `SELECT 1
       FROM "QingLong3ApiCredentialPepperBindings" AS binding
       JOIN "QingLong3ApiCredentials" AS credential
         ON credential."credential_id" = binding."credential_id"
        AND credential."version" = binding."credential_version"
       WHERE binding."pepper_key_id" = ?
         AND credential."state" = 'active'
         AND credential."expires_at_ms" > ?
         AND NOT EXISTS (
           SELECT 1 FROM "QingLong3ApiCredentials" AS later
           WHERE later."credential_id" = credential."credential_id"
             AND later."version" > credential."version"
         )
       LIMIT 1`,
    )
    .get(pepperKeyId, inspectedAtMs);
  if (current) return true;
  return !!client
    .prepare(
      `SELECT 1
       FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
       WHERE recovery."state" <> 'completed'
         AND (
           EXISTS (
             SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS previous
             WHERE previous."credential_id" = recovery."previous_credential_id"
               AND previous."credential_version" = recovery."previous_credential_version"
               AND previous."pepper_key_id" = ?
           )
           OR EXISTS (
             SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" AS replacement
             WHERE replacement."credential_id" = recovery."replacement_credential_id"
               AND replacement."credential_version" = recovery."replacement_credential_version"
               AND replacement."pepper_key_id" = ?
           )
         )
       LIMIT 1`,
    )
    .get(pepperKeyId, pepperKeyId);
}

function samePrepare(
  record: Readonly<LocalOwnerPepperMaterialGcRecord>,
  command: Readonly<PrepareLocalOwnerPepperMaterialGcCommand>,
): boolean {
  return (
    record.prepareMutationId === command.mutationId &&
    record.prepareRequestId === command.requestId &&
    record.pepperKeyId === command.pepperKeyId &&
    record.materialDigest === command.expectedMaterialDigest &&
    record.backupMaterialDigest === command.expectedBackupMaterialDigest &&
    record.activePepperKeyId === command.expectedActivePepperKeyId &&
    record.activeGeneration === command.expectedActiveGeneration &&
    record.activeMaterialDigest === command.expectedActiveMaterialDigest &&
    record.retentionPolicyDigest ===
      localOwnerPepperMaterialGcRetentionPolicyDigest(
        command.retentionPolicy,
      ) &&
    record.preparedAtMs === command.preparedAtMs
  );
}

function sameComplete(
  record: Readonly<LocalOwnerPepperMaterialGcRecord>,
  command: Readonly<CompleteLocalOwnerPepperMaterialGcCommand>,
): boolean {
  return (
    record.completeMutationId === command.mutationId &&
    record.completeRequestId === command.requestId &&
    record.destructionProofDigest === command.destructionProofDigest &&
    record.completedAtMs === command.completedAtMs
  );
}

function isDomainError(error: unknown): boolean {
  return (
    error instanceof LocalOwnerPepperMaterialGcMutationConflictError ||
    error instanceof LocalOwnerPepperMaterialGcInProgressError ||
    error instanceof LocalOwnerPepperMaterialGcReferenceConflictError ||
    error instanceof LocalOwnerPepperMaterialGcRetentionPendingError ||
    error instanceof LocalOwnerPepperMaterialGcRepositoryUnavailableError
  );
}

export class LocalSqliteOwnerPepperMaterialGcRepository
  implements LocalOwnerPepperMaterialGcRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  resolve(
    prepareMutationId: string,
  ): Promise<Readonly<LocalOwnerPepperMaterialGcRecord> | null> {
    if (typeof prepareMutationId !== 'string') {
      throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
    }
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(`${GC_SELECT} WHERE "prepare_mutation_id" = ?`)
            .get(prepareMutationId) as QueryRow | undefined;
          return row ? gcRecord(row) : null;
        } catch (error) {
          if (isDomainError(error)) throw error;
          throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperMaterialGcRepositoryUnavailableError(),
    );
  }

  prepare(
    candidate: PrepareLocalOwnerPepperMaterialGcCommand,
  ): Promise<LocalOwnerPepperMaterialGcResult> {
    const command =
      normalizePrepareLocalOwnerPepperMaterialGcCommand(candidate);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const replay = client
            .prepare(`${GC_SELECT} WHERE "prepare_mutation_id" = ?`)
            .get(command.mutationId) as QueryRow | undefined;
          if (replay) {
            const record = gcRecord(replay);
            if (!samePrepare(record, command)) {
              throw new LocalOwnerPepperMaterialGcMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({ status: 'existing' as const, record });
          }
          if (
            client
              .prepare(`${GC_SELECT} WHERE "state" = 'prepared' LIMIT 1`)
              .get()
          ) {
            throw new LocalOwnerPepperMaterialGcInProgressError();
          }
          const key = client
            .prepare(
              `SELECT "material_digest", "backup_digest", "retired_at_ms"
               FROM "QingLong3LocalOwnerPepperKeys"
               WHERE "pepper_key_id" = ? AND "state" = 'retired'`,
            )
            .get(command.pepperKeyId) as QueryRow | undefined;
          if (
            !key ||
            text(key, 'material_digest') !== command.expectedMaterialDigest ||
            text(key, 'backup_digest') !== command.expectedBackupMaterialDigest
          ) {
            throw new LocalOwnerPepperMaterialGcMutationConflictError();
          }
          const active = client
            .prepare(
              `SELECT activation."generation", key."pepper_key_id",
                      key."material_digest"
               FROM "QingLong3LocalOwnerPepperActivations" AS activation
               JOIN "QingLong3LocalOwnerPepperKeys" AS key
                 ON key."pepper_key_id" = activation."active_pepper_key_id"
               WHERE key."state" = 'active'
               ORDER BY activation."generation" DESC
               LIMIT 1`,
            )
            .get() as QueryRow | undefined;
          if (
            !active ||
            integer(active, 'generation') !==
              command.expectedActiveGeneration ||
            text(active, 'pepper_key_id') !==
              command.expectedActivePepperKeyId ||
            text(active, 'material_digest') !==
              command.expectedActiveMaterialDigest
          ) {
            throw new LocalOwnerPepperMaterialGcMutationConflictError();
          }
          if (
            hasRuntimeReferences(
              client,
              command.pepperKeyId,
              command.preparedAtMs,
            )
          ) {
            throw new LocalOwnerPepperMaterialGcReferenceConflictError();
          }
          const eligibleAtMs = retentionEligibleAt(
            client,
            command.pepperKeyId,
            integer(key, 'retired_at_ms'),
            command,
          );
          if (command.preparedAtMs < eligibleAtMs) {
            throw new LocalOwnerPepperMaterialGcRetentionPendingError(
              eligibleAtMs,
            );
          }
          const policyDigest = localOwnerPepperMaterialGcRetentionPolicyDigest(
            command.retentionPolicy,
          );
          insertAudit(client, command.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerPepperMaterialGc" (
                 prepare_mutation_id, prepare_request_id, pepper_key_id,
                 material_digest, backup_material_digest,
                 active_pepper_key_id, active_generation,
                 active_material_digest, retention_policy_version,
                 acknowledgement_retention_ms, audit_retention_ms,
                 backup_retention_ms, retention_policy_digest,
                 references_inspected_at_ms, retention_eligible_at_ms,
                 prepared_at_ms, prepare_audit_event_id, state
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')`,
            )
            .run(
              command.mutationId,
              command.requestId,
              command.pepperKeyId,
              command.expectedMaterialDigest,
              command.expectedBackupMaterialDigest,
              command.expectedActivePepperKeyId,
              command.expectedActiveGeneration,
              command.expectedActiveMaterialDigest,
              command.retentionPolicy.acknowledgementRetentionMs,
              command.retentionPolicy.auditRetentionMs,
              command.retentionPolicy.backupRetentionMs,
              policyDigest,
              command.preparedAtMs,
              eligibleAtMs,
              command.preparedAtMs,
              command.audit.eventId,
            );
          const inserted = client
            .prepare(`${GC_SELECT} WHERE "prepare_mutation_id" = ?`)
            .get(command.mutationId) as QueryRow | undefined;
          if (!inserted) {
            throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
          }
          const record = gcRecord(inserted);
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, record });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperMaterialGcRepositoryUnavailableError(),
    );
  }

  complete(
    candidate: CompleteLocalOwnerPepperMaterialGcCommand,
  ): Promise<LocalOwnerPepperMaterialGcResult> {
    const command =
      normalizeCompleteLocalOwnerPepperMaterialGcCommand(candidate);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const row = client
            .prepare(`${GC_SELECT} WHERE "prepare_mutation_id" = ?`)
            .get(command.prepareMutationId) as QueryRow | undefined;
          if (!row) {
            throw new LocalOwnerPepperMaterialGcMutationConflictError();
          }
          const existing = gcRecord(row);
          if (existing.state === 'completed') {
            if (!sameComplete(existing, command)) {
              throw new LocalOwnerPepperMaterialGcMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              record: existing,
            });
          }
          if (command.completedAtMs < existing.preparedAtMs) {
            throw new LocalOwnerPepperMaterialGcMutationConflictError();
          }
          insertAudit(client, command.audit);
          const result = client
            .prepare(
              `UPDATE "QingLong3LocalOwnerPepperMaterialGc"
               SET "state" = 'completed',
                   "complete_mutation_id" = ?,
                   "complete_request_id" = ?,
                   "destruction_proof_digest" = ?,
                   "completed_at_ms" = ?,
                   "complete_audit_event_id" = ?
               WHERE "prepare_mutation_id" = ? AND "state" = 'prepared'`,
            )
            .run(
              command.mutationId,
              command.requestId,
              command.destructionProofDigest,
              command.completedAtMs,
              command.audit.eventId,
              command.prepareMutationId,
            );
          if (result.changes !== 1) {
            throw new LocalOwnerPepperMaterialGcMutationConflictError();
          }
          const completed = client
            .prepare(`${GC_SELECT} WHERE "prepare_mutation_id" = ?`)
            .get(command.prepareMutationId) as QueryRow | undefined;
          if (!completed) {
            throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
          }
          const record = gcRecord(completed);
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, record });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerPepperMaterialGcRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperMaterialGcRepositoryUnavailableError(),
    );
  }
}
