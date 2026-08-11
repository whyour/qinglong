// Runtime Worker Credential resolution persistence is owned by this domain.
import {
  WorkerCredentialUnavailableError,
  normalizeWorkerCredentialId,
  normalizeWorkerCredentialRecord,
  type WorkerCredentialRecord,
  type WorkerCredentialRepository,
} from '@qinglong/runtime-core/worker-credential';
import type { PostgresPool } from '@qinglong/runtime-core';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Worker credential ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL Worker credential ${key} is invalid`);
  }
  return value;
}

export class PostgresWorkerCredentialRepository
  implements WorkerCredentialRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async resolve(requestedCredentialId: string): Promise<WorkerCredentialRecord | null> {
    const credentialId = normalizeWorkerCredentialId(requestedCredentialId);
    try {
      const result = await this.pool.query<Row>(
        `
          SELECT credential_id AS "credentialId", version, state,
                 worker_id AS "workerId", secret_digest AS "secretDigest",
                 created_at_ms AS "createdAtMs",
                 not_before_at_ms AS "notBeforeAtMs",
                 expires_at_ms AS "expiresAtMs"
          FROM "ql3"."worker_credentials"
          WHERE credential_id = $1
          ORDER BY version DESC
          LIMIT 2
        `,
        [credentialId],
      );
      if (result.rows.length > 1) {
        const first = integer(result.rows[0]!, 'version');
        const second = integer(result.rows[1]!, 'version');
        if (first <= second) throw new TypeError('Worker credential order is invalid');
      }
      const row = result.rows[0];
      if (!row) return null;
      return normalizeWorkerCredentialRecord({
        credentialId: text(row, 'credentialId'),
        version: integer(row, 'version'),
        state: text(row, 'state') as WorkerCredentialRecord['state'],
        workerId: text(row, 'workerId'),
        secretDigest: text(row, 'secretDigest'),
        createdAtMs: integer(row, 'createdAtMs'),
        notBeforeAtMs: integer(row, 'notBeforeAtMs'),
        expiresAtMs: integer(row, 'expiresAtMs'),
      });
    } catch (error) {
      if (error instanceof WorkerCredentialUnavailableError) throw error;
      throw new WorkerCredentialUnavailableError();
    }
  }
}
