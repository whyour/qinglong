import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementCompletion,
  createPluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementCompletion,
  normalizePluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementRequest,
  type PluginPackagePromptOutputKeyRetirementCompletion,
  type PluginPackagePromptOutputKeyRetirementPreparation,
  type PluginPackagePromptOutputKeyRetirementRecord,
  type PluginPackagePromptOutputKeyRetirementRepository,
} from '../key-management/pluginPackagePromptOutputKeyRetirement';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const MAX_ATTEMPTS = 3;
const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const CONFLICT_SQL_STATES = new Set(['23503', '23505', '23514']);
const KEY_FENCE_LOCK_SEED = 0x514c0302;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRetirementUnavailableError {
  return new PluginPackagePromptOutputKeyRetirementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(cause: unknown): string | null {
  return cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
    ? cause.code
    : null;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const parsed =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw unavailable();
  }
  return parsed as number;
}

function json(row: Row, key: string): Record<string, unknown> {
  try {
    const value = row[key];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unavailable();
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parsePreparation(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRetirementPreparation> {
  try {
    const preparation =
      normalizePluginPackagePromptOutputKeyRetirementPreparation(
        json(
          row,
          'preparationJson',
        ) as unknown as PluginPackagePromptOutputKeyRetirementPreparation,
      );
    if (
      preparation.keyId !== text(row, 'keyId') ||
      preparation.retirementId !== text(row, 'retirementId') ||
      preparation.requestId !== text(row, 'requestId') ||
      preparation.mutationId !== text(row, 'mutationId') ||
      preparation.catalogDigest !== text(row, 'catalogDigest') ||
      preparation.materialProof !== text(row, 'materialProof') ||
      preparation.preparedAtMs !== integer(row, 'preparedAtMs') ||
      preparation.preparationDigest !== text(row, 'preparationDigest')
    ) {
      throw unavailable();
    }
    return preparation;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parseCompletion(
  row: Row,
): Readonly<PluginPackagePromptOutputKeyRetirementCompletion> {
  try {
    const completion =
      normalizePluginPackagePromptOutputKeyRetirementCompletion(
        json(
          row,
          'completionJson',
        ) as unknown as PluginPackagePromptOutputKeyRetirementCompletion,
      );
    if (
      completion.keyId !== text(row, 'keyId') ||
      completion.retirementId !== text(row, 'retirementId') ||
      completion.requestId !== text(row, 'requestId') ||
      completion.mutationId !== text(row, 'mutationId') ||
      completion.preparationDigest !== text(row, 'preparationDigest') ||
      completion.retiredCatalogDigest !== text(row, 'retiredCatalogDigest') ||
      completion.absenceProof !== text(row, 'absenceProof') ||
      completion.completedAtMs !== integer(row, 'completedAtMs') ||
      completion.completionDigest !== text(row, 'completionDigest')
    ) {
      throw unavailable();
    }
    return completion;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

async function readPreparation(
  queryable: Queryable,
  keyId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRetirementPreparation> | null> {
  const result = await queryable.query<Row>(
    `SELECT key_id AS "keyId", retirement_id AS "retirementId",
            request_id AS "requestId", mutation_id AS "mutationId",
            catalog_digest AS "catalogDigest",
            material_proof AS "materialProof",
            prepared_at_ms AS "preparedAtMs",
            preparation_digest AS "preparationDigest",
            preparation_json AS "preparationJson"
       FROM "ql3_ai"."model_invocation_prompt_output_key_retirement_preparations"
      WHERE key_id = $1
      LIMIT 2`,
    [keyId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parsePreparation(result.rows[0]) : null;
}

async function readCompletion(
  queryable: Queryable,
  keyId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRetirementCompletion> | null> {
  const result = await queryable.query<Row>(
    `SELECT key_id AS "keyId", retirement_id AS "retirementId",
            request_id AS "requestId", mutation_id AS "mutationId",
            preparation_digest AS "preparationDigest",
            retired_catalog_digest AS "retiredCatalogDigest",
            absence_proof AS "absenceProof",
            completed_at_ms AS "completedAtMs",
            completion_digest AS "completionDigest",
            completion_json AS "completionJson"
       FROM "ql3_ai"."model_invocation_prompt_output_key_retirement_completions"
      WHERE key_id = $1
      LIMIT 2`,
    [keyId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parseCompletion(result.rows[0]) : null;
}

async function readRecord(
  queryable: Queryable,
  keyId: string,
): Promise<Readonly<PluginPackagePromptOutputKeyRetirementRecord> | null> {
  const preparation = await readPreparation(queryable, keyId);
  const completion = await readCompletion(queryable, keyId);
  if (!preparation) {
    if (completion) throw unavailable();
    return null;
  }
  if (
    completion &&
    (completion.preparationDigest !== preparation.preparationDigest ||
      completion.retirementId !== preparation.retirementId ||
      completion.requestId !== preparation.requestId ||
      completion.mutationId !== preparation.mutationId)
  ) {
    throw unavailable();
  }
  return Object.freeze({ preparation, completion });
}

async function liveArtifactCount(
  queryable: Queryable,
  keyId: string,
): Promise<number> {
  const result = await queryable.query<Row>(
    `SELECT count(*)::text AS count
       FROM "ql3_ai"."model_invocation_prompt_output_artifacts"
      WHERE key_id = $1`,
    [keyId],
  );
  if (result.rows.length !== 1) throw unavailable();
  return integer(result.rows[0]!, 'count');
}

function samePreparationIntent(
  preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>,
  command: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
    catalogDigest: string;
    materialProof: string;
  }>,
): boolean {
  return (
    preparation.keyId === command.keyId &&
    preparation.retirementId === command.retirementId &&
    preparation.requestId === command.requestId &&
    preparation.mutationId === command.mutationId &&
    preparation.catalogDigest === command.catalogDigest &&
    preparation.materialProof === command.materialProof
  );
}

function normalizedKeyId(keyId: string): string {
  return normalizePluginPackagePromptOutputKeyRetirementRequest({
    keyId,
    retirementId: 'key-fence-probe',
    requestId: 'key-fence-probe',
    mutationId: 'key-fence-probe',
  }).keyId;
}

export async function lockPostgresPluginPackagePromptOutputKeyFence(
  client: PostgresClient,
  keyId: string,
): Promise<string> {
  const normalized = normalizedKeyId(keyId);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, [
    `ql3-ai:prompt-output-key:${normalized}`,
    KEY_FENCE_LOCK_SEED,
  ]);
  return normalized;
}

export async function assertPostgresPluginPackagePromptOutputKeyNotRetiring(
  client: PostgresClient,
  keyId: string,
): Promise<void> {
  const normalized = await lockPostgresPluginPackagePromptOutputKeyFence(
    client,
    keyId,
  );
  if (await readPreparation(client, normalized)) {
    throw new PluginPackagePromptOutputKeyRetirementConflictError();
  }
}

export class PostgresPluginPackagePromptOutputKeyRetirementRepository
  implements PluginPackagePromptOutputKeyRetirementRepository
{
  readonly #pool: PostgresPool;
  readonly #now: () => number;

  constructor(options: Readonly<{ pool: PostgresPool; now?: () => number }>) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.pool ||
      typeof options.pool.query !== 'function' ||
      typeof options.pool.connect !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw unavailable();
    }
    this.#pool = options.pool;
    this.#now = options.now ?? Date.now;
  }

  async find(
    keyId: string,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRetirementRecord> | null> {
    try {
      return await readRecord(this.#pool, normalizedKeyId(keyId));
    } catch (cause) {
      throw cause instanceof
        PluginPackagePromptOutputKeyRetirementUnavailableError
        ? cause
        : unavailable(cause);
    }
  }

  async prepare(
    command: Readonly<{
      keyId: string;
      retirementId: string;
      requestId: string;
      mutationId: string;
      catalogDigest: string;
      materialProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>
  > {
    const request = normalizePluginPackagePromptOutputKeyRetirementRequest({
      keyId: command.keyId,
      retirementId: command.retirementId,
      requestId: command.requestId,
      mutationId: command.mutationId,
    });
    const preparation = createPluginPackagePromptOutputKeyRetirementPreparation(
      {
        ...request,
        catalogDigest: command.catalogDigest,
        materialProof: command.materialProof,
        preparedAtMs: this.#now(),
      },
    );
    return this.#transaction(async (client) => {
      await lockPostgresPluginPackagePromptOutputKeyFence(
        client,
        request.keyId,
      );
      const existing = await readRecord(client, request.keyId);
      if (existing) {
        if (!samePreparationIntent(existing.preparation, preparation)) {
          throw new PluginPackagePromptOutputKeyRetirementConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          preparation: existing.preparation,
        });
      }
      if ((await liveArtifactCount(client, request.keyId)) !== 0) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      await client.query(
        `INSERT INTO "ql3_ai"."model_invocation_prompt_output_key_retirement_preparations" (
           key_id, retirement_id, request_id, mutation_id,
           catalog_digest, material_proof, prepared_at_ms,
           preparation_digest, preparation_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          preparation.keyId,
          preparation.retirementId,
          preparation.requestId,
          preparation.mutationId,
          preparation.catalogDigest,
          preparation.materialProof,
          preparation.preparedAtMs,
          preparation.preparationDigest,
          JSON.stringify(preparation),
        ],
      );
      return Object.freeze({
        status: 'created' as const,
        preparation,
      });
    });
  }

  async complete(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
      retiredCatalogDigest: string;
      absenceProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      completion: Readonly<PluginPackagePromptOutputKeyRetirementCompletion>;
    }>
  > {
    const preparation =
      normalizePluginPackagePromptOutputKeyRetirementPreparation(
        command.preparation,
      );
    const completion = createPluginPackagePromptOutputKeyRetirementCompletion({
      preparation,
      retiredCatalogDigest: command.retiredCatalogDigest,
      absenceProof: command.absenceProof,
      completedAtMs: this.#now(),
    });
    return this.#transaction(async (client) => {
      await lockPostgresPluginPackagePromptOutputKeyFence(
        client,
        preparation.keyId,
      );
      const durable = await readRecord(client, preparation.keyId);
      if (
        !durable ||
        JSON.stringify(durable.preparation) !== JSON.stringify(preparation)
      ) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      if (durable.completion) {
        if (
          durable.completion.preparationDigest !==
            preparation.preparationDigest ||
          durable.completion.retiredCatalogDigest !==
            completion.retiredCatalogDigest ||
          durable.completion.absenceProof !== completion.absenceProof
        ) {
          throw new PluginPackagePromptOutputKeyRetirementConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          completion: durable.completion,
        });
      }
      if ((await liveArtifactCount(client, preparation.keyId)) !== 0) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      await client.query(
        `INSERT INTO "ql3_ai"."model_invocation_prompt_output_key_retirement_completions" (
           key_id, retirement_id, request_id, mutation_id,
           preparation_digest, retired_catalog_digest, absence_proof,
           completed_at_ms, completion_digest, completion_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          completion.keyId,
          completion.retirementId,
          completion.requestId,
          completion.mutationId,
          completion.preparationDigest,
          completion.retiredCatalogDigest,
          completion.absenceProof,
          completion.completedAtMs,
          completion.completionDigest,
          JSON.stringify(completion),
        ],
      );
      return Object.freeze({
        status: 'created' as const,
        completion,
      });
    });
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw unavailable(cause);
        }
        const state = sqlState(cause);
        if (
          state &&
          RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < MAX_ATTEMPTS
        ) {
          continue;
        }
        if (state && CONFLICT_SQL_STATES.has(state)) {
          throw new PluginPackagePromptOutputKeyRetirementConflictError();
        }
        if (
          cause instanceof
            PluginPackagePromptOutputKeyRetirementConflictError ||
          cause instanceof
            PluginPackagePromptOutputKeyRetirementUnavailableError
        ) {
          throw cause;
        }
        throw unavailable(cause);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
