import {
  ApiCredentialUnavailableError,
  assertApiCredentialId,
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import type { DatabaseSync } from 'node:sqlite';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type CredentialRow = Record<string, unknown>;

function text(row: CredentialRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new ApiCredentialUnavailableError();
  return value;
}

function integer(row: CredentialRow, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value)) {
    throw new ApiCredentialUnavailableError();
  }
  return value as number;
}

function record(row: CredentialRow): Readonly<ApiCredentialRecord> {
  try {
    return normalizeApiCredentialRecord({
      credentialId: text(row, 'credentialId'),
      version: integer(row, 'version'),
      pepperKeyId: text(row, 'pepperKeyId'),
      state: text(row, 'state') as ApiCredentialRecord['state'],
      subject: {
        type: text(
          row,
          'subjectType',
        ) as ApiCredentialRecord['subject']['type'],
        id: text(row, 'subjectId'),
      },
      subjectStatus: text(
        row,
        'subjectStatus',
      ) as ApiCredentialRecord['subjectStatus'],
      secretDigest: text(row, 'secretDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      notBeforeAtMs: integer(row, 'notBeforeAtMs'),
      expiresAtMs: integer(row, 'expiresAtMs'),
    });
  } catch (error) {
    if (error instanceof ApiCredentialUnavailableError) throw error;
    throw new ApiCredentialUnavailableError();
  }
}

export class LocalSqliteApiCredentialRepository
  implements ApiCredentialRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  resolve(credentialId: string): Promise<Readonly<ApiCredentialRecord> | null> {
    assertApiCredentialId(credentialId);
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(
              `SELECT
                 credential."credential_id" AS "credentialId",
                 credential."version" AS "version",
                 pepper."pepper_key_id" AS "pepperKeyId",
                 credential."state" AS "state",
                 credential."subject_type" AS "subjectType",
                 credential."subject_id" AS "subjectId",
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
            .get(credentialId) as CredentialRow | undefined;
          return row ? record(row) : null;
        } catch (error) {
          if (error instanceof ApiCredentialUnavailableError) throw error;
          throw new ApiCredentialUnavailableError();
        }
      },
      () => new ApiCredentialUnavailableError(),
    );
  }
}
