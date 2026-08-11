// PostgreSQL runtime authority for resolving API credentials and identities.
import {
  ApiCredentialUnavailableError,
  assertApiCredentialId,
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import type { PostgresPool } from '@qinglong/runtime-core';

interface ApiCredentialRow extends Record<string, unknown> {
  credentialId: unknown;
  version: unknown;
  state: unknown;
  subjectType: unknown;
  subjectId: unknown;
  subjectStatus: unknown;
  pepperKeyId: unknown;
  secretDigest: unknown;
  createdAtMs: unknown;
  notBeforeAtMs: unknown;
  expiresAtMs: unknown;
}

const RESOLVE_SQL = `
SELECT
  credential.credential_id AS "credentialId",
  credential.version,
  credential.state,
  credential.subject_type AS "subjectType",
  credential.subject_id AS "subjectId",
  subject.status AS "subjectStatus",
  credential.pepper_key_id AS "pepperKeyId",
  credential.secret_digest AS "secretDigest",
  credential.created_at_ms AS "createdAtMs",
  credential.not_before_at_ms AS "notBeforeAtMs",
  credential.expires_at_ms AS "expiresAtMs"
FROM "ql3"."api_credentials" AS credential
JOIN "ql3"."identity_subjects" AS subject
  ON subject.subject_type = credential.subject_type
 AND subject.subject_id = credential.subject_id
WHERE credential.credential_id = $1
ORDER BY credential.version DESC
LIMIT 1
`.trim();

function requiredString(row: ApiCredentialRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiCredentialUnavailableError();
  }
  return value;
}

function requiredInteger(row: ApiCredentialRow, name: string): number {
  const value = row[name];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new ApiCredentialUnavailableError();
}

function recordFromRow(row: ApiCredentialRow): Readonly<ApiCredentialRecord> {
  try {
    return normalizeApiCredentialRecord({
      credentialId: requiredString(row, 'credentialId'),
      version: requiredInteger(row, 'version'),
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
      createdAtMs: requiredInteger(row, 'createdAtMs'),
      notBeforeAtMs: requiredInteger(row, 'notBeforeAtMs'),
      expiresAtMs: requiredInteger(row, 'expiresAtMs'),
    });
  } catch {
    throw new ApiCredentialUnavailableError();
  }
}

export class PostgresApiCredentialRepository
  implements ApiCredentialRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL API credential pool is invalid');
    }
  }

  async resolve(
    credentialId: string,
  ): Promise<Readonly<ApiCredentialRecord> | null> {
    assertApiCredentialId(credentialId);
    try {
      const result = await this.pool.query<ApiCredentialRow>(RESOLVE_SQL, [
        credentialId,
      ]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new ApiCredentialUnavailableError();
      return recordFromRow(result.rows[0]!);
    } catch (error) {
      if (error instanceof ApiCredentialUnavailableError) throw error;
      throw new ApiCredentialUnavailableError();
    }
  }
}
