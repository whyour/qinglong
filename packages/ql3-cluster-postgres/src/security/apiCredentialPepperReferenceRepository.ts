import {
  ApiCredentialPepperReferenceUnavailableError,
  normalizeApiCredentialPepperReferenceKeyId,
  normalizeApiCredentialPepperReferenceLimit,
  type ApiCredentialPepperReferenceInspection,
  type ApiCredentialPepperReferenceRepository,
} from '@qinglong/runtime-core/api-credential-pepper-reference';
import type { PostgresPool } from '@qinglong/runtime-core';
import { assertApiCredentialId } from '@qinglong/runtime-core/api-credential';

interface ReferenceRow extends Record<string, unknown> {
  observedAtMs: unknown;
  credentialId: unknown;
}

const INSPECT_SQL = `
WITH clock AS (
  SELECT floor(
    extract(epoch FROM statement_timestamp()) * 1000
  )::bigint AS observed_at_ms
), current_references AS (
  SELECT credential.credential_id
  FROM "ql3"."api_credentials" AS credential
  CROSS JOIN clock
  WHERE credential.pepper_key_id = $1
    AND credential.state = 'active'
    AND credential.expires_at_ms > clock.observed_at_ms
    AND NOT EXISTS (
      SELECT 1
      FROM "ql3"."api_credentials" AS newer
      WHERE newer.credential_id = credential.credential_id
        AND newer.version > credential.version
    )
  ORDER BY credential.credential_id
  LIMIT $2
)
SELECT
  clock.observed_at_ms AS "observedAtMs",
  reference.credential_id AS "credentialId"
FROM clock
LEFT JOIN current_references AS reference ON true
ORDER BY reference.credential_id
`.trim();

function safeInteger(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new ApiCredentialPepperReferenceUnavailableError();
  }
  return parsed as number;
}

export class PostgresApiCredentialPepperReferenceRepository
  implements ApiCredentialPepperReferenceRepository
{
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL API credential pepper reference pool is invalid',
      );
    }
  }

  async inspect(
    requestedPepperKeyId: string,
    requestedLimit?: number,
  ): Promise<Readonly<ApiCredentialPepperReferenceInspection>> {
    const pepperKeyId = normalizeApiCredentialPepperReferenceKeyId(
      requestedPepperKeyId,
    );
    const limit = normalizeApiCredentialPepperReferenceLimit(requestedLimit);
    try {
      const result = await this.pool.query<ReferenceRow>(INSPECT_SQL, [
        pepperKeyId,
        limit + 1,
      ]);
      if (result.rows.length < 1) {
        throw new ApiCredentialPepperReferenceUnavailableError();
      }
      const observedAtMs = safeInteger(result.rows[0]!.observedAtMs);
      const emptyReferenceSet =
        result.rows.length === 1 && result.rows[0]!.credentialId === null;
      const allCredentialIds = emptyReferenceSet
        ? []
        : result.rows.map((row) => {
            if (typeof row.credentialId !== 'string') {
              throw new ApiCredentialPepperReferenceUnavailableError();
            }
            try {
              assertApiCredentialId(row.credentialId);
            } catch {
              throw new ApiCredentialPepperReferenceUnavailableError();
            }
            return row.credentialId;
          });
      const credentialIds = allCredentialIds.slice(0, limit);
      if (
        result.rows.some(
          (row) => safeInteger(row.observedAtMs) !== observedAtMs,
        ) ||
        new Set(credentialIds).size !== credentialIds.length
      ) {
        throw new ApiCredentialPepperReferenceUnavailableError();
      }
      return Object.freeze({
        pepperKeyId,
        observedAtMs,
        credentialIds: Object.freeze(credentialIds),
        hasMore: allCredentialIds.length > limit,
      });
    } catch (error) {
      if (error instanceof ApiCredentialPepperReferenceUnavailableError) {
        throw error;
      }
      throw new ApiCredentialPepperReferenceUnavailableError();
    }
  }
}
