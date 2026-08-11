import type { DatabaseSync } from 'node:sqlite';
import {
  LocalOwnerCredentialRecoveryCredentialUnavailableError,
  LocalOwnerCredentialRecoveryInProgressError,
  LocalOwnerCredentialRecoveryMutationConflictError,
  LocalOwnerCredentialRecoveryNotAcknowledgedError,
  LocalOwnerCredentialRecoveryRepositoryUnavailableError,
  normalizeAcknowledgeLocalOwnerCredentialRecoveryCommand,
  normalizeCompleteLocalOwnerCredentialRecoveryCommand,
  normalizeIssueLocalOwnerCredentialRecoveryCommand,
  type AcknowledgeLocalOwnerCredentialRecoveryCommand,
  type CompleteLocalOwnerCredentialRecoveryCommand,
  type IssueLocalOwnerCredentialRecoveryCommand,
  type LocalOwnerCredentialRecoveryRecord,
  type LocalOwnerCredentialRecoveryRepository,
  type LocalOwnerCredentialRecoveryResult,
} from '@qinglong/runtime-core/local-owner-credential-recovery';
import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '@qinglong/runtime-core/api-credential';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type QueryRow = Record<string, unknown>;

const RECOVERY_SELECT = `
SELECT recovery.*,
       replacement."state" AS "replacement_state",
       replacement."subject_type" AS "replacement_subject_type",
       replacement."subject_id" AS "replacement_subject_id",
       replacement."secret_digest" AS "replacement_secret_digest",
       replacement."created_at_ms" AS "replacement_created_at_ms",
       replacement."not_before_at_ms" AS "replacement_not_before_at_ms",
       replacement."expires_at_ms" AS "replacement_expires_at_ms",
       identity."status" AS "replacement_subject_status",
       pepper."pepper_key_id" AS "replacement_pepper_key_id"
FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
JOIN "QingLong3ApiCredentials" AS replacement
  ON replacement."credential_id" = recovery."replacement_credential_id"
 AND replacement."version" = recovery."replacement_credential_version"
JOIN "QingLong3IdentitySubjects" AS identity
  ON identity."subject_type" = replacement."subject_type"
 AND identity."subject_id" = replacement."subject_id"
JOIN "QingLong3ApiCredentialPepperBindings" AS pepper
  ON pepper."credential_id" = replacement."credential_id"
 AND pepper."credential_version" = replacement."version"`;

const CREDENTIAL_SELECT = `
SELECT credential."credential_id" AS "credential_credential_id",
       credential."version" AS "credential_credential_version",
       credential."state" AS "credential_state",
       credential."subject_type" AS "credential_subject_type",
       credential."subject_id" AS "credential_subject_id",
       credential."secret_digest" AS "credential_secret_digest",
       credential."created_at_ms" AS "credential_created_at_ms",
       credential."not_before_at_ms" AS "credential_not_before_at_ms",
       credential."expires_at_ms" AS "credential_expires_at_ms",
       identity."status" AS "credential_subject_status",
       pepper."pepper_key_id" AS "credential_pepper_key_id"
FROM "QingLong3ApiCredentials" AS credential
JOIN "QingLong3IdentitySubjects" AS identity
  ON identity."subject_type" = credential."subject_type"
 AND identity."subject_id" = credential."subject_id"
JOIN "QingLong3ApiCredentialPepperBindings" AS pepper
  ON pepper."credential_id" = credential."credential_id"
 AND pepper."credential_version" = credential."version"`;

function string(row: QueryRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
  }
  return value;
}

function optionalString(row: QueryRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return string(row, name);
}

function integer(row: QueryRow, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
  }
  return value;
}

function optionalInteger(row: QueryRow, name: string): number | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  return integer(row, name);
}

function credentialFromRow(
  row: QueryRow,
  prefix: 'credential' | 'replacement',
): Readonly<ApiCredentialRecord> {
  try {
    return normalizeApiCredentialRecord({
      credentialId: string(row, `${prefix}_credential_id`),
      version: integer(row, `${prefix}_credential_version`),
      pepperKeyId: string(row, `${prefix}_pepper_key_id`),
      state: string(row, `${prefix}_state`) as ApiCredentialRecord['state'],
      subject: {
        type: string(
          row,
          `${prefix}_subject_type`,
        ) as ApiCredentialRecord['subject']['type'],
        id: string(row, `${prefix}_subject_id`),
      },
      subjectStatus: string(
        row,
        `${prefix}_subject_status`,
      ) as ApiCredentialRecord['subjectStatus'],
      secretDigest: string(row, `${prefix}_secret_digest`),
      createdAtMs: integer(row, `${prefix}_created_at_ms`),
      notBeforeAtMs: integer(row, `${prefix}_not_before_at_ms`),
      expiresAtMs: integer(row, `${prefix}_expires_at_ms`),
    });
  } catch (error) {
    if (
      error instanceof LocalOwnerCredentialRecoveryRepositoryUnavailableError
    ) {
      throw error;
    }
    throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
  }
}

function recoveryFromRow(
  row: QueryRow,
): Readonly<LocalOwnerCredentialRecoveryRecord> {
  const state = string(row, 'state');
  if (state !== 'issued' && state !== 'acknowledged' && state !== 'completed') {
    throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
  }
  const deliveryDigest = optionalString(row, 'delivery_digest');
  const acknowledgedAtMs = optionalInteger(row, 'acknowledged_at_ms');
  const completeMutationId = optionalString(row, 'complete_mutation_id');
  const completeRequestId = optionalString(row, 'complete_request_id');
  const revokedCredentialVersion = optionalInteger(
    row,
    'revoked_credential_version',
  );
  const completedAtMs = optionalInteger(row, 'completed_at_ms');
  if (
    (state === 'issued' &&
      (deliveryDigest !== undefined ||
        acknowledgedAtMs !== undefined ||
        completeMutationId !== undefined ||
        completeRequestId !== undefined ||
        revokedCredentialVersion !== undefined ||
        completedAtMs !== undefined)) ||
    (state === 'acknowledged' &&
      (deliveryDigest === undefined ||
        acknowledgedAtMs === undefined ||
        completeMutationId !== undefined ||
        completeRequestId !== undefined ||
        revokedCredentialVersion !== undefined ||
        completedAtMs !== undefined)) ||
    (state === 'completed' &&
      (deliveryDigest === undefined ||
        acknowledgedAtMs === undefined ||
        completeMutationId === undefined ||
        completeRequestId === undefined ||
        revokedCredentialVersion === undefined ||
        completedAtMs === undefined))
  ) {
    throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
  }
  return Object.freeze({
    issueMutationId: string(row, 'issue_mutation_id'),
    issueRequestId: string(row, 'issue_request_id'),
    subjectId: string(row, 'subject_id'),
    previousCredentialId: string(row, 'previous_credential_id'),
    previousCredentialVersion: integer(row, 'previous_credential_version'),
    replacementCredential: credentialFromRow(row, 'replacement'),
    state,
    issuedAtMs: integer(row, 'issued_at_ms'),
    ...(deliveryDigest === undefined ? {} : { deliveryDigest }),
    ...(acknowledgedAtMs === undefined ? {} : { acknowledgedAtMs }),
    ...(completeMutationId === undefined ? {} : { completeMutationId }),
    ...(completeRequestId === undefined ? {} : { completeRequestId }),
    ...(revokedCredentialVersion === undefined
      ? {}
      : { revokedCredentialVersion }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  });
}

function sameCredential(
  left: Readonly<ApiCredentialRecord>,
  right: Readonly<ApiCredentialRecord>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function insertAudit(
  client: DatabaseSync,
  audit: Readonly<SecurityAuditRecord>,
) {
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

function isDomainError(error: unknown): boolean {
  return (
    error instanceof LocalOwnerCredentialRecoveryMutationConflictError ||
    error instanceof LocalOwnerCredentialRecoveryInProgressError ||
    error instanceof LocalOwnerCredentialRecoveryNotAcknowledgedError ||
    error instanceof LocalOwnerCredentialRecoveryCredentialUnavailableError ||
    error instanceof LocalOwnerCredentialRecoveryRepositoryUnavailableError
  );
}

export class LocalSqliteOwnerCredentialRecoveryRepository
  implements LocalOwnerCredentialRecoveryRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  private resolveDirect(
    issueMutationId: string,
  ): Readonly<LocalOwnerCredentialRecoveryRecord> | null {
    const rows = this.authority.client
      .prepare(
        `${RECOVERY_SELECT} WHERE recovery."issue_mutation_id" = ? LIMIT 2`,
      )
      .all(issueMutationId) as QueryRow[];
    if (rows.length > 1) {
      throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
    }
    return rows[0] ? recoveryFromRow(rows[0]) : null;
  }

  private currentCredentialDirect(
    credentialId: string,
  ): Readonly<ApiCredentialRecord> | null {
    const row = this.authority.client
      .prepare(
        `${CREDENTIAL_SELECT}
         WHERE credential."credential_id" = ?
         ORDER BY credential."version" DESC LIMIT 1`,
      )
      .get(credentialId) as QueryRow | undefined;
    return row ? credentialFromRow(row, 'credential') : null;
  }

  resolve(
    issueMutationId: string,
  ): Promise<Readonly<LocalOwnerCredentialRecoveryRecord> | null> {
    return this.authority.enqueue(
      async () => {
        try {
          return this.resolveDirect(issueMutationId);
        } catch (error) {
          if (
            error instanceof
            LocalOwnerCredentialRecoveryRepositoryUnavailableError
          ) {
            throw error;
          }
          throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerCredentialRecoveryRepositoryUnavailableError(),
    );
  }

  issue(
    input: IssueLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult> {
    const command = normalizeIssueLocalOwnerCredentialRecoveryCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const replay = this.resolveDirect(command.mutationId);
          if (replay) {
            if (
              replay.issueRequestId !== command.requestId ||
              replay.previousCredentialId !== command.previousCredentialId ||
              replay.previousCredentialVersion !==
                command.expectedPreviousVersion ||
              !sameCredential(
                replay.replacementCredential,
                command.replacementCredential,
              )
            ) {
              throw new LocalOwnerCredentialRecoveryMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              recovery: replay,
            });
          }
          if (
            client
              .prepare(
                `SELECT 1 FROM "QingLong3LocalOwnerCredentialRecoveries"
                 WHERE "subject_id" = ? AND "state" <> 'completed' LIMIT 1`,
              )
              .get(command.replacementCredential.subject.id)
          ) {
            throw new LocalOwnerCredentialRecoveryInProgressError();
          }
          const previous = this.currentCredentialDirect(
            command.previousCredentialId,
          );
          if (
            !previous ||
            previous.version !== command.expectedPreviousVersion ||
            previous.state !== 'active' ||
            previous.subject.type !== 'user' ||
            previous.subject.id !== command.replacementCredential.subject.id ||
            previous.subjectStatus !== 'active' ||
            previous.notBeforeAtMs >
              command.replacementCredential.createdAtMs ||
            previous.expiresAtMs <= command.replacementCredential.createdAtMs
          ) {
            throw new LocalOwnerCredentialRecoveryCredentialUnavailableError();
          }
          const activePepper = client
            .prepare(
              `SELECT key."pepper_key_id"
               FROM "QingLong3LocalOwnerPepperActivations" AS activation
               JOIN "QingLong3LocalOwnerPepperKeys" AS key
                 ON key."pepper_key_id" = activation."active_pepper_key_id"
               WHERE key."state" = 'active'
               ORDER BY activation."generation" DESC LIMIT 1`,
            )
            .get() as QueryRow | undefined;
          if (
            !activePepper ||
            string(activePepper, 'pepper_key_id') !==
              command.replacementCredential.pepperKeyId
          ) {
            throw new LocalOwnerCredentialRecoveryCredentialUnavailableError();
          }
          if (
            client
              .prepare(
                `SELECT 1 FROM "QingLong3ApiCredentials"
                 WHERE "credential_id" = ? LIMIT 1`,
              )
              .get(command.replacementCredential.credentialId) ||
            client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ? LIMIT 1`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          const replacement = command.replacementCredential;
          client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentials" (
                 credential_id, version, state, subject_type, subject_id,
                 secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              replacement.credentialId,
              replacement.version,
              replacement.state,
              replacement.subject.type,
              replacement.subject.id,
              replacement.secretDigest,
              replacement.createdAtMs,
              replacement.notBeforeAtMs,
              replacement.expiresAtMs,
            );
          client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
                 credential_id, credential_version, pepper_key_id
               ) VALUES (?, ?, ?)`,
            )
            .run(
              replacement.credentialId,
              replacement.version,
              replacement.pepperKeyId,
            );
          insertAudit(client, command.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerCredentialRecoveries" (
                 issue_mutation_id, issue_request_id, subject_type, subject_id,
                 previous_credential_id, previous_credential_version,
                 replacement_credential_id, replacement_credential_version,
                 state, issued_at_ms, issue_audit_event_id
               ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'issued', ?, ?)`,
            )
            .run(
              command.mutationId,
              command.requestId,
              replacement.subject.id,
              command.previousCredentialId,
              command.expectedPreviousVersion,
              replacement.credentialId,
              replacement.version,
              replacement.createdAtMs,
              command.audit.eventId,
            );
          const recovery = this.resolveDirect(command.mutationId);
          if (!recovery) {
            throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
          }
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, recovery });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerCredentialRecoveryRepositoryUnavailableError(),
    );
  }

  acknowledge(
    input: AcknowledgeLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult> {
    const command =
      normalizeAcknowledgeLocalOwnerCredentialRecoveryCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const recovery = this.resolveDirect(command.issueMutationId);
          if (
            !recovery ||
            recovery.issueRequestId !== command.requestId ||
            recovery.replacementCredential.credentialId !==
              command.credentialId ||
            recovery.replacementCredential.secretDigest !==
              command.factDigest ||
            command.acknowledgedAtMs < recovery.issuedAtMs ||
            command.acknowledgedAtMs >=
              recovery.replacementCredential.expiresAtMs
          ) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          if (recovery.state !== 'issued') {
            if (
              recovery.deliveryDigest !== command.deliveryDigest ||
              recovery.acknowledgedAtMs !== command.acknowledgedAtMs
            ) {
              throw new LocalOwnerCredentialRecoveryMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              recovery,
            });
          }
          const changed = client
            .prepare(
              `UPDATE "QingLong3LocalOwnerCredentialRecoveries"
               SET state = 'acknowledged', delivery_digest = ?,
                   acknowledged_at_ms = ?
               WHERE issue_mutation_id = ? AND state = 'issued'`,
            )
            .run(
              command.deliveryDigest,
              command.acknowledgedAtMs,
              command.issueMutationId,
            );
          if (changed.changes !== 1) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          const acknowledged = this.resolveDirect(command.issueMutationId);
          if (!acknowledged || acknowledged.state !== 'acknowledged') {
            throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'inserted' as const,
            recovery: acknowledged,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerCredentialRecoveryRepositoryUnavailableError(),
    );
  }

  complete(
    input: CompleteLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult> {
    const command = normalizeCompleteLocalOwnerCredentialRecoveryCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const replayRow = client
            .prepare(
              `SELECT "issue_mutation_id"
               FROM "QingLong3LocalOwnerCredentialRecoveries"
               WHERE "complete_mutation_id" = ? LIMIT 1`,
            )
            .get(command.mutationId) as QueryRow | undefined;
          if (replayRow) {
            const replay = this.resolveDirect(
              string(replayRow, 'issue_mutation_id'),
            );
            const replayedRevocation = replay
              ? this.currentCredentialDirect(replay.previousCredentialId)
              : null;
            if (
              !replay ||
              !replayedRevocation ||
              replay.issueMutationId !== command.issueMutationId ||
              replay.completeRequestId !== command.requestId ||
              replay.previousCredentialVersion !==
                command.expectedPreviousVersion ||
              replay.revokedCredentialVersion !==
                command.revokedCredential.version ||
              replay.completedAtMs !== command.revokedCredential.createdAtMs ||
              !sameCredential(replayedRevocation, command.revokedCredential)
            ) {
              throw new LocalOwnerCredentialRecoveryMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              recovery: replay,
            });
          }
          const recovery = this.resolveDirect(command.issueMutationId);
          if (!recovery) {
            throw new LocalOwnerCredentialRecoveryCredentialUnavailableError();
          }
          if (recovery.state === 'issued') {
            throw new LocalOwnerCredentialRecoveryNotAcknowledgedError();
          }
          if (recovery.state === 'completed') {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          const previous = this.currentCredentialDirect(
            recovery.previousCredentialId,
          );
          const revoked = command.revokedCredential;
          if (
            !previous ||
            previous.version !== command.expectedPreviousVersion ||
            previous.version !== recovery.previousCredentialVersion ||
            previous.state !== 'active' ||
            previous.subject.id !== recovery.subjectId ||
            revoked.credentialId !== previous.credentialId ||
            revoked.subject.type !== previous.subject.type ||
            revoked.subject.id !== previous.subject.id ||
            revoked.subjectStatus !== previous.subjectStatus ||
            revoked.pepperKeyId !== previous.pepperKeyId ||
            revoked.createdAtMs < (recovery.acknowledgedAtMs ?? 0) ||
            revoked.createdAtMs >= recovery.replacementCredential.expiresAtMs
          ) {
            throw new LocalOwnerCredentialRecoveryCredentialUnavailableError();
          }
          if (
            client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ? LIMIT 1`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentials" (
                 credential_id, version, state, subject_type, subject_id,
                 secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              revoked.credentialId,
              revoked.version,
              revoked.state,
              revoked.subject.type,
              revoked.subject.id,
              revoked.secretDigest,
              revoked.createdAtMs,
              revoked.notBeforeAtMs,
              revoked.expiresAtMs,
            );
          client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
                 credential_id, credential_version, pepper_key_id
               ) VALUES (?, ?, ?)`,
            )
            .run(revoked.credentialId, revoked.version, revoked.pepperKeyId);
          insertAudit(client, command.audit);
          const changed = client
            .prepare(
              `UPDATE "QingLong3LocalOwnerCredentialRecoveries"
               SET state = 'completed', complete_mutation_id = ?,
                   complete_request_id = ?, revoked_credential_version = ?,
                   completed_at_ms = ?, complete_audit_event_id = ?
               WHERE issue_mutation_id = ? AND state = 'acknowledged'`,
            )
            .run(
              command.mutationId,
              command.requestId,
              revoked.version,
              revoked.createdAtMs,
              command.audit.eventId,
              command.issueMutationId,
            );
          if (changed.changes !== 1) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          const completed = this.resolveDirect(command.issueMutationId);
          if (!completed || completed.state !== 'completed') {
            throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
          }
          client.exec('COMMIT');
          return Object.freeze({
            status: 'inserted' as const,
            recovery: completed,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (isDomainError(error)) throw error;
          throw new LocalOwnerCredentialRecoveryRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerCredentialRecoveryRepositoryUnavailableError(),
    );
  }
}
