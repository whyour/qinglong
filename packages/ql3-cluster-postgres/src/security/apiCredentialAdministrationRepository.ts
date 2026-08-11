// PostgreSQL administration authority for versioned API credential mutations.
import {
  ApiCredentialAdministrationMutationConflictError,
  ApiCredentialAdministrationSubjectNotFoundError,
  ApiCredentialAdministrationUnavailableError,
  ApiCredentialAdministrationVersionConflictError,
  normalizeAppendApiCredentialCommand,
  normalizeApiCredentialAdministrationMutationId,
  type ApiCredentialAdministrationRepository,
  type ApiCredentialMutationRecord,
  type AppendApiCredentialCommand,
  type AppendApiCredentialResult,
  type ResolvedApiCredentialMutation,
} from '@qinglong/runtime-core/api-credential-administration';
import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '@qinglong/runtime-core/api-credential';
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

interface CredentialMutationRow extends AdministrationAuditRow {
  mutationId: unknown;
  operation: unknown;
  credentialId: unknown;
  credentialVersion: unknown;
  expectedPreviousVersion: unknown;
  state: unknown;
  subjectType: unknown;
  subjectId: unknown;
  subjectStatus: unknown;
  pepperKeyId: unknown;
  secretDigest: unknown;
  createdAtMs: unknown;
  notBeforeAtMs: unknown;
  expiresAtMs: unknown;
  changedByType: unknown;
  changedById: unknown;
}

interface CurrentCredentialRow extends Record<string, unknown> {
  credentialId: unknown;
  version: unknown;
  state: unknown;
  subjectType: unknown;
  subjectId: unknown;
}

interface SubjectRow extends Record<string, unknown> {
  status: unknown;
}

const MAX_TRANSACTION_ATTEMPTS = 3;
const MUTATION_SELECT = `
SELECT
  mutation.mutation_id AS "mutationId",
  mutation.operation,
  mutation.credential_id AS "credentialId",
  mutation.credential_version AS "credentialVersion",
  mutation.expected_previous_version AS "expectedPreviousVersion",
  mutation.state,
  mutation.subject_type AS "subjectType",
  mutation.subject_id AS "subjectId",
  mutation.subject_status AS "subjectStatus",
  mutation.changed_by_type AS "changedByType",
  mutation.changed_by_id AS "changedById",
  mutation.created_at_ms AS "createdAtMs",
  credential.pepper_key_id AS "pepperKeyId",
  credential.secret_digest AS "secretDigest",
  credential.not_before_at_ms AS "notBeforeAtMs",
  credential.expires_at_ms AS "expiresAtMs",
  ${ADMINISTRATION_AUDIT_SELECT}
FROM "ql3"."api_credential_mutations" AS mutation
JOIN "ql3"."api_credentials" AS credential
  ON credential.credential_id = mutation.credential_id
 AND credential.version = mutation.credential_version
JOIN "ql3"."security_audit_events" AS audit
  ON audit.event_id = mutation.audit_event_id
WHERE mutation.mutation_id = $1
LIMIT 2
`.trim();

function storedMutation(row: CredentialMutationRow): {
  credential: Readonly<ApiCredentialRecord>;
  mutation: Readonly<ApiCredentialMutationRecord>;
  audit: ReturnType<typeof auditFromRow>;
} {
  const audit = auditFromRow(row);
  const mutation: ApiCredentialMutationRecord = {
    mutationId: requiredString(row, 'mutationId'),
    operation: requiredString(
      row,
      'operation',
    ) as ApiCredentialMutationRecord['operation'],
    credentialId: requiredString(row, 'credentialId'),
    credentialVersion: requiredInteger(row, 'credentialVersion'),
    expectedPreviousVersion: requiredInteger(row, 'expectedPreviousVersion'),
    changedBy: {
      type: requiredString(
        row,
        'changedByType',
      ) as ApiCredentialMutationRecord['changedBy']['type'],
      id: requiredString(row, 'changedById'),
    },
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  const credential = normalizeApiCredentialRecord({
    credentialId: mutation.credentialId,
    version: mutation.credentialVersion,
    pepperKeyId: requiredString(row, 'pepperKeyId'),
    state: requiredString(row, 'state') as ApiCredentialRecord['state'],
    subject: {
      type: requiredString(
        row,
        'subjectType',
      ) as ApiCredentialRecord['subject']['type'],
      id: requiredString(row, 'subjectId'),
    },
    subjectStatus: requiredString(
      row,
      'subjectStatus',
    ) as ApiCredentialRecord['subjectStatus'],
    secretDigest: requiredString(row, 'secretDigest'),
    createdAtMs: mutation.createdAtMs,
    notBeforeAtMs: requiredInteger(row, 'notBeforeAtMs'),
    expiresAtMs: requiredInteger(row, 'expiresAtMs'),
  });
  const normalized = normalizeAppendApiCredentialCommand({
    expectedCurrentVersion: mutation.expectedPreviousVersion,
    credential,
    mutation,
    audit,
  });
  return {
    credential: normalized.credential,
    mutation: normalized.mutation,
    audit: normalized.audit,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCredentialForReplay(
  left: Readonly<ApiCredentialRecord>,
  right: Readonly<ApiCredentialRecord>,
): boolean {
  const {
    secretDigest: _leftSecretDigest,
    createdAtMs: _leftCreatedAtMs,
    ...leftSemantic
  } = left;
  const {
    secretDigest: _rightSecretDigest,
    createdAtMs: _rightCreatedAtMs,
    ...rightSemantic
  } = right;
  return sameValue(leftSemantic, rightSemantic);
}

function sameMutationForReplay(
  left: Readonly<ApiCredentialMutationRecord>,
  right: Readonly<ApiCredentialMutationRecord>,
): boolean {
  const { createdAtMs: _leftCreatedAtMs, ...leftSemantic } = left;
  const { createdAtMs: _rightCreatedAtMs, ...rightSemantic } = right;
  return sameValue(leftSemantic, rightSemantic);
}

async function resolveStoredMutation(
  queryable: Pick<PostgresClient, 'query'>,
  mutationId: string,
): Promise<ResolvedApiCredentialMutation | null> {
  const result = await queryable.query<CredentialMutationRow>(MUTATION_SELECT, [
    mutationId,
  ]);
  if (result.rows.length > 1) {
    throw new ApiCredentialAdministrationUnavailableError();
  }
  if (!result.rows[0]) return null;
  try {
    return Object.freeze(storedMutation(result.rows[0]));
  } catch {
    throw new ApiCredentialAdministrationMutationConflictError();
  }
}

async function replay(
  client: PostgresClient,
  command: Readonly<AppendApiCredentialCommand>,
): Promise<AppendApiCredentialResult | null> {
  const stored = await resolveStoredMutation(
    client,
    command.mutation.mutationId,
  );
  if (!stored) return null;
  if (
    !sameCredentialForReplay(stored.credential, command.credential) ||
    !sameMutationForReplay(stored.mutation, command.mutation) ||
    !sameAdministrationReplayAudit(stored.audit, command.audit)
  ) {
    throw new ApiCredentialAdministrationMutationConflictError();
  }
  return Object.freeze({
    status: 'existing',
    credential: stored.credential,
    mutation: stored.mutation,
  });
}

export class PostgresApiCredentialAdministrationRepository
  implements ApiCredentialAdministrationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL API credential administration pool is invalid',
      );
    }
  }

  async resolveMutation(
    requestedMutationId: string,
  ): Promise<ResolvedApiCredentialMutation | null> {
    const mutationId =
      normalizeApiCredentialAdministrationMutationId(requestedMutationId);
    try {
      return await resolveStoredMutation(this.pool, mutationId);
    } catch (error) {
      if (
        error instanceof ApiCredentialAdministrationMutationConflictError ||
        error instanceof ApiCredentialAdministrationUnavailableError
      ) {
        throw error;
      }
      throw new ApiCredentialAdministrationUnavailableError();
    }
  }

  async append(
    input: AppendApiCredentialCommand,
  ): Promise<AppendApiCredentialResult> {
    const command = normalizeAppendApiCredentialCommand(input);
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw new ApiCredentialAdministrationUnavailableError();
      }
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-api-credential:${command.credential.credentialId}`],
        );
        const existing = await replay(client, command);
        if (existing) {
          await client.query('COMMIT');
          began = false;
          return existing;
        }

        const subjectResult = await client.query<SubjectRow>(
          `SELECT status
           FROM "ql3"."identity_subjects"
           WHERE subject_type = $1 AND subject_id = $2
           FOR SHARE`,
          [command.credential.subject.type, command.credential.subject.id],
        );
        if (subjectResult.rows.length !== 1) {
          throw new ApiCredentialAdministrationSubjectNotFoundError();
        }
        const subjectStatus = requiredString(subjectResult.rows[0]!, 'status');
        if (
          subjectStatus !== command.credential.subjectStatus ||
          (command.mutation.operation !== 'revoke' &&
            subjectStatus !== 'active')
        ) {
          throw new ApiCredentialAdministrationSubjectNotFoundError();
        }

        const currentResult = await client.query<CurrentCredentialRow>(
          `SELECT
             credential_id AS "credentialId", version, state,
             subject_type AS "subjectType", subject_id AS "subjectId"
           FROM "ql3"."api_credentials"
           WHERE credential_id = $1
           ORDER BY version DESC
           LIMIT 1`,
          [command.credential.credentialId],
        );
        if (currentResult.rows.length > 1) {
          throw new ApiCredentialAdministrationUnavailableError();
        }
        const current = currentResult.rows[0];
        const currentVersion = current
          ? requiredInteger(current, 'version')
          : 0;
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new ApiCredentialAdministrationVersionConflictError();
        }
        if (
          current &&
          (requiredString(current, 'subjectType') !==
            command.credential.subject.type ||
            requiredString(current, 'subjectId') !==
              command.credential.subject.id)
        ) {
          throw new ApiCredentialAdministrationMutationConflictError();
        }

        await insertAdministrationAudit(client, command.audit);
        await client.query(
          `INSERT INTO "ql3"."api_credentials" (
             credential_id, version, state, subject_type, subject_id,
             pepper_key_id, secret_digest, created_at_ms, not_before_at_ms,
             expires_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            command.credential.credentialId,
            command.credential.version,
            command.credential.state,
            command.credential.subject.type,
            command.credential.subject.id,
            command.credential.pepperKeyId,
            command.credential.secretDigest,
            command.credential.createdAtMs,
            command.credential.notBeforeAtMs,
            command.credential.expiresAtMs,
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."api_credential_mutations" (
             mutation_id, operation, credential_id, credential_version,
             expected_previous_version, state, subject_type, subject_id,
             subject_status, changed_by_type, changed_by_id, audit_event_id,
             created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1, $12)`,
          [
            command.mutation.mutationId,
            command.mutation.operation,
            command.mutation.credentialId,
            command.mutation.credentialVersion,
            command.mutation.expectedPreviousVersion,
            command.credential.state,
            command.credential.subject.type,
            command.credential.subject.id,
            command.credential.subjectStatus,
            command.mutation.changedBy.type,
            command.mutation.changedBy.id,
            command.mutation.createdAtMs,
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'inserted',
          credential: command.credential,
          mutation: command.mutation,
        });
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof ApiCredentialAdministrationSubjectNotFoundError ||
          error instanceof ApiCredentialAdministrationVersionConflictError ||
          error instanceof ApiCredentialAdministrationMutationConflictError ||
          error instanceof ApiCredentialAdministrationUnavailableError
        ) {
          throw error;
        }
        if (
          attempt < MAX_TRANSACTION_ATTEMPTS - 1 &&
          retryableAdministrationError(error)
        ) {
          continue;
        }
        throw new ApiCredentialAdministrationUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new ApiCredentialAdministrationUnavailableError();
  }
}
