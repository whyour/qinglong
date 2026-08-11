import {
  InvalidLocalSecurityAuditRetentionValueError,
  LocalSecurityAuditCompactionMutationConflictError,
  LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  LocalSecurityAuditRetentionUnavailableError,
  MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  localSecurityAuditCompactionPayload,
  type CompactAuthorizedLocalSecurityAuditCommand,
  type CompactAuthorizedLocalSecurityAuditResult,
  type LocalSecurityAuditCompactionRecord,
  type LocalSecurityAuditRetentionRepository,
} from '@qinglong/runtime-core/local-security-audit-retention';
import { InvalidProjectPolicyValueError } from '@qinglong/runtime-core/project-policy';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  assertLocalSecurityAuditInstanceOwnerInTransaction,
  normalizeLocalSecurityAuditInstanceAuthorization,
} from './securityAuditAuthority';
import {
  insertLocalSecurityAudit,
  LOCAL_SECURITY_AUDIT_JOIN_SELECT,
  LOCAL_SECURITY_AUDIT_SELECT,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from './securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from './securityAuthorityStore';

type Row = Record<string, unknown>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const COMPACTION_SELECT = `
  compaction."mutation_id" AS "compactionMutationId",
  compaction."request_id" AS "compactionRequestId",
  compaction."authority_project_id" AS "compactionAuthorityProjectId",
  compaction."retention_ms" AS "compactionRetentionMs",
  compaction."eligible_before_ms" AS "compactionEligibleBeforeMs",
  compaction."batch_limit" AS "compactionBatchLimit",
  compaction."deleted_count" AS "compactionDeletedCount",
  compaction."deleted_payload_bytes" AS "compactionDeletedPayloadBytes",
  compaction."first_occurred_at_ms" AS "compactionFirstOccurredAtMs",
  compaction."first_event_id" AS "compactionFirstEventId",
  compaction."last_occurred_at_ms" AS "compactionLastOccurredAtMs",
  compaction."last_event_id" AS "compactionLastEventId",
  compaction."records_digest" AS "compactionRecordsDigest",
  compaction."created_at_ms" AS "compactionCreatedAtMs"
`;

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalSecurityAuditRetentionUnavailableError();
  }
  return value as number;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new LocalSecurityAuditRetentionUnavailableError();
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  return integer(row, key);
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return text(row, key);
}

function compactionFromRow(
  row: Row,
): Readonly<LocalSecurityAuditCompactionRecord> {
  const deletedCount = integer(row, 'compactionDeletedCount');
  const firstOccurredAtMs = optionalInteger(row, 'compactionFirstOccurredAtMs');
  const firstEventId = optionalText(row, 'compactionFirstEventId');
  const lastOccurredAtMs = optionalInteger(row, 'compactionLastOccurredAtMs');
  const lastEventId = optionalText(row, 'compactionLastEventId');
  if (
    (deletedCount === 0 &&
      (firstOccurredAtMs !== null ||
        firstEventId !== null ||
        lastOccurredAtMs !== null ||
        lastEventId !== null)) ||
    (deletedCount > 0 &&
      (firstOccurredAtMs === null ||
        firstEventId === null ||
        lastOccurredAtMs === null ||
        lastEventId === null))
  ) {
    throw new LocalSecurityAuditRetentionUnavailableError();
  }
  return Object.freeze({
    mutationId: text(row, 'compactionMutationId'),
    requestId: text(row, 'compactionRequestId'),
    authorityProjectId: text(row, 'compactionAuthorityProjectId'),
    retentionMs: integer(row, 'compactionRetentionMs'),
    eligibleBeforeMs: integer(row, 'compactionEligibleBeforeMs'),
    batchLimit: integer(row, 'compactionBatchLimit'),
    deletedCount,
    deletedPayloadBytes: integer(row, 'compactionDeletedPayloadBytes'),
    first:
      firstOccurredAtMs === null
        ? null
        : Object.freeze({
            occurredAtMs: firstOccurredAtMs,
            eventId: firstEventId!,
          }),
    last:
      lastOccurredAtMs === null
        ? null
        : Object.freeze({
            occurredAtMs: lastOccurredAtMs,
            eventId: lastEventId!,
          }),
    recordsDigest: text(row, 'compactionRecordsDigest'),
    createdAtMs: integer(row, 'compactionCreatedAtMs'),
  });
}

function command(
  input: CompactAuthorizedLocalSecurityAuditCommand,
  maxBatchSize: number,
): Readonly<CompactAuthorizedLocalSecurityAuditCommand> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !==
      [
        'audit',
        'authorization',
        'eligibleBeforeMs',
        'limit',
        'mutationId',
        'requestId',
        'retentionMs',
      ]
        .sort()
        .join(',') ||
    !UUID_V4_PATTERN.test(input.mutationId) ||
    !REQUEST_ID_PATTERN.test(input.requestId) ||
    !Number.isSafeInteger(input.retentionMs) ||
    input.retentionMs < MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
    input.retentionMs > MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
    !Number.isSafeInteger(input.eligibleBeforeMs) ||
    input.eligibleBeforeMs < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maxBatchSize
  ) {
    throw new InvalidLocalSecurityAuditRetentionValueError(
      'compaction command shape is invalid',
    );
  }
  const authorization = normalizeLocalSecurityAuditInstanceAuthorization(
    input.authorization,
  );
  const audit = normalizeSecurityAuditRecord(input.audit);
  if (
    audit.eventId !== input.mutationId ||
    audit.requestId !== input.requestId ||
    audit.operationId !== 'security.audit.compact' ||
    audit.projectId !== authorization.authorityProjectId ||
    audit.subject?.type !== authorization.actor.type ||
    audit.subject.id !== authorization.actor.id ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'instance_authority_security_audit_compaction' ||
    audit.fence?.projectVersion !== authorization.fence.projectVersion ||
    audit.fence.bindingVersion !== authorization.fence.bindingVersion ||
    input.eligibleBeforeMs + input.retentionMs > audit.occurredAtMs
  ) {
    throw new InvalidLocalSecurityAuditRetentionValueError(
      'compaction audit or retention fence is invalid',
    );
  }
  return Object.freeze({
    ...input,
    authorization,
    audit,
  });
}

function sameCommand(
  record: Readonly<LocalSecurityAuditCompactionRecord>,
  audit: Readonly<SecurityAuditRecord>,
  input: Readonly<CompactAuthorizedLocalSecurityAuditCommand>,
): boolean {
  return (
    record.mutationId === input.mutationId &&
    record.requestId === input.requestId &&
    record.authorityProjectId === input.authorization.authorityProjectId &&
    record.retentionMs === input.retentionMs &&
    record.eligibleBeforeMs === input.eligibleBeforeMs &&
    record.batchLimit === input.limit &&
    sameSecurityAuditSemantic(audit, input.audit)
  );
}

export class LocalSqliteSecurityAuditRetentionRepository
  implements LocalSecurityAuditRetentionRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly beforeCompaction: () => void,
    private readonly maxBatchSize: number,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof beforeCompaction !== 'function' ||
      !Number.isSafeInteger(maxBatchSize) ||
      maxBatchSize < 1 ||
      maxBatchSize > 512
    ) {
      throw new TypeError(
        'Local SQLite security audit retention dependencies are invalid',
      );
    }
  }

  record(value: SecurityAuditRecord): Promise<void> {
    return new LocalSqliteSecurityAuthorityStore(this.authority).record(value);
  }

  resolveCompaction(
    mutationId: string,
  ): Promise<Readonly<LocalSecurityAuditCompactionRecord> | null> {
    if (!UUID_V4_PATTERN.test(mutationId)) {
      throw new InvalidLocalSecurityAuditRetentionValueError(
        'mutation identity is invalid',
      );
    }
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(
              `SELECT ${COMPACTION_SELECT}
               FROM "QingLong3SecurityAuditCompactions" AS compaction
               WHERE compaction."mutation_id" = ?`,
            )
            .get(mutationId) as Row | undefined;
          return row ? compactionFromRow(row) : null;
        } catch (error) {
          if (error instanceof InvalidLocalSecurityAuditRetentionValueError) {
            throw error;
          }
          throw new LocalSecurityAuditRetentionUnavailableError();
        }
      },
      () => new LocalSecurityAuditRetentionUnavailableError(),
    );
  }

  compactAuthorized(
    input: CompactAuthorizedLocalSecurityAuditCommand,
  ): Promise<CompactAuthorizedLocalSecurityAuditResult> {
    const value = command(input, this.maxBatchSize);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertLocalSecurityAuditInstanceOwnerInTransaction(
            this.authority,
            value.authorization,
            this.beforeCompaction,
            () =>
              new LocalSecurityAuditRetentionAuthorizationFenceConflictError(),
          );
          const replay = client
            .prepare(
              `SELECT ${COMPACTION_SELECT},
                      ${LOCAL_SECURITY_AUDIT_JOIN_SELECT}
               FROM "QingLong3SecurityAuditCompactions" AS compaction
               JOIN "QingLong3SecurityAuditEvents" AS audit
                 ON audit."event_id" = compaction."audit_event_id"
               WHERE compaction."mutation_id" = ?`,
            )
            .get(value.mutationId) as Row | undefined;
          if (replay) {
            const record = compactionFromRow(replay);
            const audit = localSecurityAuditFromRow(replay);
            if (!sameCommand(record, audit, value)) {
              throw new LocalSecurityAuditCompactionMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              record,
              audit,
            });
          }

          const rows = client
            .prepare(
              `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents" AS candidate
               WHERE candidate."occurred_at_ms" < ?
                 AND (
                   candidate."outcome" <> 'allowed'
                   OR candidate."operation_id" IN (
                     'identity.inspect',
                     'credential.inspect',
                     'policy.project.inspect',
                     'policy.project.list',
                     'policy.role_binding.inspect',
                     'policy.role_binding.list',
                     'security.audit.list'
                   )
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3ApiCredentialAdministrationMutations" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3ApiCredentialDeliveryAcknowledgements" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3IdentityAdministrationMutations" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM "QingLong3LegacyAdoptions" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM "QingLong3LocalIdentityProvisionings" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3LocalOwnerBootstrapChallenges" AS ref
                   WHERE ref."issue_audit_event_id" = candidate."event_id"
                      OR ref."claim_audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3LocalOwnerCredentialRecoveries" AS ref
                   WHERE ref."issue_audit_event_id" = candidate."event_id"
                      OR ref."complete_audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3LocalOwnerDeliveryAcknowledgementGc" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3LocalOwnerPepperMaterialGc" AS ref
                   WHERE ref."prepare_audit_event_id" = candidate."event_id"
                      OR ref."complete_audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3PluginPackageAdmissionReceipts" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3ProjectAdministrationMutations" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM "ToolExecutionAuditReceipts" AS ref
                   WHERE ref."event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM "ToolExecutionStartBarriers" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3SecurityAuditCompactions" AS ref
                   WHERE ref."audit_event_id" = candidate."event_id"
                 )
               ORDER BY candidate."occurred_at_ms" ASC,
                        candidate."event_id" ASC
               LIMIT ?`,
            )
            .all(value.eligibleBeforeMs, value.limit) as Row[];
          const records = Object.freeze(
            rows.map((row) => localSecurityAuditFromRow(row)),
          );
          const payload = localSecurityAuditCompactionPayload(records);
          const firstRecord = records.at(0);
          const lastRecord = records.at(-1);
          const record: Readonly<LocalSecurityAuditCompactionRecord> =
            Object.freeze({
              mutationId: value.mutationId,
              requestId: value.requestId,
              authorityProjectId: value.authorization.authorityProjectId,
              retentionMs: value.retentionMs,
              eligibleBeforeMs: value.eligibleBeforeMs,
              batchLimit: value.limit,
              deletedCount: records.length,
              deletedPayloadBytes: payload.payloadBytes,
              first: firstRecord
                ? Object.freeze({
                    occurredAtMs: firstRecord.occurredAtMs,
                    eventId: firstRecord.eventId,
                  })
                : null,
              last: lastRecord
                ? Object.freeze({
                    occurredAtMs: lastRecord.occurredAtMs,
                    eventId: lastRecord.eventId,
                  })
                : null,
              recordsDigest: payload.recordsDigest,
              createdAtMs: value.audit.occurredAtMs,
            });
          insertLocalSecurityAudit(client, value.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3SecurityAuditCompactions" (
                 "mutation_id", "request_id", "authority_project_id",
                 "retention_ms", "eligible_before_ms", "batch_limit",
                 "deleted_count", "deleted_payload_bytes",
                 "first_occurred_at_ms", "first_event_id",
                 "last_occurred_at_ms", "last_event_id",
                 "records_digest", "audit_event_id", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.mutationId,
              record.requestId,
              record.authorityProjectId,
              record.retentionMs,
              record.eligibleBeforeMs,
              record.batchLimit,
              record.deletedCount,
              record.deletedPayloadBytes,
              record.first?.occurredAtMs ?? null,
              record.first?.eventId ?? null,
              record.last?.occurredAtMs ?? null,
              record.last?.eventId ?? null,
              record.recordsDigest,
              value.audit.eventId,
              record.createdAtMs,
            );
          if (records.length > 0) {
            const placeholders = records.map(() => '?').join(',');
            const deleted = client
              .prepare(
                `DELETE FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" IN (${placeholders})`,
              )
              .run(...records.map((candidate) => candidate.eventId));
            if (deleted.changes !== records.length) {
              throw new LocalSecurityAuditRetentionUnavailableError();
            }
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'inserted' as const,
            record,
            audit: value.audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof InvalidLocalSecurityAuditRetentionValueError ||
            error instanceof
              LocalSecurityAuditRetentionAuthorizationFenceConflictError ||
            error instanceof
              LocalSecurityAuditCompactionMutationConflictError ||
            error instanceof SecurityAuditUnavailableError
          ) {
            throw error;
          }
          throw new LocalSecurityAuditRetentionUnavailableError();
        }
      },
      () => new LocalSecurityAuditRetentionUnavailableError(),
    );
  }
}
