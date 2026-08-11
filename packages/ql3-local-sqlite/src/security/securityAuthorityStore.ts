import type { DatabaseSync } from 'node:sqlite';

import {
  LocalSecretMutationConflictError,
  LocalSecretVersionConflictError,
  MAX_LOCAL_SECRET_BATCH_SIZE,
  assertLocalSecretExpectedVersion,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretProjectId,
  createLocalSecretRef,
  normalizeLocalSecretEnvelope,
  type AppendLocalSecretEnvelopeCommand,
  type AppendLocalSecretEnvelopeResult,
  type LocalSecretEnvelope,
  type LocalSecretEnvelopeRepository,
  type LocalSecretReference,
} from '@qinglong/runtime-core/local-secret';
import {
  LocalSecretAuthorizationFenceConflictError,
  type AppendAuthorizedLocalSecretEnvelopeCommand,
  type AppendAuthorizedLocalSecretEnvelopeResult,
  type LocalSecretAdministrationMutation,
  type LocalSecretAdministrationRepository,
} from '@qinglong/runtime-core/local-secret-administration';
import {
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertExpectedProjectRoleBindingVersion,
  assertProjectPolicyProjectId,
  normalizeProjectPolicySnapshot,
  normalizeProjectPolicySubject,
  normalizeProjectRoleBinding,
  type AppendProjectRoleBindingCommand,
  type AppendProjectRoleBindingResult,
  type ProjectPolicyRepository,
  type ProjectPolicySnapshot,
} from '@qinglong/runtime-core/project-policy';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
} from '@qinglong/runtime-core/run-repository';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  insertLocalSecurityAudit,
  LOCAL_PROJECT_SELECT,
  LOCAL_ROLE_BINDING_SELECT,
  LOCAL_SECRET_JOIN_SELECT,
  LOCAL_SECRET_SELECT,
  LOCAL_SECURITY_AUDIT_JOIN_SELECT,
  LOCAL_SECURITY_AUDIT_SELECT,
  localProjectFromRow,
  localRoleBindingFromRow,
  localSecretEnvelopeFromRow,
  localSecurityAuditFromRow,
  mapSqliteError,
  queryRows,
  requiredInteger,
  requiredString,
  sameSecurityAuditSemantic,
  singleRow,
  type QueryRow,
} from './securityPersistence';

export interface LocalSqliteSecurityAuthorityStoreOptions {
  readonly beforeAuthorizedLocalSecretMutation?: () => void;
}

/**
 * Package-private owner for Project Policy, Security Audit and Local Secret
 * persistence. All operations reuse one LocalSqliteOperationAuthority; this
 * class neither creates nor closes the underlying connection.
 */
export class LocalSqliteSecurityAuthorityStore
  implements
    ProjectPolicyRepository,
    SecurityAuditSink,
    LocalSecretEnvelopeRepository,
    LocalSecretAdministrationRepository
{
  private readonly client: DatabaseSync;
  private readonly beforeAuthorizedLocalSecretMutation:
    | (() => void)
    | undefined;

  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    options: LocalSqliteSecurityAuthorityStoreOptions = {},
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => key !== 'beforeAuthorizedLocalSecretMutation',
      ) ||
      (options.beforeAuthorizedLocalSecretMutation !== undefined &&
        typeof options.beforeAuthorizedLocalSecretMutation !== 'function')
    ) {
      throw new TypeError(
        'Local SQLite Security authority dependencies are invalid',
      );
    }
    this.client = authority.client;
    this.beforeAuthorizedLocalSecretMutation =
      options.beforeAuthorizedLocalSecretMutation;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return this.authority.enqueue(work, (reason) =>
      reason === 'busy'
        ? new RunRepositoryBusyError()
        : new RunRepositoryOperationError(
            new Error('Local SQLite Run repository is closed'),
          ),
    );
  }

  resolve(
    projectId: string,
    subjectValue: Parameters<ProjectPolicyRepository['resolve']>[1],
  ): Promise<Readonly<ProjectPolicySnapshot> | null> {
    assertProjectPolicyProjectId(projectId);
    const subject = normalizeProjectPolicySubject(subjectValue);
    return this.enqueue(async () => {
      try {
        const projectRow = singleRow(
          queryRows(
            this.client,
            `SELECT ${LOCAL_PROJECT_SELECT}
             FROM "QingLong3Projects" WHERE "id" = ? LIMIT 2`,
            [projectId],
          ),
        );
        if (!projectRow) return null;
        const bindingRow = singleRow(
          queryRows(
            this.client,
            `SELECT ${LOCAL_ROLE_BINDING_SELECT}
             FROM "QingLong3ProjectRoleBindings"
             WHERE "project_id" = ? AND "subject_type" = ?
               AND "subject_id" = ?
             ORDER BY "version" DESC LIMIT 1`,
            [projectId, subject.type, subject.id],
          ),
        );
        return normalizeProjectPolicySnapshot({
          project: localProjectFromRow(projectRow),
          ...(bindingRow
            ? { binding: localRoleBindingFromRow(bindingRow) }
            : {}),
        });
      } catch {
        throw new ProjectPolicyUnavailableError();
      }
    });
  }

  append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult> {
    assertExpectedProjectRoleBindingVersion(command.expectedCurrentVersion);
    const binding = normalizeProjectRoleBinding(command.binding);
    if (binding.version !== command.expectedCurrentVersion + 1) {
      return Promise.reject(new ProjectRoleBindingVersionConflictError());
    }
    return this.enqueue(async () => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const replayRow = singleRow(
          queryRows(
            this.client,
            `SELECT ${LOCAL_ROLE_BINDING_SELECT}
             FROM "QingLong3ProjectRoleBindings"
             WHERE "project_id" = ? AND "subject_type" = ?
               AND "subject_id" = ? AND "mutation_id" = ?
             LIMIT 2`,
            [
              binding.projectId,
              binding.subject.type,
              binding.subject.id,
              binding.mutationId,
            ],
          ),
        );
        if (replayRow) {
          const existing = localRoleBindingFromRow(replayRow);
          if (JSON.stringify(existing) !== JSON.stringify(binding)) {
            throw new ProjectRoleBindingMutationConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            binding: existing,
          });
        }
        const current = this.client
          .prepare(
            `SELECT MAX("version") AS "version"
             FROM "QingLong3ProjectRoleBindings"
             WHERE "project_id" = ? AND "subject_type" = ?
               AND "subject_id" = ?`,
          )
          .get(binding.projectId, binding.subject.type, binding.subject.id) as
          | QueryRow
          | undefined;
        const currentVersion =
          current?.version === null || current?.version === undefined
            ? 0
            : requiredInteger(current, 'version');
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new ProjectRoleBindingVersionConflictError();
        }
        const project = this.client
          .prepare(`SELECT "id" FROM "QingLong3Projects" WHERE "id" = ?`)
          .get(binding.projectId);
        if (!project) throw new ProjectPolicyUnavailableError();
        this.client
          .prepare(
            `INSERT INTO "QingLong3ProjectRoleBindings" (
               "project_id", "subject_type", "subject_id", "version",
               "state", "role", "mutation_id", "changed_by_type",
               "changed_by_id", "created_at_ms"
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.projectId,
            binding.subject.type,
            binding.subject.id,
            binding.version,
            binding.state,
            binding.role ?? null,
            binding.mutationId,
            binding.changedBy.type,
            binding.changedBy.id,
            binding.createdAtMs,
          );
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'inserted' as const,
          binding,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure.
          }
        }
        if (
          error instanceof ProjectRoleBindingVersionConflictError ||
          error instanceof ProjectRoleBindingMutationConflictError ||
          error instanceof ProjectPolicyUnavailableError
        ) {
          throw error;
        }
        throw new ProjectPolicyUnavailableError();
      }
    });
  }

  record(value: SecurityAuditRecord): Promise<void> {
    const audit = normalizeSecurityAuditRecord(value);
    return this.enqueue(async () => {
      try {
        insertLocalSecurityAudit(this.client, audit);
      } catch {
        try {
          const row = singleRow(
            queryRows(
              this.client,
              `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ? LIMIT 2`,
              [audit.eventId],
            ),
          );
          if (
            row &&
            sameSecurityAuditSemantic(localSecurityAuditFromRow(row), audit)
          ) {
            return;
          }
        } catch {
          // Collapse storage and corruption failures to one low-sensitive error.
        }
        throw new SecurityAuditUnavailableError();
      }
    });
  }

  resolveLocalSecretAdministrationMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<Readonly<LocalSecretAdministrationMutation> | null> {
    assertLocalSecretProjectId(projectId);
    assertLocalSecretName(name);
    assertLocalSecretMutationId(mutationId);
    return this.enqueue(async () => {
      const row = singleRow(
        queryRows(
          this.client,
          `SELECT ${LOCAL_SECRET_JOIN_SELECT}, ${LOCAL_SECURITY_AUDIT_JOIN_SELECT}
           FROM "QingLong3LocalSecretEnvelopes" AS secret
           JOIN "QingLong3SecurityAuditEvents" AS audit
             ON audit."event_id" = secret."mutation_id"
           WHERE secret."project_id" = ? AND secret."secret_name" = ?
             AND secret."mutation_id" = ?
           LIMIT 2`,
          [projectId, name, mutationId],
        ),
      );
      if (!row) return null;
      return Object.freeze({
        envelope: localSecretEnvelopeFromRow(row),
        audit: localSecurityAuditFromRow(row),
      });
    });
  }

  appendAuthorizedLocalSecretEnvelope(
    command: AppendAuthorizedLocalSecretEnvelopeCommand,
  ): Promise<AppendAuthorizedLocalSecretEnvelopeResult> {
    assertLocalSecretExpectedVersion(command.expectedCurrentVersion);
    const envelope = normalizeLocalSecretEnvelope(command.envelope);
    const subject = normalizeProjectPolicySubject(command.subject);
    const audit = normalizeSecurityAuditRecord(command.audit);
    const fence = command.fence;
    if (
      !fence ||
      typeof fence !== 'object' ||
      Array.isArray(fence) ||
      Object.keys(fence).sort().join(',') !== 'bindingVersion,projectVersion' ||
      !Number.isSafeInteger(fence.projectVersion) ||
      fence.projectVersion < 1 ||
      !Number.isSafeInteger(fence.bindingVersion) ||
      (fence.bindingVersion as number) < 1 ||
      envelope.version !== command.expectedCurrentVersion + 1 ||
      audit.eventId !== envelope.mutationId ||
      audit.projectId !== envelope.projectId ||
      audit.subject?.type !== subject.type ||
      audit.subject?.id !== subject.id ||
      audit.outcome !== 'allowed' ||
      audit.fence?.projectVersion !== fence.projectVersion ||
      audit.fence?.bindingVersion !== fence.bindingVersion ||
      (audit.operationId !== 'secret.create' &&
        audit.operationId !== 'secret.rotate')
    ) {
      return Promise.reject(new LocalSecretMutationConflictError());
    }
    return this.enqueue(async () => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        if (this.beforeAuthorizedLocalSecretMutation) {
          try {
            this.beforeAuthorizedLocalSecretMutation();
          } catch {
            throw new LocalSecretAuthorizationFenceConflictError();
          }
        }
        const replay = singleRow(
          queryRows(
            this.client,
            `SELECT ${LOCAL_SECRET_JOIN_SELECT}, ${LOCAL_SECURITY_AUDIT_JOIN_SELECT}
             FROM "QingLong3LocalSecretEnvelopes" AS secret
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit."event_id" = secret."mutation_id"
             WHERE secret."project_id" = ? AND secret."secret_name" = ?
               AND secret."mutation_id" = ?
             LIMIT 2`,
            [envelope.projectId, envelope.name, envelope.mutationId],
          ),
        );
        if (replay) {
          const existingEnvelope = localSecretEnvelopeFromRow(replay);
          const existingAudit = localSecurityAuditFromRow(replay);
          if (!sameSecurityAuditSemantic(existingAudit, audit)) {
            throw new LocalSecretMutationConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            envelope: existingEnvelope,
            audit: existingAudit,
          });
        }
        const occupiedAudit = this.client
          .prepare(
            `SELECT "event_id" FROM "QingLong3SecurityAuditEvents"
             WHERE "event_id" = ? LIMIT 1`,
          )
          .get(audit.eventId);
        if (occupiedAudit) throw new LocalSecretMutationConflictError();

        const projectRow = this.client
          .prepare(
            `SELECT "version", "status" FROM "QingLong3Projects"
             WHERE "id" = ? LIMIT 1`,
          )
          .get(envelope.projectId) as QueryRow | undefined;
        if (
          !projectRow ||
          requiredInteger(projectRow, 'version') !== fence.projectVersion ||
          requiredString(projectRow, 'status') !== 'active'
        ) {
          throw new LocalSecretAuthorizationFenceConflictError();
        }
        const bindingRow = this.client
          .prepare(
            `SELECT "version", "state", "role"
             FROM "QingLong3ProjectRoleBindings"
             WHERE "project_id" = ? AND "subject_type" = ?
               AND "subject_id" = ?
             ORDER BY "version" DESC LIMIT 1`,
          )
          .get(envelope.projectId, subject.type, subject.id) as
          | QueryRow
          | undefined;
        if (
          !bindingRow ||
          requiredInteger(bindingRow, 'version') !== fence.bindingVersion ||
          requiredString(bindingRow, 'state') !== 'active' ||
          !['owner', 'admin'].includes(requiredString(bindingRow, 'role'))
        ) {
          throw new LocalSecretAuthorizationFenceConflictError();
        }
        const current = this.client
          .prepare(
            `SELECT MAX("version") AS "version"
             FROM "QingLong3LocalSecretEnvelopes"
             WHERE "project_id" = ? AND "secret_name" = ?`,
          )
          .get(envelope.projectId, envelope.name) as QueryRow | undefined;
        const currentVersion =
          current?.version === null || current?.version === undefined
            ? 0
            : requiredInteger(current, 'version');
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new LocalSecretVersionConflictError();
        }
        const nonce = Buffer.from(envelope.nonce, 'base64url');
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
        const authTag = Buffer.from(envelope.authTag, 'base64url');
        try {
          this.client
            .prepare(
              `INSERT INTO "QingLong3LocalSecretEnvelopes" (
                 "project_id", "secret_name", "version", "mutation_id",
                 "key_id", "algorithm", "nonce", "ciphertext", "auth_tag",
                 "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              envelope.projectId,
              envelope.name,
              envelope.version,
              envelope.mutationId,
              envelope.keyId,
              envelope.algorithm,
              nonce,
              ciphertext,
              authTag,
              envelope.createdAtMs,
            );
        } finally {
          nonce.fill(0);
          ciphertext.fill(0);
          authTag.fill(0);
        }
        insertLocalSecurityAudit(this.client, audit);
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'inserted' as const,
          envelope,
          audit,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure.
          }
        }
        if (
          error instanceof LocalSecretAuthorizationFenceConflictError ||
          error instanceof LocalSecretVersionConflictError ||
          error instanceof LocalSecretMutationConflictError
        ) {
          throw error;
        }
        if (error instanceof RunRepositoryError) throw error;
        throw mapSqliteError(error);
      }
    });
  }

  appendLocalSecretEnvelope(
    command: AppendLocalSecretEnvelopeCommand,
  ): Promise<AppendLocalSecretEnvelopeResult> {
    assertLocalSecretExpectedVersion(command.expectedCurrentVersion);
    const envelope = normalizeLocalSecretEnvelope(command.envelope);
    if (envelope.version !== command.expectedCurrentVersion + 1) {
      return Promise.reject(new LocalSecretVersionConflictError());
    }
    return this.enqueue(async () => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const replay = singleRow(
          queryRows(
            this.client,
            `SELECT ${LOCAL_SECRET_SELECT}
             FROM "QingLong3LocalSecretEnvelopes"
             WHERE "project_id" = ? AND "secret_name" = ?
               AND "mutation_id" = ?
             LIMIT 2`,
            [envelope.projectId, envelope.name, envelope.mutationId],
          ),
        );
        if (replay) {
          const existing = localSecretEnvelopeFromRow(replay);
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            envelope: existing,
          });
        }
        const current = this.client
          .prepare(
            `SELECT MAX("version") AS "version"
             FROM "QingLong3LocalSecretEnvelopes"
             WHERE "project_id" = ? AND "secret_name" = ?`,
          )
          .get(envelope.projectId, envelope.name) as QueryRow | undefined;
        const currentVersion =
          current?.version === null || current?.version === undefined
            ? 0
            : requiredInteger(current, 'version');
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new LocalSecretVersionConflictError();
        }
        const nonce = Buffer.from(envelope.nonce, 'base64url');
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
        const authTag = Buffer.from(envelope.authTag, 'base64url');
        try {
          this.client
            .prepare(
              `INSERT INTO "QingLong3LocalSecretEnvelopes" (
                 "project_id", "secret_name", "version", "mutation_id",
                 "key_id", "algorithm", "nonce", "ciphertext", "auth_tag",
                 "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              envelope.projectId,
              envelope.name,
              envelope.version,
              envelope.mutationId,
              envelope.keyId,
              envelope.algorithm,
              nonce,
              ciphertext,
              authTag,
              envelope.createdAtMs,
            );
        } finally {
          nonce.fill(0);
          ciphertext.fill(0);
          authTag.fill(0);
        }
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'inserted' as const,
          envelope,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; close discards a broken handle.
          }
        }
        if (error instanceof LocalSecretVersionConflictError) throw error;
        if (error instanceof RunRepositoryError) throw error;
        throw mapSqliteError(error);
      }
    });
  }

  findLocalSecretEnvelopeByMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<LocalSecretEnvelope | null> {
    assertLocalSecretProjectId(projectId);
    assertLocalSecretName(name);
    assertLocalSecretMutationId(mutationId);
    return this.enqueue(async () => {
      const row = singleRow(
        queryRows(
          this.client,
          `SELECT ${LOCAL_SECRET_SELECT}
           FROM "QingLong3LocalSecretEnvelopes"
           WHERE "project_id" = ? AND "secret_name" = ?
             AND "mutation_id" = ?
           LIMIT 2`,
          [projectId, name, mutationId],
        ),
      );
      return row ? localSecretEnvelopeFromRow(row) : null;
    });
  }

  resolveLocalSecretEnvelopes(
    references: readonly LocalSecretReference[],
  ): Promise<readonly (LocalSecretEnvelope | null)[]> {
    if (
      !Array.isArray(references) ||
      references.length > MAX_LOCAL_SECRET_BATCH_SIZE
    ) {
      return Promise.reject(new RangeError('Local Secret batch is too large'));
    }
    const normalized = references.map((reference) => {
      createLocalSecretRef(reference);
      return Object.freeze({ ...reference });
    });
    if (normalized.length === 0) return Promise.resolve(Object.freeze([]));
    return this.enqueue(async () => {
      const values: (string | number | null)[] = [];
      const requested = normalized.map((reference, position) => {
        values.push(
          position,
          reference.projectId,
          reference.name,
          reference.version ?? null,
        );
        return '(?, ?, ?, ?)';
      });
      const rows = queryRows(
        this.client,
        `WITH requested(position, project_id, secret_name, requested_version) AS (
           VALUES ${requested.join(', ')}
         )
         SELECT requested.position AS "position",
                envelope."project_id" AS "projectId",
                envelope."secret_name" AS "name",
                envelope."version" AS "version",
                envelope."mutation_id" AS "mutationId",
                envelope."key_id" AS "keyId",
                envelope."algorithm" AS "algorithm",
                envelope."nonce" AS "nonce",
                envelope."ciphertext" AS "ciphertext",
                envelope."auth_tag" AS "authTag",
                envelope."created_at_ms" AS "createdAtMs"
         FROM requested
         LEFT JOIN "QingLong3LocalSecretEnvelopes" AS envelope
           ON envelope."project_id" = requested.project_id
          AND envelope."secret_name" = requested.secret_name
          AND envelope."version" = COALESCE(
            requested.requested_version,
            (SELECT MAX(current."version")
             FROM "QingLong3LocalSecretEnvelopes" AS current
             WHERE current."project_id" = requested.project_id
               AND current."secret_name" = requested.secret_name)
          )
         ORDER BY requested.position`,
        values,
      );
      if (rows.length !== normalized.length) {
        throw new RunRepositoryConstraintError(
          'Local SQLite Secret batch result is incomplete',
        );
      }
      return Object.freeze(
        rows.map((row, position) => {
          if (requiredInteger(row, 'position') !== position) {
            throw new RunRepositoryConstraintError(
              'Local SQLite Secret batch order is invalid',
            );
          }
          return row.version === null ? null : localSecretEnvelopeFromRow(row);
        }),
      );
    });
  }
}
