// PostgreSQL administration authority for versioned identity mutations.
import {
  IdentityAdministrationMutationConflictError,
  IdentityAdministrationUnavailableError,
  IdentityAdministrationVersionConflictError,
  normalizeAppendIdentitySubjectCommand,
  normalizeIdentityAdministrationMutationId,
  normalizeIdentityAdministrationSubject,
  normalizeIdentitySubjectRecord,
  type AppendIdentitySubjectCommand,
  type AppendIdentitySubjectResult,
  type IdentityAdministrationRepository,
  type IdentitySubjectMutationRecord,
  type IdentitySubjectRecord,
  type ResolvedIdentitySubjectMutation,
} from '@qinglong/runtime-core/identity-administration';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  ADMINISTRATION_AUDIT_SELECT,
  auditFromRow,
  configureAdministrationTransaction,
  insertAdministrationAudit,
  requiredInteger,
  requiredString,
  retryableAdministrationError,
  rollbackAdministrationTransaction,
  sameAdministrationReplayAudit,
  type AdministrationAuditRow,
} from '../repository/administrationSupport';

interface IdentityMutationRow extends AdministrationAuditRow {
  mutationId: unknown;
  operation: unknown;
  subjectType: unknown;
  subjectId: unknown;
  subjectVersion: unknown;
  expectedPreviousVersion: unknown;
  status: unknown;
  changedByType: unknown;
  changedById: unknown;
  identityCreatedAtMs: unknown;
  createdAtMs: unknown;
}

interface IdentityRow extends Record<string, unknown> {
  subjectType: unknown;
  subjectId: unknown;
  status: unknown;
  version: unknown;
  createdAtMs: unknown;
  updatedAtMs: unknown;
}

const MAX_TRANSACTION_ATTEMPTS = 3;
const MUTATION_SELECT = `
SELECT
  mutation.mutation_id AS "mutationId",
  mutation.operation,
  mutation.subject_type AS "subjectType",
  mutation.subject_id AS "subjectId",
  mutation.subject_version AS "subjectVersion",
  mutation.expected_previous_version AS "expectedPreviousVersion",
  mutation.status,
  mutation.changed_by_type AS "changedByType",
  mutation.changed_by_id AS "changedById",
  mutation.identity_created_at_ms AS "identityCreatedAtMs",
  mutation.created_at_ms AS "createdAtMs",
  ${ADMINISTRATION_AUDIT_SELECT}
FROM "ql3"."identity_subject_mutations" AS mutation
JOIN "ql3"."security_audit_events" AS audit
  ON audit.event_id = mutation.audit_event_id
WHERE mutation.mutation_id = $1
LIMIT 2
`.trim();

function identityFromRow(row: IdentityRow): Readonly<IdentitySubjectRecord> {
  return normalizeIdentitySubjectRecord({
    subject: {
      type: requiredString(
        row,
        'subjectType',
      ) as IdentitySubjectRecord['subject']['type'],
      id: requiredString(row, 'subjectId'),
    },
    status: requiredString(row, 'status') as IdentitySubjectRecord['status'],
    version: requiredInteger(row, 'version'),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
    updatedAtMs: requiredInteger(row, 'updatedAtMs'),
  });
}

function storedMutation(row: IdentityMutationRow): {
  identity: Readonly<IdentitySubjectRecord>;
  mutation: Readonly<IdentitySubjectMutationRecord>;
  audit: ReturnType<typeof auditFromRow>;
} {
  const audit = auditFromRow(row);
  const mutation: IdentitySubjectMutationRecord = {
    mutationId: requiredString(row, 'mutationId'),
    operation: requiredString(
      row,
      'operation',
    ) as IdentitySubjectMutationRecord['operation'],
    subject: {
      type: requiredString(
        row,
        'subjectType',
      ) as IdentitySubjectMutationRecord['subject']['type'],
      id: requiredString(row, 'subjectId'),
    },
    subjectVersion: requiredInteger(row, 'subjectVersion'),
    expectedPreviousVersion: requiredInteger(row, 'expectedPreviousVersion'),
    status: requiredString(
      row,
      'status',
    ) as IdentitySubjectMutationRecord['status'],
    changedBy: {
      type: requiredString(
        row,
        'changedByType',
      ) as IdentitySubjectMutationRecord['changedBy']['type'],
      id: requiredString(row, 'changedById'),
    },
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  const normalized = normalizeAppendIdentitySubjectCommand({
    expectedCurrentVersion: mutation.expectedPreviousVersion,
    mutation,
    audit,
  });
  return {
    mutation: normalized.mutation,
    audit: normalized.audit,
    identity: normalizeIdentitySubjectRecord({
      subject: normalized.mutation.subject,
      status: normalized.mutation.status,
      version: normalized.mutation.subjectVersion,
      createdAtMs: requiredInteger(row, 'identityCreatedAtMs'),
      updatedAtMs: normalized.mutation.createdAtMs,
    }),
  };
}

function sameMutation(
  left: Readonly<IdentitySubjectMutationRecord>,
  right: Readonly<IdentitySubjectMutationRecord>,
): boolean {
  const { createdAtMs: _leftCreatedAtMs, ...leftSemantic } = left;
  const { createdAtMs: _rightCreatedAtMs, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

async function resolveStoredMutation(
  queryable: Pick<PostgresClient, 'query'>,
  mutationId: string,
): Promise<ResolvedIdentitySubjectMutation | null> {
  const result = await queryable.query<IdentityMutationRow>(MUTATION_SELECT, [
    mutationId,
  ]);
  if (result.rows.length > 1)
    throw new IdentityAdministrationUnavailableError();
  if (!result.rows[0]) return null;
  try {
    return Object.freeze(storedMutation(result.rows[0]));
  } catch {
    throw new IdentityAdministrationMutationConflictError();
  }
}

async function replay(
  client: PostgresClient,
  command: Readonly<AppendIdentitySubjectCommand>,
): Promise<AppendIdentitySubjectResult | null> {
  const stored = await resolveStoredMutation(
    client,
    command.mutation.mutationId,
  );
  if (!stored) return null;
  if (
    !sameMutation(stored.mutation, command.mutation) ||
    !sameAdministrationReplayAudit(stored.audit, command.audit)
  ) {
    throw new IdentityAdministrationMutationConflictError();
  }
  return Object.freeze({
    status: 'existing',
    identity: stored.identity,
    mutation: stored.mutation,
  });
}

export class PostgresIdentityAdministrationRepository
  implements IdentityAdministrationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Identity administration pool is invalid');
    }
  }

  async resolve(
    requestedSubject: Parameters<
      IdentityAdministrationRepository['resolve']
    >[0],
  ): Promise<Readonly<IdentitySubjectRecord> | null> {
    const subject = normalizeIdentityAdministrationSubject(requestedSubject);
    try {
      const result = await this.pool.query<IdentityRow>(
        `SELECT
           subject_type AS "subjectType", subject_id AS "subjectId", status,
           version, created_at_ms AS "createdAtMs",
           updated_at_ms AS "updatedAtMs"
         FROM "ql3"."identity_subjects"
         WHERE subject_type = $1 AND subject_id = $2
         LIMIT 2`,
        [subject.type, subject.id],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new IdentityAdministrationUnavailableError();
      }
      return identityFromRow(result.rows[0]!);
    } catch (error) {
      if (error instanceof IdentityAdministrationUnavailableError) throw error;
      throw new IdentityAdministrationUnavailableError();
    }
  }

  async resolveMutation(
    requestedMutationId: string,
  ): Promise<ResolvedIdentitySubjectMutation | null> {
    const mutationId =
      normalizeIdentityAdministrationMutationId(requestedMutationId);
    try {
      return await resolveStoredMutation(this.pool, mutationId);
    } catch (error) {
      if (
        error instanceof IdentityAdministrationMutationConflictError ||
        error instanceof IdentityAdministrationUnavailableError
      ) {
        throw error;
      }
      throw new IdentityAdministrationUnavailableError();
    }
  }

  async append(
    input: AppendIdentitySubjectCommand,
  ): Promise<AppendIdentitySubjectResult> {
    const command = normalizeAppendIdentitySubjectCommand(input);
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw new IdentityAdministrationUnavailableError();
      }
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            `ql3-identity:${command.mutation.subject.type}:${command.mutation.subject.id}`,
          ],
        );
        const existing = await replay(client, command);
        if (existing) {
          await client.query('COMMIT');
          began = false;
          return existing;
        }

        const currentResult = await client.query<IdentityRow>(
          `SELECT
             subject_type AS "subjectType", subject_id AS "subjectId", status,
             version, created_at_ms AS "createdAtMs",
             updated_at_ms AS "updatedAtMs"
           FROM "ql3"."identity_subjects"
           WHERE subject_type = $1 AND subject_id = $2
           FOR UPDATE`,
          [command.mutation.subject.type, command.mutation.subject.id],
        );
        if (currentResult.rows.length > 1) {
          throw new IdentityAdministrationUnavailableError();
        }
        const current = currentResult.rows[0]
          ? identityFromRow(currentResult.rows[0])
          : null;
        if ((current?.version ?? 0) !== command.expectedCurrentVersion) {
          throw new IdentityAdministrationVersionConflictError();
        }

        await insertAdministrationAudit(client, command.audit);
        let identity: Readonly<IdentitySubjectRecord>;
        if (current === null) {
          const inserted = await client.query<IdentityRow>(
            `INSERT INTO "ql3"."identity_subjects" (
               subject_type, subject_id, status, version, created_at_ms,
               updated_at_ms
             ) VALUES ($1, $2, $3, $4, $5, $5)
             RETURNING subject_type AS "subjectType", subject_id AS "subjectId",
               status, version, created_at_ms AS "createdAtMs",
               updated_at_ms AS "updatedAtMs"`,
            [
              command.mutation.subject.type,
              command.mutation.subject.id,
              command.mutation.status,
              command.mutation.subjectVersion,
              command.mutation.createdAtMs,
            ],
          );
          if (inserted.rows.length !== 1) {
            throw new IdentityAdministrationUnavailableError();
          }
          identity = identityFromRow(inserted.rows[0]!);
        } else {
          const updated = await client.query<IdentityRow>(
            `UPDATE "ql3"."identity_subjects"
             SET status = $3, version = $4, updated_at_ms = $5
             WHERE subject_type = $1 AND subject_id = $2 AND version = $6
             RETURNING subject_type AS "subjectType", subject_id AS "subjectId",
               status, version, created_at_ms AS "createdAtMs",
               updated_at_ms AS "updatedAtMs"`,
            [
              command.mutation.subject.type,
              command.mutation.subject.id,
              command.mutation.status,
              command.mutation.subjectVersion,
              command.mutation.createdAtMs,
              command.expectedCurrentVersion,
            ],
          );
          if (updated.rows.length !== 1) {
            throw new IdentityAdministrationVersionConflictError();
          }
          identity = identityFromRow(updated.rows[0]!);
        }
        await client.query(
          `INSERT INTO "ql3"."identity_subject_mutations" (
             mutation_id, operation, subject_type, subject_id,
             subject_version, expected_previous_version, status,
             changed_by_type, changed_by_id, audit_event_id,
             identity_created_at_ms, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, $10, $11)`,
          [
            command.mutation.mutationId,
            command.mutation.operation,
            command.mutation.subject.type,
            command.mutation.subject.id,
            command.mutation.subjectVersion,
            command.mutation.expectedPreviousVersion,
            command.mutation.status,
            command.mutation.changedBy.type,
            command.mutation.changedBy.id,
            identity.createdAtMs,
            command.mutation.createdAtMs,
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'inserted',
          identity,
          mutation: command.mutation,
        });
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof IdentityAdministrationVersionConflictError ||
          error instanceof IdentityAdministrationMutationConflictError ||
          error instanceof IdentityAdministrationUnavailableError
        ) {
          throw error;
        }
        if (
          attempt < MAX_TRANSACTION_ATTEMPTS - 1 &&
          retryableAdministrationError(error)
        ) {
          continue;
        }
        throw new IdentityAdministrationUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new IdentityAdministrationUnavailableError();
  }
}
