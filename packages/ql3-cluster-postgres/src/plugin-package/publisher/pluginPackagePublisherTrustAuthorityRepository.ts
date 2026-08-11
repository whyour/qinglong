// PostgreSQL Plugin Package publisher trust observation authority.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  PluginPackagePublisherTrustAuthorityConflictError,
  PluginPackagePublisherTrustAuthorityUnavailableError,
  createPluginPackagePublisherTrustHead,
  normalizePluginPackagePublisherTrustHead,
  normalizePluginPackagePublisherTrustSnapshot,
  type ObservePluginPackagePublisherTrustSnapshotInput,
  type ObservePluginPackagePublisherTrustSnapshotResult,
  type PluginPackagePublisherTrustAuthorityRepository,
  type PluginPackagePublisherTrustAuthorityState,
  type PluginPackagePublisherTrustHead,
  type PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const AUTHORITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function unavailable(
  cause?: unknown,
): PluginPackagePublisherTrustAuthorityUnavailableError {
  return new PluginPackagePublisherTrustAuthorityUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function authorityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !AUTHORITY_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('publisher trust observation time is invalid');
  }
  return value as number;
}

function mappedError(error: unknown): Error {
  if (
    error instanceof PluginPackagePublisherTrustAuthorityConflictError ||
    error instanceof PluginPackagePublisherTrustAuthorityUnavailableError ||
    error instanceof TypeError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackagePublisherTrustAuthorityConflictError();
  }
  return unavailable(error);
}

function parseHead(row: Row): Readonly<PluginPackagePublisherTrustHead> {
  try {
    const head = normalizePluginPackagePublisherTrustHead(
      postgresRequiredJsonObject(
        row.headJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustHead,
    );
    if (
      head.headDigest !==
      postgresRequiredString(row.headDigest, unavailable)
    ) {
      throw unavailable();
    }
    return head;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustAuthorityUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseSnapshot(
  row: Row,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  try {
    const snapshot = normalizePluginPackagePublisherTrustSnapshot(
      postgresRequiredJsonObject(
        row.snapshotJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustSnapshot,
    );
    if (
      snapshot.snapshotDigest !==
      postgresRequiredString(row.snapshotDigest, unavailable)
    ) {
      throw unavailable();
    }
    return snapshot;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustAuthorityUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

async function authorityById(
  queryable: Queryable,
  value: string,
  forUpdate = false,
): Promise<Readonly<PluginPackagePublisherTrustAuthorityState> | null> {
  const result = await queryable.query<Row>(
    `SELECT head.head_json AS "headJson",
            head.head_digest AS "headDigest",
            snapshot.snapshot_json AS "snapshotJson",
            snapshot.snapshot_digest AS "snapshotDigest"
     FROM "ql3"."plugin_package_publisher_trust_heads" AS head
     JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS snapshot
       ON snapshot.snapshot_digest = head.effective_trust_digest
     WHERE head.authority_id = $1
     LIMIT 2${forUpdate ? ' FOR UPDATE OF head' : ''}`,
    [value],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return Object.freeze({
    head: parseHead(result.rows[0]!),
    effectiveSnapshot: parseSnapshot(result.rows[0]!),
  });
}

export class PostgresPluginPackagePublisherTrustAuthorityRepository
  implements PluginPackagePublisherTrustAuthorityRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL publisher trust pool is invalid');
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mappedError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findAuthority(
    authorityIdValue: string,
  ): Promise<Readonly<PluginPackagePublisherTrustAuthorityState> | null> {
    const id = authorityId(authorityIdValue, 'publisher trust authorityId');
    try {
      return await authorityById(this.pool, id);
    } catch (error) {
      throw mappedError(error);
    }
  }

  observeSnapshot(
    input: ObservePluginPackagePublisherTrustSnapshotInput,
  ): Promise<Readonly<ObservePluginPackagePublisherTrustSnapshotResult>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return Promise.reject(
        new TypeError('publisher trust observation is invalid'),
      );
    }
    const id = authorityId(input.authorityId, 'publisher trust authorityId');
    const observedBy = authorityId(
      input.observedBy,
      'publisher trust observer',
    );
    const observedAtMs = timestamp(input.observedAtMs);
    const snapshot = normalizePluginPackagePublisherTrustSnapshot(
      input.snapshot,
    );
    if (snapshot.keys.length < 1) {
      return Promise.reject(
        new TypeError('publisher base trust snapshot must contain one key'),
      );
    }
    const initialHead = createPluginPackagePublisherTrustHead(
      id,
      snapshot,
      observedAtMs,
    );
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_trust_snapshots" (
           snapshot_digest, key_count, observed_by, observed_at_ms,
           snapshot_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (snapshot_digest) DO NOTHING`,
        [
          snapshot.snapshotDigest,
          snapshot.keys.length,
          observedBy,
          observedAtMs,
          JSON.stringify(snapshot),
        ],
      );
      const inserted = await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_trust_heads" (
           authority_id, generation, base_snapshot_digest,
           effective_trust_digest, updated_at_ms, head_digest, head_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (authority_id) DO NOTHING`,
        [
          initialHead.authorityId,
          initialHead.generation,
          initialHead.baseSnapshotDigest,
          initialHead.effectiveTrustDigest,
          initialHead.updatedAtMs,
          initialHead.headDigest,
          JSON.stringify(initialHead),
        ],
      );
      if (inserted.rowCount === 1) {
        return Object.freeze({
          status: 'created' as const,
          head: initialHead,
          effectiveSnapshot: snapshot,
        });
      }
      if (inserted.rowCount !== 0) throw unavailable();
      const existing = await authorityById(client, id);
      if (!existing) {
        throw new PluginPackagePublisherTrustAuthorityConflictError();
      }
      return Object.freeze({
        status:
          existing.head.baseSnapshotDigest === snapshot.snapshotDigest
            ? ('existing' as const)
            : ('candidate' as const),
        ...existing,
      });
    });
  }
}
